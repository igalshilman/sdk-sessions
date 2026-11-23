//! Node.js bindings: SQL over a key/value store implemented in JavaScript.
//!
//! `open` takes the store, an object `{ get, set, clear, sync, keys? }`
//! (`Store` in `src/database.ts`). Every request goes to it through one
//! queue, in the order it was issued, so a read sees the writes before it:
//! Rust reaches JavaScript only through a thread-safe function, and each such
//! function is a queue of its own, with no order across them. So there is
//! one, [`dispatcher`], which calls the store's method a request names.
//!
//! `set` and `clear` queue a write; `sync` resolves once every write before it
//! is stored. The object's state keeps writes in issue order, so a crash
//! loses only a suffix of them (see [`KvStore`]): a statement that commits
//! queues its writes, then resolves at one `sync`. With `keys`, a checkpoint
//! deletes the packs no checkpoint needs; a store without keeps its garbage.
//!
//! Every database of the process is kept warm in one page cache
//! ([`page_cache`]), and keeps the checkpoints it outgrows Restate with in
//! the object store `RESTATE_SQL_OBJECT_STORE` names, if any
//! ([`object_store`]), past the share `RESTATE_SQL_L0_BYTES` leaves Restate
//! ([`state_options`]); a session itself, and its commits, is a
//! [`sql::Database`].
//!
//! A call runs on the JavaScript thread as far as it can ([`answer`]): one
//! that needs nothing from the store, such as SQL on cached pages or a
//! statement inside a transaction, returns its value, or throws its error;
//! one that waits for the store goes on in the runtime as one task that
//! settles the promise it returns. The caller `await`s either.
use crate::call::answer;
use crate::vm::{Vm, VmInner};
use bytes::Bytes;
use futures::future::BoxFuture;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsValue, sys};
use napi_derive::napi;
use restate_sdk_shared_core::explicit_recovery::ExplicitRecoveryVM;
use restate_sdk_shared_core::sql::{self, Numeric, Value};
use restate_sdk_shared_core::state::{
    self, KvStore, ObjectStoreL1, PageCache, PageCacheConfig, StateOptions,
};
use restate_sdk_shared_core::{NotificationHandle, Value as VmValue};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// What a request to the store does: the store's method it calls.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Get = 0,
    Set = 1,
    Clear = 2,
    Sync = 3,
    Keys = 4,
}

impl Op {
    fn from_code(code: u32) -> Option<Op> {
        [Op::Get, Op::Set, Op::Clear, Op::Sync, Op::Keys]
            .into_iter()
            .find(|op| *op as u32 == code)
    }

    fn method(self) -> &'static str {
        match self {
            Op::Get => "get",
            Op::Set => "set",
            Op::Clear => "clear",
            Op::Sync => "sync",
            Op::Keys => "keys",
        }
    }
}

/// A request, as the dispatcher's arguments: `(op, key, value)`.
type Args = FnArgs<(u32, String, Option<Buffer>)>;
/// What a request answers: a `get`'s value, the store's keys, or nothing.
type Reply = Option<Either<Uint8Array, Vec<String>>>;
type Dispatch = ThreadsafeFunction<Args, Promise<Reply>, Args, Status, false, true>;

