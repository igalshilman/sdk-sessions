//! How a call from JavaScript into the addon is answered ([`answer`]): its
//! value when it is ready at once, polled here on the JavaScript thread,
//! otherwise a promise that the runtime settles ([`hand_over`]).
// What needs Node.js to run (`answer` and `hand_over`, which are given an `Env`)
// is not built for the tests, which cannot link to it (see `lib.rs`); what it
// decides is the rest, and is tested.
use napi::JsDeferred;
use napi::bindgen_prelude::*;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

/// `call`'s value if it is ready at once, polled here on the JavaScript
/// thread; else a promise of it, as it goes on in the runtime
/// ([`hand_over`]). Ready, a call spares a task and a thread-safe function:
/// what a call to the addon costs otherwise, several times the work of a
/// call that needs nothing from the runtime.
///
/// A call that fails when it is ready throws, as the addon's own functions
/// do; one that fails after it was handed over rejects. A call that panics
/// fails the same way in both ([`panicked`]).
#[cfg(not(test))]
pub(crate) fn answer<'env, T>(
    env: &'env Env,
    call: impl Future<Output = Result<T>> + Send + 'static,
) -> Result<Either<T, PromiseRaw<'env, T>>>
where
    T: ToNapiValue + Send + 'static,
{
    let mut call = Box::pin(call);
    match poll_here(call.as_mut()) {
        Poll::Ready(result) => result.map(Either::A),
        Poll::Pending => hand_over(env, call).map(Either::B),
    }
}

/// Poll `call` once, here, in the runtime's context: a call that reads a pack
/// in the object store makes its request here, and the request (reqwest's)
/// takes its connection and its timers from the current runtime.
///
/// A panic of the call is its error. It must not unwind out of the napi
/// function that called this: a `#[napi]` method has no `catch_unwind` unless
/// it asks for one, and a panic out of it aborts the process. The call is
/// dropped by the caller, which abandons its session as any call dropped
/// part way is ([`sql::Database`]).
///
/// [`sql::Database`]: restate_sdk_shared_core::sql::Database
fn poll_here<T, E: Failure>(
    call: Pin<&mut impl Future<Output = std::result::Result<T, E>>>,
) -> Poll<std::result::Result<T, E>> {
    let polled = catch_unwind(AssertUnwindSafe(|| {
        within_runtime_if_available(|| call.poll(&mut Context::from_waker(Waker::noop())))
    }));
    polled.unwrap_or_else(|payload| Poll::Ready(Err(panicked(payload))))
}

/// A promise of `call`'s value: the call is spawned once, on the runtime, and
/// the task that runs it settles the promise, from its own thread, with the
/// value or the error. `call` may have been polled already ([`answer`]): it
/// continues where it stopped. It is not awaited by a task of its own, as the
/// runtime's own bridge of a future to a promise does: SQL that the runtime
/// runs is not handed on again, as it is in a task already.
///
/// The promise settles whatever becomes of the task ([`finish`]).
#[cfg(not(test))]
fn hand_over<'env, T>(
    env: &'env Env,
    call: impl Future<Output = Result<T>> + Send + 'static,
) -> Result<PromiseRaw<'env, T>>
where
    T: ToNapiValue + Send + 'static,
{
    use napi::JsValue;
    let (deferred, promise) = env.create_deferred::<T, Resolver<T>>()?;
    let task = finish(call, Settle(Some(deferred), PhantomData));
    // A runtime that cannot take the task panics, and drops the task, which
    // rejects the promise: nothing more to do with the panic.
    drop(catch_unwind(AssertUnwindSafe(|| spawn(task))));
    Ok(PromiseRaw::new(env.raw(), promise.raw()))
}

/// Run `call` to its end and settle its promise with the result. A call that
/// panics rejects it with the panic's message.
async fn finish<T, E: Failure>(
    call: impl Future<Output = std::result::Result<T, E>>,
    mut settle: Settle<T, E, impl Settled<T, E>>,
) {
    use futures::FutureExt;
    let result = match AssertUnwindSafe(call).catch_unwind().await {
        Ok(result) => result,
        Err(payload) => Err(panicked(payload)),
    };
    if let Some(promise) = settle.0.take() {
        match result {
            Ok(value) => promise.resolve(value),
            Err(error) => promise.reject(error),
        }
    }
}

