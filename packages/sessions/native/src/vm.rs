//! The VM of a session object's attempt: shared-core's [`CoreExplicitRecoveryVM`],
//! which never replays a journal.
//!
//! Every attempt runs the handler from the start, and recovers from the state
//! the earlier attempts stored. An action returns a handle, and its result
//! comes back as a notification of that handle ([`Vm::take_notification`]):
//! `src/driver.ts` settles its promises with them. There is no `do_progress`,
//! so a handler awaits what it likes, with its own combinators, and nothing
//! has to fake a single await point (see the selector this replaces).
//!
//! The database's store awaits its own handles here, in Rust
//! ([`Vm::issue_and_wait`]): its reads, its acked writes and its listing of the
//! keys never reach JavaScript. Every other notification is queued for it.
//!
//! Issuing a command and registering the waiter for its handle are one
//! critical section. They have to be: a notification that is ready at once —
//! an eager read, a write that asks for no ack — would otherwise be routed to
//! JavaScript by a tick in between, and the waiter would hang forever.
//! sdk-python needs no such care, because the GIL does not let its tick run
//! between the two.
//!
//! The VM is [`Send`] but not `Sync`, and it lives behind a [`Mutex`], since
//! two threads reach it: JavaScript's, which ticks it, and the runtime's,
//! where a database call that waits for the store goes on (see
//! `node::answer`). A call from the runtime's thread then asks JavaScript to
//! tick, through [`Vm::set_scheduler`], so that what it wrote is flushed and
//! what it waits for can be answered.
use bytes::Bytes;
use futures::channel::oneshot;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use restate_sdk_shared_core::explicit_recovery::{
    AttemptState, CoreExplicitRecoveryVM, ExplicitRecoveryVM, Notification, TraceId,
    request_response_unsupported,
};
use restate_sdk_shared_core::{
    AttachInvocationTarget, Error, Header, NonEmptyValue, NotificationHandle, Target,
    TerminalFailure, Value,
};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// A header of the request, or of a call: `{ key, value }`.
#[napi(object)]
pub struct VmHeader {
    pub key: String,
    pub value: String,
}

impl From<&Header> for VmHeader {
    fn from(header: &Header) -> Self {
        VmHeader {
            key: header.key.to_string(),
            value: header.value.to_string(),
        }
    }
}

impl From<VmHeader> for Header {
    fn from(header: VmHeader) -> Self {
        Header {
            key: header.key.into(),
            value: header.value.into(),
        }
    }
}

/// A terminal failure: what a handler throws, and what a failed action completes with.
#[napi(object)]
pub struct VmFailure {
    pub code: u32,
    pub message: String,
    pub metadata: Vec<VmHeader>,
}

impl From<TerminalFailure> for VmFailure {
    fn from(failure: TerminalFailure) -> Self {
        VmFailure {
            code: failure.code as u32,
            message: failure.message,
            metadata: failure
                .metadata
                .into_iter()
                .map(|(key, value)| VmHeader { key, value })
                .collect(),
        }
    }
}

impl From<VmFailure> for TerminalFailure {
    fn from(failure: VmFailure) -> Self {
        TerminalFailure {
            code: failure.code as u16,
            message: failure.message,
            metadata: failure
                .metadata
                .into_iter()
                .map(|header| (header.key, header.value))
                .collect(),
        }
    }
}

/// The response's head: the status and headers to write before the body.
#[napi(object)]
pub struct VmResponseHead {
    pub status_code: u32,
    pub headers: Vec<VmHeader>,
}

/// The invocation's input, once the VM is ready to execute.
#[napi(object)]
pub struct VmInput {
    pub invocation_id: String,
    pub key: String,
    pub headers: Vec<VmHeader>,
    pub input: Buffer,
    pub scope: Option<String>,
    pub limit_key: Option<String>,
    pub idempotency_key: Option<String>,
}

/// The handles of a call: its invocation id, and its result.
#[napi(object)]
pub struct VmCallHandle {
    pub invocation_id: u32,
    pub result: u32,
}