/// The queue that every request to `store` goes through: one function, run
/// on the JavaScript thread, that calls the store's method for the request,
/// with the store as `this`; a method that answers may answer a value or a
/// promise of it. A failed write cannot fail its caller, which has moved on:
/// the next `sync`, and every one after it, rejects with its error.
fn dispatcher(env: &Env, store: Object) -> Result<Dispatch> {
    let failure = RefCell::new(None::<Error>);
    let dispatch = env.create_function_from_closure::<Args, _, _>("dispatch", move |ctx| {
        let store: Object = ctx.this()?;
        let code: u32 = ctx.get(0)?;
        let op = Op::from_code(code)
            .ok_or_else(|| Error::from_reason(format!("unknown store operation {code}")))?;
        let arg = |index: usize| ctx.get::<Unknown>(index).map(|value| value.raw());
        let args = match op {
            Op::Set => vec![arg(1)?, arg(2)?],
            Op::Get | Op::Clear => vec![arg(1)?],
            Op::Sync | Op::Keys => vec![],
        };
        if op == Op::Sync
            && let Some(error) = &*failure.borrow()
        {
            return Err(error.try_clone()?);
        }
        let result = call(&store, op.method(), &args);
        if op == Op::Set || op == Op::Clear {
            if let Err(error) = result {
                failure.borrow_mut().get_or_insert(error);
            }
            return unsafe { <()>::to_napi_value(ctx.env.raw(), ()) };
        }
        // `Promise`, a function, as the object `resolve` is called on.
        let promise: Object = ctx
            .env
            .get_global()?
            .get_named_property_unchecked("Promise")?;
        call(&promise, "resolve", &[result?])
    })?;
    // Typed as the queue calls it: each method it awaits answers a promise.
    let dispatch =
        unsafe { Function::<Args, Promise<Reply>>::from_napi_value(env.raw(), dispatch.raw()) }?;
    dispatch
        .bind(store)?
        .build_threadsafe_function()
        .callee_handled::<false>()
        .weak::<true>()
        .build()
}

/// `object[name](...args)`, with the object as `this`; a throw is its error.
fn call(object: &Object, name: &str, args: &[sys::napi_value]) -> Result<sys::napi_value> {
    let method: Unknown = object.get_named_property(name)?;
    let env = object.value().env;
    let mut result = std::ptr::null_mut();
    napi::check_pending_exception!(env, unsafe {
        sys::napi_call_function(
            env,
            object.raw(),
            method.raw(),
            args.len(),
            args.as_ptr(),
            &mut result,
        )
    })?;
    Ok(result)
}

/// The JavaScript store's queue.
struct JsQueue {
    dispatch: Dispatch,
    /// Whether the store has `keys`.
    lists_keys: bool,
}

fn io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

impl JsQueue {
    /// A request that answers: a read, a sync, or the keys.
    async fn request(&self, op: Op, key: &str) -> io::Result<Reply> {
        let promise = self
            .dispatch
            .call_async_catch((op as u32, key.to_owned(), None).into())
            .await
            .map_err(io_error)?;
        promise.await.map_err(io_error)
    }

    /// Queue a write: a `set`, or a `clear` when `value` is `None`.
    fn queue(&self, key: &str, value: Option<Bytes>) -> io::Result<()> {
        let (op, value) = match value {
            Some(value) => (Op::Set, Some(Buffer::from(value.to_vec()))),
            None => (Op::Clear, None),
        };
        match self.dispatch.call(
            (op as u32, key.to_owned(), value).into(),
            ThreadsafeFunctionCallMode::NonBlocking,
        ) {
            Status::Ok => Ok(()),
            status => Err(io_error(format!("store call failed: {status}"))),
        }
    }
}

fn unexpected(op: Op) -> io::Error {
    io_error(format!(
        "the store's {} answered with the wrong type",
        op.method()
    ))
}

impl KvStore for JsQueue {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, io::Result<Option<Bytes>>> {
        Box::pin(async move {
            match self.request(Op::Get, key).await? {
                None => Ok(None),
                Some(Either::A(value)) => Ok(Some(Bytes::copy_from_slice(&value))),
                Some(Either::B(_)) => Err(unexpected(Op::Get)),
            }
        })
    }

    fn put(&self, key: &str, value: Bytes) -> io::Result<()> {
        self.queue(key, Some(value))
    }

    fn delete(&self, key: &str) -> io::Result<()> {
        self.queue(key, None)
    }

    fn sync(&self) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async { self.request(Op::Sync, "").await.map(drop) })
    }

    fn keys(&self) -> BoxFuture<'_, io::Result<Vec<String>>> {
        Box::pin(async move {
            if !self.lists_keys {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "the store has no keys",
                ));
            }
            match self.request(Op::Keys, "").await? {
                Some(Either::B(keys)) => Ok(keys),
                _ => Err(unexpected(Op::Keys)),
            }
        })
    }
}

