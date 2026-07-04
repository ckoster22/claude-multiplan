// Read-state + comment command domain barrel. Command-bearing submodules are
// `pub(crate) mod` so the crate root can name each command by its DEFINITION path.

pub(crate) mod comments;
pub(crate) mod read_state;
pub(crate) mod snapshot;