/// A ready result, as JavaScript gets it. `kind` says which field holds it:
/// `void` none, `success` `bytes`, `failure` `failure`, `stateKeys` `keys`,
/// and `invocationId` `id`.
#[napi(object)]
pub struct VmNotification {
    pub handle: u32,
    pub kind: String,
    pub bytes: Option<Buffer>,
    pub failure: Option<VmFailure>,
    pub keys: Option<Vec<String>>,
    pub id: Option<String>,
}

fn notification_to_js(handle: u32, value: Value) -> VmNotification {
    let mut js = VmNotification {
        handle,
        kind: String::new(),
        bytes: None,
        failure: None,
        keys: None,
        id: None,
    };
    match value {
        Value::Void => js.kind = "void".to_owned(),
        Value::Success(bytes) => {
            js.kind = "success".to_owned();
            js.bytes = Some(bytes.to_vec().into());
        }
        Value::Failure(failure) => {
            js.kind = "failure".to_owned();
            js.failure = Some(failure.into());
        }
        Value::StateKeys(keys) => {
            js.kind = "stateKeys".to_owned();
            js.keys = Some(keys);
        }
        Value::InvocationId(id) => {
            js.kind = "invocationId".to_owned();
            js.id = Some(id);
        }
    }
    js
}

/// What JavaScript is asked to do after Rust touches the VM: one tick.
pub(crate) type Scheduler = ThreadsafeFunction<(), (), (), Status, false, true>;

/// Where Rust waits for the notification of a handle (the database's store).
pub(crate) type RustWaiter = oneshot::Sender<std::result::Result<Value, Error>>;

/// The VM, the handles Rust waits for, and the notifications queued for JavaScript.
pub(crate) struct VmInner {
    pub(crate) vm: CoreExplicitRecoveryVM,
    rust_waiters: HashMap<NotificationHandle, RustWaiter>,
    /// Handles whose notification nothing waits for: the database's writes
    /// that asked for no ack, which the VM answers at once. Queueing them for
    /// JavaScript would cost a call across the addon and an object for each,
    /// only to drop them.
    discarded: HashSet<NotificationHandle>,
    for_js: VecDeque<Notification>,
    scheduler: Option<Arc<Scheduler>>,
    /// Whether a tick is already asked for: one is enough until it runs, and
    /// a commit's writes would otherwise each wake JavaScript's thread.
    asked_to_tick: bool,
}

impl VmInner {
    /// Take every notification the VM has ready, handing Rust's to their
    /// waiters and queueing the rest for JavaScript. Once the attempt is
    /// closed with an error, every waiter gets it.
    fn route(&mut self) -> std::result::Result<(), Error> {
        loop {
            match self.vm.take_next_notification() {
                Ok(Some(notification)) => match self.rust_waiters.remove(&notification.handle) {
                    Some(waiter) => {
                        let _ = waiter.send(Ok(notification.value));
                    }
                    None => {
                        if !self.discarded.remove(&notification.handle) {
                            self.for_js.push_back(notification);
                        }
                    }
                },
                Ok(None) => return Ok(()),
                Err(error) => {
                    for (_, waiter) in self.rust_waiters.drain() {
                        let _ = waiter.send(Err(error.clone()));
                    }
                    return Err(error);
                }
            }
        }
    }
}

/// Restate's signature on a request, as the SDK verifies it before dispatch.
///
/// This package runs a session object's invocation ahead of that handler, so
/// it verifies the signature itself: a deployment with identity keys, which
/// every `connect` has, would otherwise go unchecked (`src/endpoint.ts`).
#[napi]
pub struct Identity(restate_sdk_shared_core::IdentityVerifier);

#[napi]
impl Identity {
    /// The v1 public keys a deployment accepts (`publickeyv1_…`).
    #[napi(constructor)]
    pub fn new(keys: Vec<String>) -> Result<Self> {
        let borrowed: Vec<&str> = keys.iter().map(String::as_str).collect();
        restate_sdk_shared_core::IdentityVerifier::new(&borrowed)
            .map(Self)
            .map_err(|error| Error_::new(Status::InvalidArg, error.to_string()))
    }