/// The VM a store's command acts on, and what issuing one answers.
type CoreVm = restate_sdk_shared_core::explicit_recovery::CoreExplicitRecoveryVM;
type VmResult = std::result::Result<NotificationHandle, restate_sdk_shared_core::Error>;
/// The ack of a write that asked for one.
type Acked = futures::channel::oneshot::Receiver<
    std::result::Result<VmValue, restate_sdk_shared_core::Error>,
>;

/// The state key a sync clears with an ack, under the prefix tooling hides.
const SYNC_KEY: &str = "v22/sync";
/// The name the listing of the keys is given, under the same prefix.
const KEYS_NAME: &str = "v22/keys";

/// The store of a session's database over the attempt's VM ([`crate::vm`]):
/// its reads, writes, listing and acks are the VM's commands, awaited here in
/// Rust, so none of them reaches JavaScript.
///
/// JavaScript is still called at one point: a committing transaction's sends,
/// which it makes between the commit's write of the head and the wait for that
/// write's ack. That is the store's `sync`, which `src/database.ts` wraps to
/// run what the transaction gave `withCommit`.
struct VmStore {
    vm: Arc<Mutex<VmInner>>,
    /// The commit hook: the store's `sync`, on JavaScript's thread.
    dispatch: Dispatch,
    /// The database beside the object's own, if this is one: its keys are
    /// named apart (see `beside` in `src/session.ts`).
    name: Option<String>,
    /// A view: it reads beside the owner and writes nothing.
    reader: bool,
    /// The writes issued, and how many of them an ack covers.
    issued: AtomicU64,
    synced: AtomicU64,
    /// Whether the commit in flight has work for JavaScript to run at its sync
    /// (`withCommit`): set by `Database::commit`, which JavaScript tells. A
    /// commit with none skips the hop, which would only run an empty function.
    hook: AtomicBool,
}

impl VmStore {
    /// The object's state key of the database's `key`.
    fn key(&self, key: &str) -> String {
        match &self.name {
            None => key.to_owned(),
            Some(name) => {
                let at = key.find('/').map_or(0, |at| at + 1);
                format!("{}db/{name}/{}", &key[..at], &key[at..])
            }
        }
    }

    /// `key` back, if it is this database's; `None` for any other of the object's.
    fn unbeside(&self, key: &str) -> Option<String> {
        let Some(name) = &self.name else {
            return Some(key.to_owned());
        };
        let at = key.find('/').map_or(0, |at| at + 1);
        let prefix = format!("db/{name}/");
        key[at..]
            .strip_prefix(&prefix)
            .map(|rest| format!("{}{rest}", &key[..at]))
    }

    /// The notification of the command `act` issues. Issuing it and waiting
    /// for it are one critical section (see [`Vm::issue_and_wait`]).
    async fn wait(&self, act: impl FnOnce(&mut CoreVm) -> VmResult) -> io::Result<VmValue> {
        let receiver = Vm::issue_and_wait(&self.vm, act).map_err(io_error)?;
        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(io_error(error)),
            Err(_) => Err(io_error("the attempt ended")),
        }
    }

    /// Issue a write that asks for no ack; its count, for the sync that covers
    /// it. The VM answers such a write at once, and nothing waits for that
    /// answer, so it is dropped here rather than crossing into JavaScript.
    fn write(&self, act: impl FnOnce(&mut CoreVm) -> VmResult) -> io::Result<u64> {
        self.writable()?;
        Vm::issue_and_discard(&self.vm, act).map_err(io_error)?;
        Ok(self.issued.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Issue a write that asks to be acked: its count, and the ack to await.
    /// The waiter is registered with the command, under one lock.
    fn write_acked(&self, act: impl FnOnce(&mut CoreVm) -> VmResult) -> io::Result<(u64, Acked)> {
        self.writable()?;
        let receiver = Vm::issue_and_wait(&self.vm, act).map_err(io_error)?;
        Ok((self.issued.fetch_add(1, Ordering::SeqCst) + 1, receiver))
    }

    fn writable(&self) -> io::Result<()> {
        match self.reader {
            true => Err(io_error("a view writes no state")),
            false => Ok(()),
        }
    }

    /// Wait for the ack of the write `issued`: every write up to it is stored
    /// when it comes, since Restate acks a write only after those before it.
    async fn stored(&self, issued: u64, acked: Acked) -> io::Result<()> {
        match acked.await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(io_error(error)),
            Err(_) => return Err(io_error("the attempt ended")),
        }
        self.synced.fetch_max(issued, Ordering::SeqCst);
        Ok(())
    }

    /// What a commit runs on JavaScript before it waits for its ack: the
    /// committing transaction's sends.
    async fn committing(&self) -> io::Result<()> {
        if !self.hook.load(Ordering::SeqCst) {
            return Ok(());
        }
        let promise = self
            .dispatch
            .call_async_catch((Op::Sync as u32, String::new(), None).into())
            .await
            .map_err(io_error)?;
        promise.await.map_err(io_error).map(drop)
    }
}

