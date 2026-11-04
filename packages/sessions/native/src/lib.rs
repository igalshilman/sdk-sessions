//! The Node.js addon of @restatedev/sessions: an object's SQLite-compatible
//! database, kept in its Restate state, over a key/value store the host
//! implements in JavaScript.
//!
//! The storage and the SQL on it live in `restate_sdk_shared_core` (its
//! modules `state` and `sql`, both with its feature `sql`); this
//! crate is the napi bindings around its `sql::Database`.
#[cfg(not(test))]
mod node;