    /// Nothing if `headers` carry a signature of `path` by one of the keys,
    /// and why not otherwise.
    #[napi]
    pub fn verify(&self, path: String, headers: Vec<VmHeader>) -> Option<String> {
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|header| (header.key, header.value))
            .collect();
        self.0
            .verify_identity(&headers, &path)
            .err()
            .map(|error| error.to_string())
    }
}

/// The attempt's state machine, shared by JavaScript and the database's store.
#[napi]
pub struct Vm(pub(crate) Arc<Mutex<VmInner>>);

/// What the database's store's pending reads and acks fail with when the
/// attempt is over: Restate shut it down, or it failed. It crosses the addon
/// as the text of an error, so `src/database.ts` matches it to give the
/// handler the error of an attempt's end.
pub(crate) const ATTEMPT_OVER: &str = "restate-sessions: the attempt is over";

/// A VM error as JavaScript gets it. The attempt's shutdown carries the code
/// `ATTEMPT_SHUT_DOWN`, which the driver tells apart from a failure.
fn vm_error(error: Error) -> Error_ {
    if error.is_suspended_error() {
        Error_::new(
            Status::GenericFailure,
            format!("ATTEMPT_SHUT_DOWN: {error}"),
        )
    } else {
        Error_::new(Status::GenericFailure, error.to_string())
    }
}

/// napi's error type, named so that shared-core's `Error` keeps its name here.
type Error_ = napi::Error;

fn target(
    service: String,
    handler: String,
    key: Option<String>,
    idempotency_key: Option<String>,
    headers: Option<Vec<VmHeader>>,
) -> Target {
    Target {
        service,
        handler,
        key,
        idempotency_key,
        scope: None,
        limit_key: None,
        headers: headers
            .unwrap_or_default()
            .into_iter()
            .map(Into::into)
            .collect(),
    }
}