impl KvStore for VmStore {
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, io::Result<Option<Bytes>>> {
        Box::pin(async move {
            let key = self.key(key);
            match self
                .wait(|vm| vm.cmd_state_get(key.clone(), Some(key)))
                .await?
            {
                VmValue::Success(value) => Ok(Some(value)),
                VmValue::Void => Ok(None),
                VmValue::Failure(failure) => Err(io_error(failure.message)),
                _ => Err(io_error("the state read answered with the wrong type")),
            }
        })
    }

    fn put(&self, key: &str, value: Bytes) -> io::Result<()> {
        let key = self.key(key);
        self.write(|vm| vm.cmd_state_set(key.clone(), value, Some(key), false))
            .map(drop)
    }

    fn delete(&self, key: &str) -> io::Result<()> {
        let key = self.key(key);
        self.write(|vm| vm.cmd_state_clear(key.clone(), Some(key), false))
            .map(drop)
    }

    /// The head of a flush, written and synced in one: Restate acks a write
    /// only once the writes before it are stored, so its ack is the sync.
    fn put_and_sync<'a>(&'a self, key: &'a str, value: Bytes) -> BoxFuture<'a, io::Result<()>> {
        let named = self.key(key);
        // Issued now, as a put is.
        let written =
            self.write_acked(|vm| vm.cmd_state_set(named.clone(), value, Some(named), true));
        Box::pin(async move {
            let (issued, acked) = written?;
            self.committing().await?;
            self.stored(issued, acked).await
        })
    }

    fn sync(&self) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            if self.reader {
                // A view wrote nothing to sync.
                return Ok(());
            }
            if self.synced.load(Ordering::SeqCst) == self.issued.load(Ordering::SeqCst) {
                // Nothing new to store: only what the commit itself makes.
                return self.committing().await;
            }
            let key = self.key(SYNC_KEY);
            let (issued, acked) =
                self.write_acked(|vm| vm.cmd_state_clear(key.clone(), Some(key), true))?;
            self.committing().await?;
            self.stored(issued, acked).await
        })
    }

    fn keys(&self) -> BoxFuture<'_, io::Result<Vec<String>>> {
        Box::pin(async move {
            if self.reader {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "a view lists no keys",
                ));
            }
            // Named under the state format's prefix, which tooling hides.
            let keys = match self
                .wait(|vm| vm.cmd_state_get_keys(Some(KEYS_NAME.to_owned())))
                .await?
            {
                VmValue::StateKeys(keys) => keys,
                _ => {
                    return Err(io_error(
                        "the listing of the keys answered with the wrong type",
                    ));
                }
            };
            Ok(keys.iter().filter_map(|key| self.unbeside(key)).collect())
        })
    }
}

/// A failure of the database as JavaScript gets it: one a retry would repeat
/// ([`sql::Refused`]) has the code `InvalidArg`, which `src/database.ts`
/// tells apart, as it may have ended the session.
fn error(error: Box<dyn std::error::Error + Send + Sync>) -> Error {
    match error.is::<sql::Refused>() {
        true => Error::new(Status::InvalidArg, error.to_string()),
        false => Error::from_reason(error.to_string()),
    }
}

