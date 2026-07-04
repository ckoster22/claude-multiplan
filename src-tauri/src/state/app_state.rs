// The Tauri-managed application state + its first-launch construction.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::model::CommentRecord;
use crate::paths::now_ms;
use crate::state::persist::{
    load_collapse_state, load_comments, load_cwd_cache, load_read_state, load_tree_cwd_index,
    persist_read_state, ReadState,
};

/// Tauri-managed state (keyed by type, alongside the debouncer `Mutex`). Held behind a
/// `std::sync::Mutex<AppState>`. The lock is NEVER held across blocking file I/O or an
/// `.await` — callers clone the small maps under the lock, release, then persist.
#[derive(Default)]
pub(crate) struct AppState {
    /// filename_stem -> resolved cwd. Only SUCCESSFUL resolutions are kept (sticky).
    pub(crate) cwd_cache: HashMap<String, String>,
    pub(crate) read_state: ReadState,
    /// Absolute path of the currently-open plan (read by fiat).
    pub(crate) open_path: Option<String>,
    /// Directory under which `cwd-cache.json` / `read-state.json` live. `None` ⇒ in-memory
    /// only (app_data_dir / create_dir_all failed); all persistence then silently no-ops.
    pub(crate) data_dir: Option<PathBuf>,
    /// tree_id → collapsed. ABSENT means expanded (the default). Persisted to
    /// `collapse-state.json`. Only master `tree_id`s are meaningful keys.
    pub(crate) collapse_state: HashMap<String, bool>,
    /// plan absolute_path → its comments. ABSENT means no comments. Persisted to
    /// `comments.json`. The backend is the single source of truth for the comment count.
    pub(crate) comments: HashMap<String, Vec<CommentRecord>>,
    /// `tree_id` → absolute originating cwd, persisted to `tree-cwd-index.json`. App-generated
    /// plan-tree plans (`write_agent_plan`, frontmatter-tagged with `tree_id`) never emit a
    /// plan-write event into a `~/.claude/projects/` transcript, so the transcript-scan resolver
    /// returns "unknown" for them. This index is the authoritative fast-path consulted BEFORE the
    /// scan: kept fresh by `write_plan_tree_file` (on every `state.json` write) and seeded once at
    /// startup by the backfill thread. Best-effort: a missing/corrupt file loads empty.
    pub(crate) tree_cwd_index: HashMap<String, String>,
}

/// Build the initial `AppState`: locate + create the data dir, load both persisted files
/// (degrading on any failure), and seed the read-state baseline on first launch. Pure-ish:
/// takes the resolved data dir Option so `setup()` can wire it from `app.path()`.
pub(crate) fn init_app_state(data_dir: Option<PathBuf>) -> AppState {
    let (cwd_cache, read_state, seed_baseline, collapse_state, comments, tree_cwd_index) =
        match &data_dir {
            Some(dir) => {
                let cwd_cache = load_cwd_cache(dir);
                let (read_state, seeded) = load_read_state(dir);
                let collapse_state = load_collapse_state(dir);
                let comments = load_comments(dir);
                let tree_cwd_index = load_tree_cwd_index(dir);
                (
                    cwd_cache,
                    read_state,
                    seeded,
                    collapse_state,
                    comments,
                    tree_cwd_index,
                )
            }
            None => {
                // In-memory only. baseline_ms = now so a session without persistence still
                // treats the existing corpus as read (matches first-launch semantics).
                (
                    HashMap::new(),
                    ReadState {
                        baseline_ms: now_ms(),
                        viewed: HashMap::new(),
                    },
                    false,
                    HashMap::new(),
                    HashMap::new(),
                    HashMap::new(),
                )
            }
        };

    let state = AppState {
        cwd_cache,
        read_state,
        open_path: None,
        data_dir: data_dir.clone(),
        collapse_state,
        comments,
        tree_cwd_index,
    };

    // Persist the freshly-seeded baseline so a relaunch keeps the same baseline (only on a
    // clean absent load — never overwrite a corrupt file).
    if seed_baseline {
        persist_read_state(&state.data_dir, &state.read_state);
    }

    state
}