/// The lock of a VM: taken briefly, never held across an await.
pub(crate) fn lock(inner: &Arc<Mutex<VmInner>>) -> MutexGuard<'_, VmInner> {
    inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Vm {
    fn lock(&self) -> MutexGuard<'_, VmInner> {
        lock(&self.0)
    }

    /// The VM the database's store acts on.
    pub(crate) fn inner(&self) -> Arc<Mutex<VmInner>> {
        self.0.clone()
    }

    /// Ask JavaScript to tick, so that what Rust just sent is written and what
    /// it waits for can be answered. Called with the lock released, and only
    /// when no tick is pending: a commit's writes would otherwise wake the
    /// other thread once each, to do the one piece of work.
    fn schedule(scheduler: Option<Arc<Scheduler>>) {
        if let Some(scheduler) = scheduler {
            scheduler.call((), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }

    /// The scheduler to call, if a tick is not already asked for.
    fn wanted(vm: &mut VmInner) -> Option<Arc<Scheduler>> {
        if vm.asked_to_tick {
            return None;
        }
        vm.asked_to_tick = true;
        vm.scheduler.clone()
    }

    /// Issue a command with `act` and register the waiter of its handle, in one
    /// critical section, then ask JavaScript to tick.
    ///
    /// The two cannot be separate calls: a notification that is ready the
    /// moment the command is issued — an eager state read, a write that asks
    /// for no ack — would be routed to JavaScript by a tick in between, and
    /// this waiter would wait for a notification that already went elsewhere.
    pub(crate) fn issue_and_wait(
        inner: &Arc<Mutex<VmInner>>,
        act: impl FnOnce(&mut CoreExplicitRecoveryVM) -> std::result::Result<NotificationHandle, Error>,
    ) -> std::result::Result<oneshot::Receiver<std::result::Result<Value, Error>>, Error> {
        let (result, scheduler) = {
            let mut vm = lock(inner);
            let result = act(&mut vm.vm).map(|handle| {
                let (sender, receiver) = oneshot::channel();
                vm.rust_waiters.insert(handle, sender);
                // Still under the lock: a result the VM already has — a
                // state value the invocation knows, or that this attempt
                // wrote — reaches the waiter here, instead of waiting for
                // a tick to route it and so taking a turn of JavaScript's
                // event loop to answer a read that needed nothing.
                let _ = vm.route();
                receiver
            });
            let scheduler = vm.scheduler.clone();
            (result, scheduler)
        };
        Self::schedule(scheduler);
        result
    }

    /// Fail every read and ack the database's store is waiting for: the
    /// attempt is over, and nothing will answer them.
    ///
    /// Only the attempt's end does this. A cancellation does not: a wait of
    /// the store's is a state read or the ack of a commit's head write, which
    /// Restate answers promptly, and failing the ack of a head that is already
    /// out reports a commit as cancelled that landed. The driver delivers a
    /// cancellation where the handler calls, before anything is issued
    /// (`session.ts`).
    fn fail_waiters(inner: &Arc<Mutex<VmInner>>) {
        let mut vm = lock(inner);
        for (_, waiter) in vm.rust_waiters.drain() {
            let _ = waiter.send(Err(Error::new(
                restate_sdk_shared_core::error::codes::INTERNAL,
                ATTEMPT_OVER.to_owned(),
            )));
        }
    }

    /// Issue a command whose notification nothing waits for, and drop it when
    /// it comes: the database's writes that ask for no ack, which the VM
    /// answers at once. Queueing them for JavaScript would cost a call across
    /// the addon and an object for each, only to drop them there.
    pub(crate) fn issue_and_discard(
        inner: &Arc<Mutex<VmInner>>,
        act: impl FnOnce(&mut CoreExplicitRecoveryVM) -> std::result::Result<NotificationHandle, Error>,
    ) -> std::result::Result<(), Error> {
        let (result, scheduler) = {
            let mut vm = lock(inner);
            let result = act(&mut vm.vm).map(|handle| {
                vm.discarded.insert(handle);
                let _ = vm.route();
            });
            let scheduler = Self::wanted(&mut vm);
            (result, scheduler)
        };
        Self::schedule(scheduler);
        result
    }
}

#[napi]
impl Vm {
    /// Without a bidirectional stream (a request/response transport, e.g. AWS
    /// Lambda), the VM fails the invocation at once, pausing it: no response
    /// could reach the handler.
    #[napi(
        constructor,
        ts_args_type = "headers: VmHeader[], bidirectional: boolean"
    )]
    pub fn new(headers: Vec<VmHeader>, bidirectional: bool) -> Result<Self> {
        let headers: Vec<(String, String)> = headers
            .into_iter()
            .map(|header| (header.key, header.value))
            .collect();
        let mut vm = CoreExplicitRecoveryVM::new(headers).map_err(vm_error)?;
        if !bidirectional {
            vm.notify_error(request_response_unsupported());
        }
        Ok(Vm(Arc::new(Mutex::new(VmInner {
            vm,
            rust_waiters: Default::default(),
            discarded: Default::default(),
            for_js: Default::default(),
            scheduler: None,
            asked_to_tick: false,
        }))))
    }

    /// What the VM calls, on JavaScript's thread, after Rust acts on it: the
    /// driver's tick, which writes the output and settles what completed.
    #[napi(ts_args_type = "scheduler: () => void")]
    pub fn set_scheduler(&self, scheduler: Function<'_, (), ()>) -> Result<()> {
        let scheduler = scheduler
            .build_threadsafe_function()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?;
        self.lock().scheduler = Some(Arc::new(scheduler));
        Ok(())
    }

    #[napi]
    pub fn get_response_head(&self) -> VmResponseHead {
        let head = self.lock().vm.get_response_head();
        VmResponseHead {
            status_code: head.status_code as u32,
            headers: head.headers.iter().map(Into::into).collect(),
        }
    }

    // --- Input and output

    #[napi]
    pub fn notify_input(&self, buffer: Uint8Array) {
        self.lock().vm.notify_input(Bytes::copy_from_slice(&buffer));
    }

    /// The runtime closed the input stream. While the handler runs, this shuts the attempt down.
    #[napi]
    pub fn notify_input_closed(&self) {
        self.lock().vm.notify_input_closed();
    }

    /// The bytes buffered so far for the response body. Every tick starts
    /// here, so the tick Rust asked for is now running: the next act asks anew.
    #[napi]
    pub fn take_output(&self) -> Buffer {
        let mut vm = self.lock();
        vm.asked_to_tick = false;
        vm.vm.take_output().to_vec().into()
    }

    #[napi]
    pub fn is_ready_to_execute(&self) -> Result<bool> {
        self.lock().vm.is_ready_to_execute().map_err(vm_error)
    }

    #[napi]
    pub fn input(&self) -> Result<VmInput> {
        let input = self.lock().vm.get_input().map_err(vm_error)?;
        Ok(VmInput {
            invocation_id: input.invocation_id,
            key: input.key,
            headers: input.headers.iter().map(Into::into).collect(),
            input: input.input.to_vec().into(),
            scope: input.scope,
            limit_key: input.limit_key,
            idempotency_key: input.idempotency_key,
        })
    }

    /// The next notification for JavaScript, or `null`. Throws once the
    /// attempt is closed: `ATTEMPT_SHUT_DOWN` for a shutdown, else a failure.
    #[napi]
    pub fn take_notification(&self) -> Result<Option<VmNotification>> {
        let mut vm = self.lock();
        vm.route().map_err(vm_error)?;
        Ok(vm
            .for_js
            .pop_front()
            .map(|Notification { handle, value }| notification_to_js(handle.into(), value)))
    }

    // --- Request/response actions

    #[napi]
    pub fn get_state(&self, key: String, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_get(key, name)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn get_state_keys(&self, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_get_keys(name)
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn call(
        &self,
        service: String,
        handler: String,
        buffer: Uint8Array,
        key: Option<String>,
        idempotency_key: Option<String>,
        headers: Option<Vec<VmHeader>>,
        name: Option<String>,
    ) -> Result<VmCallHandle> {
        self.lock()
            .vm
            .cmd_call(
                target(service, handler, key, idempotency_key, headers),
                Bytes::copy_from_slice(&buffer),
                name,
            )
            .map(|handle| VmCallHandle {
                invocation_id: handle.invocation_id_notification_handle.into(),
                result: handle.call_notification_handle.into(),
            })
            .map_err(vm_error)
    }

    /// Returns the handle of the invocation id. `delay` is in milliseconds.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        service: String,
        handler: String,
        buffer: Uint8Array,
        key: Option<String>,
        delay: Option<i64>,
        idempotency_key: Option<String>,
        headers: Option<Vec<VmHeader>>,
        name: Option<String>,
    ) -> Result<u32> {
        let execute_at = delay.map(|millis| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("duration since the unix epoch cannot fail")
                + Duration::from_millis(millis.max(0) as u64)
        });
        self.lock()
            .vm
            .cmd_send(
                target(service, handler, key, idempotency_key, headers),
                Bytes::copy_from_slice(&buffer),
                execute_at,
                name,
            )
            .map(|handle| handle.invocation_id_notification_handle.into())
            .map_err(vm_error)
    }

    #[napi]
    pub fn attach_invocation(&self, invocation_id: String, name: Option<String>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_attach_invocation(AttachInvocationTarget::InvocationId(invocation_id), name)
            .map(u32::from)
            .map_err(vm_error)
    }

    // --- Fire-and-forget actions
    //
    // With `ack`, Restate answers once the command is stored, and the handle
    // is notified then; without, it is notified at once.

    #[napi]
    pub fn set_state(
        &self,
        key: String,
        buffer: Uint8Array,
        name: Option<String>,
        ack: Option<bool>,
    ) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_set(
                key,
                Bytes::copy_from_slice(&buffer),
                name,
                ack.unwrap_or(false),
            )
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_state(&self, key: String, name: Option<String>, ack: Option<bool>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_clear(key, name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn clear_all_state(&self, name: Option<String>, ack: Option<bool>) -> Result<u32> {
        self.lock()
            .vm
            .cmd_state_clear_all(name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn cancel_invocation(
        &self,
        invocation_id: String,
        name: Option<String>,
        ack: Option<bool>,
    ) -> Result<u32> {
        self.lock()
            .vm
            .cmd_cancel_invocation(invocation_id, name, ack.unwrap_or(false))
            .map(u32::from)
            .map_err(vm_error)
    }

    // --- Tracing
    //
    // A trace is shown in Restate's UI as a run, until it is ended; one the
    // attempt leaves open is ended by `end`, or by the next attempt.

    /// Inside the trace `parent` of this attempt, or else inside the attempt itself.
    #[napi]
    pub fn start_trace(&self, name: String, parent: Option<u32>) -> Result<u32> {
        self.lock()
            .vm
            .trace_start(name, parent.map(TraceId::from))
            .map(u32::from)
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_trace_success(&self, trace: u32, buffer: Uint8Array) -> Result<()> {
        self.lock()
            .vm
            .trace_end(
                TraceId::from(trace),
                NonEmptyValue::Success(Bytes::copy_from_slice(&buffer)),
            )
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_trace_failure(&self, trace: u32, failure: VmFailure) -> Result<()> {
        self.lock()
            .vm
            .trace_end(TraceId::from(trace), NonEmptyValue::Failure(failure.into()))
            .map_err(vm_error)
    }

    // --- Control

    /// Tells Restate the attempt makes progress, delaying its shutdown.
    #[napi]
    pub fn heartbeat(&self) -> Result<()> {
        self.lock().vm.heartbeat().map_err(vm_error)
    }

    /// Whether the invocation was cancelled, in this attempt or an earlier one.
    #[napi]
    pub fn is_cancelled(&self) -> bool {
        self.lock().vm.is_cancelled()
    }

    /// Fail what the database's store waits for: the attempt is over, and
    /// nothing more will answer.
    #[napi]
    pub fn end_state_waits(&self) {
        Self::fail_waiters(&self.0);
    }

    /// Let go of the scheduler, which holds JavaScript's tick, and so the
    /// driver and this VM: an attempt that kept it would never be freed.
    #[napi]
    pub fn clear_scheduler(&self) {
        self.lock().scheduler = None;
    }

    /// `"starting"`, `"running"` or `"closed"`.
    #[napi]
    pub fn state(&self) -> String {
        match self.lock().vm.state() {
            AttemptState::Starting => "starting",
            AttemptState::Running => "running",
            AttemptState::Closed => "closed",
        }
        .to_owned()
    }

    // --- End

    #[napi]
    pub fn end_success(&self, buffer: Uint8Array) -> Result<()> {
        self.lock()
            .vm
            .end(NonEmptyValue::Success(Bytes::copy_from_slice(&buffer)))
            .map_err(vm_error)
    }

    #[napi]
    pub fn end_failure(&self, failure: VmFailure) -> Result<()> {
        self.lock()
            .vm
            .end(NonEmptyValue::Failure(failure.into()))
            .map_err(vm_error)
    }

    /// Fails the attempt, for example with a retryable error of the handler.
    #[napi]
    pub fn notify_error(
        &self,
        message: String,
        stacktrace: Option<String>,
        delay_override_ms: Option<i64>,
    ) {
        let mut error = Error::new(restate_sdk_shared_core::error::codes::INTERNAL, message);
        if let Some(stacktrace) = stacktrace {
            error = error.with_stacktrace(stacktrace);
        }
        if let Some(delay) = delay_override_ms {
            error =
                error.with_next_retry_delay_override(Duration::from_millis(delay.max(0) as u64));
        }
        self.lock().vm.notify_error(error);
    }
}