/// Sets the hook of a VM's store back to `true` (the hop is made) when it is
/// dropped: as the commit it was set for ends, however it ends, even if the
/// call panics or is dropped without running.
struct HookReset(Option<Arc<VmStore>>);

impl Drop for HookReset {
    fn drop(&mut self) {
        if let Some(store) = &self.0 {
            store.hook.store(true, Ordering::SeqCst);
        }
    }
}

/// One session of a namespace's database (see [`sql::Database`]): every
/// SQL commit is durable when its call resolves.
#[napi]
pub struct Database(Arc<sql::Database>, Option<Arc<VmStore>>);

/// The page cache shared by the process's databases: 256 MiB of memory and
/// 1 GiB of disk, in a file under the temporary directory, or the file
/// `RESTATE_SQL_CACHE_FILE` names. `RESTATE_SQL_CACHE_MEMORY` and
/// `RESTATE_SQL_CACHE_DISK` set its sizes (bytes, or with KiB, MiB or GiB);
/// the memory one also bounds the namespaces' states and the parked engines
/// it keeps, so a small cache is a cold one. `RESTATE_SQL_CACHE=off` (or `0`,
/// `false`, `no`) opens every database without a cache (`None`): each session
/// reads what it needs from the store. A size that is not one fails every
/// open, with its message: the process serves, and every invocation retries.
async fn page_cache() -> io::Result<Option<PageCache>> {
    static CACHE: futures::lock::Mutex<Option<Option<PageCache>>> = futures::lock::Mutex::new(None);
    let mut cache = CACHE.lock().await;
    if let Some(cache) = &*cache {
        return Ok(cache.clone());
    }
    let opened = match cache_config()? {
        Some(config) => Some(PageCache::open(config).await?),
        None => None,
    };
    Ok(cache.insert(opened).clone())
}

/// The page cache's configuration, from the environment: `None` when it is off.
fn cache_config() -> io::Result<Option<PageCacheConfig>> {
    let off = var("RESTATE_SQL_CACHE").map(|v| v.to_ascii_lowercase());
    if matches!(off.as_deref(), Some("off" | "0" | "false" | "no")) {
        return Ok(None);
    }
    Ok(Some(PageCacheConfig {
        file: std::env::var_os("RESTATE_SQL_CACHE_FILE").map(std::path::PathBuf::from),
        ..PageCacheConfig::sized(
            size("RESTATE_SQL_CACHE_MEMORY")?.unwrap_or(256 << 20),
            size("RESTATE_SQL_CACHE_DISK")?.unwrap_or(1 << 30),
        )
    }))
}

/// The environment variable `name`, unless unset or empty.
fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The size the environment variable `name` gives, if set: bytes, or with
/// KiB, MiB or GiB ([`state::parse_size`]). One that is not a size is an
/// error that says so.
fn size(name: &str) -> io::Result<Option<usize>> {
    let Some(value) = var(name) else {
        return Ok(None);
    };
    match state::parse_size(&value) {
        Some(size) => Ok(Some(size)),
        None => Err(io::Error::other(format!(
            "{name}={value}: not a size (bytes, or with KiB, MiB or GiB)"
        ))),
    }
}

/// How the process's databases flush: shared-core's defaults
/// ([`StateOptions::default`]), with L0's share from `RESTATE_SQL_L0_BYTES`,
/// read once: a database keeps its checkpoints' packs in the object's state
/// (L0) until they hold this many bytes, and the checkpoint after that moves
/// them, with its own, to the object store ([`StateOptions::l0_bytes`], 4
/// MiB by default; bytes, or with KiB, MiB or GiB). `0` puts every
/// checkpoint's pack in the object store. Without an object store it changes
/// nothing: every pack stays in the state. A size that is not one fails
/// every open, with its message, as a page cache size that is not one does.
///
/// It may differ from one process, or open, to the next: it never changes
/// what is stored, only where the next checkpoint puts its pack. Every
/// pack's name says its tier, which is where reads and garbage collection
/// look for it, so a lower one moves what L0 holds at the next checkpoint,
/// and a higher one keeps more packs in the state from then on; packs never
/// move back from the object store.
fn state_options() -> io::Result<StateOptions> {
    static L0_BYTES: std::sync::Mutex<Option<u64>> = std::sync::Mutex::new(None);
    let mut l0 = L0_BYTES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let defaults = StateOptions::default();
    let l0_bytes = match *l0 {
        Some(bytes) => bytes,
        None => {
            let set = size("RESTATE_SQL_L0_BYTES")?;
            *l0.insert(set.map_or(defaults.l0_bytes, |bytes| bytes as u64))
        }
    };
    Ok(StateOptions {
        l0_bytes,
        ..defaults
    })
}

