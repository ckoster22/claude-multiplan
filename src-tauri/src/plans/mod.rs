// Plans domain barrel. Command-bearing submodules (list, contents, write) are `pub(crate) mod`
// so the root `generate_handler!` can name each command by its DEFINITION path
// (`plans::list::list_plans`, …) — a bare `mod` would be private to `plans` and unreachable
// from the crate root (E0603). Cross-domain callers import each helper by its definition path
// (`plans::frontmatter::parse_marker`, …); no barrel re-exports (no `pub use *`).

pub(crate) mod arrange;
pub(crate) mod contents;
pub(crate) mod frontmatter;
pub(crate) mod list;
pub(crate) mod resume;
pub(crate) mod write;