/// The error of a call that panicked: the message of its panic.
fn panicked<E: Failure>(payload: Box<dyn std::any::Any + Send>) -> E {
    let message = match payload.downcast::<&str>() {
        Ok(message) => (*message).to_owned(),
        Err(payload) => match payload.downcast::<String>() {
            Ok(message) => *message,
            Err(_) => "Panic in async function".to_owned(),
        },
    };
    E::failed(message)
}

/// The error of a call that the addon itself fails: the type the calls fail
/// with, so that what decides it can be tested without a Node.js to link to.
trait Failure {
    fn failed(message: String) -> Self;
}

impl Failure for Error {
    fn failed(message: String) -> Self {
        Error::new(Status::GenericFailure, message)
    }
}

/// A promise that any thread can settle, once.
trait Settled<T, E>: Send + 'static {
    fn resolve(self, value: T);
    fn reject(self, error: E);
}

/// What a deferred runs on the JavaScript thread to resolve its promise.
type Resolver<T> = Box<dyn FnOnce(Env) -> Result<T> + Send>;

impl<T: ToNapiValue + Send + 'static> Settled<T, Error> for JsDeferred<T, Resolver<T>> {
    fn resolve(self, value: T) {
        JsDeferred::resolve(self, Box::new(move |_| Ok(value)));
    }

    fn reject(self, error: Error) {
        JsDeferred::reject(self, error);
    }
}

/// The promise of a call that was handed to the runtime ([`hand_over`]). A
/// deferred that is dropped without settling leaves its promise pending for
/// good, so this rejects it when its task drops it before the call returned:
/// a task the runtime dropped as it shut down, or never ran. Taken out by a
/// task that settles it.
struct Settle<T, E: Failure, S: Settled<T, E>>(Option<S>, PhantomData<fn() -> (T, E)>);