/// The process's object store, the one `RESTATE_SQL_OBJECT_STORE` names
/// ([`ObjectStoreL1::from_env`]), made once: `None` without one. Its
/// databases share it, and its HTTP client. A `RESTATE_SQL_OBJECT_STORE`
/// that names none fails every open, with its message, as a page cache size
/// that is not one does.
fn object_store() -> io::Result<Option<ObjectStoreL1>> {
    static L1: std::sync::Mutex<Option<Option<ObjectStoreL1>>> = std::sync::Mutex::new(None);
    let mut l1 = L1.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(l1) = &*l1 {
        return Ok(l1.clone());
    }
    Ok(l1.insert(ObjectStoreL1::from_env()?).clone())
}

/// Open the database of `namespace` over the attempt's VM: its state is read
/// and written as the VM's commands ([`VmStore`]), and `store` is called only
/// at a commit, through its `sync`, to make the committing transaction's
/// sends. `name` names a database beside the object's own.
#[napi(
    ts_args_type = "namespace: string, store: Store, vm: Vm, name?: string, reader?: boolean",
    ts_return_type = "Promise<Database>"
)]
pub(crate) fn open_on_vm<'env>(
    env: &'env Env,
    namespace: String,
    store: Object<'env>,
    vm: &Vm,
    name: Option<String>,
    reader: Option<bool>,
) -> Result<PromiseRaw<'env, Database>> {
    let store = Arc::new(VmStore {
        vm: vm.inner(),
        dispatch: dispatcher(env, store)?,
        name,
        reader: reader == Some(true),
        issued: AtomicU64::new(0),
        synced: AtomicU64::new(0),
        hook: AtomicBool::new(true),
    });
    open_with(env, namespace, store.clone(), Some(store), reader)
}

/// Open the database of `namespace` over `store` (see the module's doc),
/// kept warm in the process's page cache, with its packs past L0
/// ([`state_options`]) in the process's object store; see
/// [`sql::Open::reader`] for a `reader`.
#[napi(
    ts_args_type = "namespace: string, store: Store, reader?: boolean",
    ts_return_type = "Promise<Database>"
)]
pub(crate) fn open<'env>(
    env: &'env Env,
    namespace: String,
    store: Object<'env>,
    reader: Option<bool>,
) -> Result<PromiseRaw<'env, Database>> {
    let lists_keys =
        store.get_named_property::<Unknown>("keys")?.get_type()? == ValueType::Function;
    let dispatch = dispatcher(env, store)?;
    let store = Arc::new(JsQueue {
        dispatch,
        lists_keys,
    });
    open_with(env, namespace, store, None, reader)
}

/// Open `namespace`'s database over `store`, kept warm in the process's page
/// cache, with its packs past L0 in the process's object store.
fn open_with<'env>(
    env: &'env Env,
    namespace: String,
    store: Arc<dyn KvStore + Send + Sync>,
    vm_store: Option<Arc<VmStore>>,
    reader: Option<bool>,
) -> Result<PromiseRaw<'env, Database>> {
    env.spawn_future(async move {
        let mut open = sql::Database::open(store).options(state_options()?);
        if let Some(cache) = page_cache().await? {
            open = open.cached(&cache, &namespace);
        }
        if let Some(l1) = object_store()? {
            open = open.checkpoints(Arc::new(l1.blobs(&namespace)));
        }
        if reader == Some(true) {
            open = open.reader();
        }
        Ok(Database(Arc::new(open.await.map_err(error)?), vm_store))
    })
}

