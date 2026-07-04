// State domain barrel. Submodules are `pub(crate) mod` so the crate root can name them by path;
// callers import each item by its definition path (`state::persist::atomic_write`, …) — no barrel
// re-exports (no `pub use *`).

pub(crate) mod app_state;
pub(crate) mod persist;