impl<T, E: Failure, S: Settled<T, E>> Drop for Settle<T, E, S> {
    fn drop(&mut self) {
        if let Some(promise) = self.0.take() {
            promise.reject(E::failed(
                "the call did not finish: the runtime ended".into(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    // The calls fail here with a `String` for the error: napi's own `Error`
    // needs Node.js to link against, and nothing under test depends on it.
    use super::*;
    use futures::executor::block_on;
    use std::future::poll_fn;
    use std::sync::{Arc, Mutex};

    type Outcome = std::result::Result<i32, String>;

    impl Failure for String {
        fn failed(message: String) -> Self {
            message
        }
    }

    /// How a call's promise was settled.
    #[derive(Debug, PartialEq)]
    enum Settling {
        Resolved(i32),
        Rejected(String),
    }

    /// A promise that records how it is settled.
    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<Settling>>>);

    impl Recorder {
        fn settle(&self) -> Settle<i32, String, Recorder> {
            Settle(Some(self.clone()), PhantomData)
        }

        fn settled(&self) -> Vec<Settling> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    impl Settled<i32, String> for Recorder {
        fn resolve(self, value: i32) {
            self.0.lock().unwrap().push(Settling::Resolved(value));
        }

        fn reject(self, error: String) {
            self.0.lock().unwrap().push(Settling::Rejected(error));
        }
    }

    fn rejected(message: &str) -> Settling {
        Settling::Rejected(message.into())
    }

    const ENDED: &str = "the call did not finish: the runtime ended";

    /// A call that stops once, as one that waits for the store does, and counts its polls.
    fn stopping(polls: Arc<Mutex<u32>>) -> impl Future<Output = Outcome> + Send + 'static {
        let mut stopped = false;
        poll_fn(move |cx| {
            *polls.lock().unwrap() += 1;
            if std::mem::replace(&mut stopped, true) {
                return Poll::Ready(Ok(5));
            }
            cx.waker().wake_by_ref();
            Poll::Pending
        })
    }

    #[test]
    fn a_call_that_is_ready_answers_in_the_first_poll() {
        let mut call = Box::pin(async { Outcome::Ok(7) });
        assert_eq!(poll_here(call.as_mut()), Poll::Ready(Ok(7)));
        let mut call = Box::pin(async { Err::<i32, _>("refused".to_owned()) });
        assert_eq!(poll_here(call.as_mut()), Poll::Ready(Err("refused".into())));
    }

    #[test]
    fn a_panic_in_the_first_poll_is_the_calls_error() {
        // The panic does not unwind out of the poll: it is an error, and the
        // call, dropped by its caller, runs its guards (the engine abandons its
        // session so) as a call dropped part way does.
        struct Guard(Arc<Mutex<bool>>);
        impl Drop for Guard {
            fn drop(&mut self) {
                *self.0.lock().unwrap() = true;
            }
        }
        let dropped = Arc::new(Mutex::new(false));
        let guard = Guard(dropped.clone());
        let mut call = Box::pin(async move {
            let _guard = guard;
            if true {
                panic!("the engine broke");
            }
            Outcome::Ok(1)
        });
        assert_eq!(
            poll_here(call.as_mut()),
            Poll::Ready(Err("the engine broke".into()))
        );
        drop(call);
        assert!(*dropped.lock().unwrap());

        let mut call = Box::pin(async { panic!("{}", String::from("a formatted message")) });
        assert_eq!(
            poll_here::<i32, String>(call.as_mut()),
            Poll::Ready(Err("a formatted message".into()))
        );
        let mut call = Box::pin(async { std::panic::panic_any(5_u8) });
        assert_eq!(
            poll_here::<i32, String>(call.as_mut()),
            Poll::Ready(Err("Panic in async function".into()))
        );
    }

    #[test]
    fn a_call_that_stopped_continues_where_it_stopped_once_handed_over() {
        let polls = Arc::new(Mutex::new(0));
        let mut call = Box::pin(stopping(polls.clone()));
        assert!(poll_here(call.as_mut()).is_pending());
        let promise = Recorder::default();
        block_on(finish(call, promise.settle()));
        // Polled again, not started over, and its promise settled once.
        assert_eq!(*polls.lock().unwrap(), 2);
        assert_eq!(promise.settled(), [Settling::Resolved(5)]);
    }

    #[test]
    fn a_handed_over_call_resolves_or_rejects_its_promise() {
        let promise = Recorder::default();
        block_on(finish(async { Outcome::Ok(3) }, promise.settle()));
        assert_eq!(promise.settled(), [Settling::Resolved(3)]);
        block_on(finish(
            async { Outcome::Err("refused".into()) },
            promise.settle(),
        ));
        assert_eq!(promise.settled(), [rejected("refused")]);
    }

    #[test]
    fn a_handed_over_call_that_panics_rejects_its_promise_with_the_message() {
        let promise = Recorder::default();
        block_on(finish(
            async {
                if true {
                    panic!("the engine broke");
                }
                Outcome::Ok(1)
            },
            promise.settle(),
        ));
        assert_eq!(promise.settled(), [rejected("the engine broke")]);
    }

    #[test]
    fn a_task_dropped_without_a_result_rejects_its_promise() {
        // Never run: the runtime took the task and dropped it as it shut down.
        let promise = Recorder::default();
        drop(finish(async { Outcome::Ok(1) }, promise.settle()));
        assert_eq!(promise.settled(), [rejected(ENDED)]);

        // Dropped part way.
        let mut task = Box::pin(finish(stopping(Default::default()), promise.settle()));
        assert!(
            task.as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        drop(task);
        assert_eq!(promise.settled(), [rejected(ENDED)]);

        // One that settled its promise does not reject it again as it is dropped.
        block_on(finish(async { Outcome::Ok(2) }, promise.settle()));
        assert_eq!(promise.settled(), [Settling::Resolved(2)]);
    }
}