#[napi]
impl Database {
    /// Run SQL (one or more statements; parameters bind to a single one) and
    /// return the rows of its last statement, with its column names. A
    /// commit is durable when this resolves.
    #[napi(
        ts_args_type = "sql: string, params?: SqlValue[]",
        ts_return_type = "Answer<{ columns: string[]; rows: SqlValue[][] }>"
    )]
    pub fn query_columns<'env>(
        &self,
        env: &'env Env,
        sql: String,
        params: Option<Vec<SqlValue>>,
    ) -> Result<Either<QueryResult, PromiseRaw<'env, QueryResult>>> {
        let db = self.0.clone();
        answer(env, async move { rows_of(&db, &sql, params).await })
    }

    /// [`Self::query_columns`] after `before`, SQL that runs first, each
    /// statement as a call of its own would run it (no parameters), in the
    /// same call to the addon: the rows are those of `sql`. A statement that
    /// fails ends the call with its error, and the ones after it do not run.
    /// Several calls in one spare their crossings of the addon and their
    /// threads' hand-offs; the SQL run, and its order, are what the same calls
    /// made one by one would run.
    #[napi(
        ts_args_type = "before: string[], sql: string, params?: SqlValue[]",
        ts_return_type = "Answer<{ columns: string[]; rows: SqlValue[][] }>"
    )]
    pub fn query_columns_after<'env>(
        &self,
        env: &'env Env,
        before: Vec<String>,
        sql: String,
        params: Option<Vec<SqlValue>>,
    ) -> Result<Either<QueryResult, PromiseRaw<'env, QueryResult>>> {
        let db = self.0.clone();
        answer(env, async move {
            for statement in &before {
                db.query_columns(statement, None).await.map_err(error)?;
            }
            rows_of(&db, &sql, params).await
        })
    }

    /// See [`sql::Database::begin`].
    #[napi(ts_return_type = "Answer<void>")]
    pub fn begin<'env>(&self, env: &'env Env) -> Result<Either<(), PromiseRaw<'env, ()>>> {
        let db = self.0.clone();
        answer(env, async move { db.begin().await.map_err(error) })
    }

    /// See [`sql::Database::commit`]: `records` by name.
    ///
    /// On the VM, `with_commit` says whether the committing transaction gave
    /// `withCommit` work: without it (`false`) the commit does not call
    /// JavaScript at its sync. Absent, it does.
    #[napi(
        ts_args_type = "records?: Record<string, Buffer>, withCommit?: boolean",
        ts_return_type = "Answer<void>"
    )]
    pub fn commit<'env>(
        &self,
        env: &'env Env,
        records: Option<HashMap<String, Buffer>>,
        with_commit: Option<bool>,
    ) -> Result<Either<(), PromiseRaw<'env, ()>>> {
        let records: Vec<_> = (records.unwrap_or_default().into_iter())
            .map(|(name, value)| (name, Bytes::copy_from_slice(&value)))
            .collect();
        let db = self.0.clone();
        let vm_store = self.1.clone();
        if let Some(store) = &vm_store {
            store
                .hook
                .store(with_commit != Some(false), Ordering::SeqCst);
        }
        let reset = HookReset(vm_store);
        answer(env, async move {
            let _reset = reset;
            db.commit(records).await.map_err(error)
        })
    }

    /// See [`sql::Database::rollback`].
    #[napi(ts_return_type = "Answer<void>")]
    pub fn rollback<'env>(&self, env: &'env Env) -> Result<Either<(), PromiseRaw<'env, ()>>> {
        let db = self.0.clone();
        answer(env, async move { db.rollback().await.map_err(error) })
    }

    /// See [`sql::Database::is_usable`].
    #[napi]
    pub fn is_usable(&self) -> bool {
        self.0.is_usable()
    }

    /// See [`sql::Database::record`].
    #[napi(ts_return_type = "Answer<Buffer>")]
    pub fn record<'env>(
        &self,
        env: &'env Env,
        name: String,
    ) -> Result<Either<Buffer, PromiseRaw<'env, Buffer>>> {
        let db = self.0.clone();
        answer(env, async move {
            let value = db.record(&name).await.map_err(error)?;
            Ok(Buffer::from(value.to_vec()))
        })
    }

    /// See [`sql::Database::save`].
    #[napi(ts_return_type = "Answer<void>")]
    pub fn save<'env>(&self, env: &'env Env) -> Result<Either<(), PromiseRaw<'env, ()>>> {
        let db = self.0.clone();
        answer(env, async move { db.save().await.map_err(error) })
    }

    /// See [`sql::Database::close`].
    #[napi]
    pub async fn close(&self) {
        self.0.close().await
    }
}

/// `sql` run on `db`, with its parameters: its rows with their column names.
async fn rows_of(
    db: &sql::Database,
    sql: &str,
    params: Option<Vec<SqlValue>>,
) -> Result<QueryResult> {
    let params = params.map(|params| params.into_iter().map(|p| p.0).collect());
    let (columns, rows) = db.query_columns(sql, params).await.map_err(error)?;
    Ok(QueryResult {
        columns,
        rows: rows
            .into_iter()
            .map(|row| row.into_iter().map(SqlValue).collect())
            .collect(),
    })
}

/// Rows with the column names of their statement.
#[napi(object)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
}

/// An SQL value: `null`, a number (an integer is stored as INTEGER), a bigint,
/// a string, a `Uint8Array` (BLOB), or a boolean (0 or 1).
pub struct SqlValue(Value);

impl TypeName for SqlValue {
    fn type_name() -> &'static str {
        "SqlValue"
    }

    fn value_type() -> ValueType {
        ValueType::Unknown
    }
}

impl ValidateNapiValue for SqlValue {}

impl FromNapiValue for SqlValue {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
        let unknown = unsafe { Unknown::from_napi_value(env, value)? };
        let value = match unknown.get_type()? {
            ValueType::Null | ValueType::Undefined => Value::Null,
            ValueType::Boolean => {
                Value::from_i64(i64::from(unsafe { bool::from_napi_value(env, value)? }))
            }
            ValueType::Number => {
                let number = unsafe { f64::from_napi_value(env, value)? };
                if number.fract() == 0.0 && number.abs() < 9.2e18 {
                    Value::from_i64(number as i64)
                } else {
                    Value::from_f64(number)
                }
            }
            ValueType::BigInt => {
                let (number, lossless) = unsafe { BigInt::from_napi_value(env, value)? }.get_i64();
                if !lossless {
                    return Err(Error::from_reason("a bigint parameter exceeds 64 bits"));
                }
                Value::from_i64(number)
            }
            ValueType::String => Value::build_text(unsafe { String::from_napi_value(env, value)? }),
            ValueType::Object => {
                let bytes = unsafe { Uint8Array::from_napi_value(env, value)? };
                Value::from_slice(&bytes).map_err(|e| Error::from_reason(e.to_string()))?
            }
            other => {
                return Err(Error::from_reason(format!(
                    "unsupported SQL value: {other}"
                )));
            }
        };
        Ok(SqlValue(value))
    }
}

impl ToNapiValue for SqlValue {
    unsafe fn to_napi_value(env: sys::napi_env, value: Self) -> Result<sys::napi_value> {
        const SAFE: i64 = (1 << 53) - 1;
        unsafe {
            match value.0 {
                Value::Null => Null::to_napi_value(env, Null),
                Value::Numeric(Numeric::Integer(i)) if (-SAFE..=SAFE).contains(&i) => {
                    f64::to_napi_value(env, i as f64)
                }
                Value::Numeric(Numeric::Integer(i)) => i64n::to_napi_value(env, i64n(i)),
                Value::Numeric(Numeric::Float(f)) => f64::to_napi_value(env, f64::from(f)),
                Value::Text(text) => <&str>::to_napi_value(env, text.as_str()),
                Value::Blob(blob) => Buffer::to_napi_value(env, Buffer::from(blob.to_vec())),
            }
        }
    }
}
