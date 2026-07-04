// Atomic write primitive + the five JSON-backed persistence stores (cwd cache, read-state,
// collapse state, comments, tree-cwd index) and the `ReadState` type. Every load degrades
// non-destructively (corrupt ⇒ log + empty, never rewrite the bad file); every persist is a
// temp-write + atomic rename and no-ops (logs) without a data dir.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::model::CommentRecord;
use crate::paths::now_ms;

/// Persisted read/unread state. `baseline_ms` is the first-launch seed: every plan whose
/// mtime predates the baseline counts as already read (we never write 72 per-plan entries).
/// `viewed[absolute_path] = last_viewed_ms` overrides the baseline per plan once opened.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub(crate) struct ReadState {
    pub(crate) baseline_ms: i64,
    pub(crate) viewed: HashMap<String, i64>,
}

// `pub(crate)` (not module-private) because the root `#[cfg(test)] mod tests` still names these
// filenames when fabricating temp store files; they re-export through the `state` barrel until the
// persist tests colocate here.
pub(crate) const CWD_CACHE_FILE: &str = "cwd-cache.json";
pub(crate) const READ_STATE_FILE: &str = "read-state.json";
pub(crate) const COLLAPSE_STATE_FILE: &str = "collapse-state.json";
pub(crate) const COMMENTS_FILE: &str = "comments.json";
pub(crate) const TREE_CWD_INDEX_FILE: &str = "tree-cwd-index.json";

/// Atomically write `bytes` to `target`: write a temp file in the SAME directory, then
/// `rename` over the target (atomic on one filesystem; no truncate-mid-write corruption).
/// Returns Err on any I/O failure — callers log and degrade, never panic.
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "target has no parent dir")
    })?;
    // Unique-ish temp name in the same dir so rename stays on one filesystem.
    let pid = std::process::id();
    let stamp = now_ms();
    let tmp = parent.join(format!(".tmp-{pid}-{stamp}-{}", nanos_suffix()));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp); // best-effort cleanup
            Err(e)
        }
    }
}

/// Sub-nanosecond entropy for the temp-file name (avoids collisions within the same ms).
pub(crate) fn nanos_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Load the persisted cwd cache. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty WITHOUT
/// rewriting the bad file (non-destructive). Never panics.
pub(crate) fn load_cwd_cache(dir: &Path) -> HashMap<String, String> {
    let path = dir.join(CWD_CACHE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty
    };
    match serde_json::from_slice::<HashMap<String, String>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!("[state] {CWD_CACHE_FILE} is corrupt ({e}); ignoring (in-memory only)");
            HashMap::new()
        }
    }
}

/// Load the persisted read-state. Absent ⇒ empty + `baseline_ms = now` (seed). Corrupt ⇒
/// log + empty WITHOUT re-seeding a fresh baseline that would silently mark a changed corpus
/// all-read, and WITHOUT rewriting the bad file. The `seeded` flag tells the caller whether
/// it should persist the freshly-seeded baseline (only on a clean absent load).
pub(crate) fn load_read_state(dir: &Path) -> (ReadState, bool) {
    let path = dir.join(READ_STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            // Absent ⇒ seed baseline-as-read at first launch.
            return (
                ReadState {
                    baseline_ms: now_ms(),
                    viewed: HashMap::new(),
                },
                true,
            );
        }
    };
    match serde_json::from_slice::<ReadState>(&bytes) {
        Ok(rs) => (rs, false),
        Err(e) => {
            eprintln!(
                "[state] {READ_STATE_FILE} is corrupt ({e}); ignoring without re-seeding \
                 baseline (in-memory only, baseline=0 so nothing is force-marked read)"
            );
            // Degrade to empty. baseline_ms=0 means absent-entry plans are treated as
            // unread (mtime > 0) rather than silently all-read — the safe failure mode.
            (ReadState::default(), false)
        }
    }
}

/// Persist the cwd cache atomically. No-op (logs) when there's no data dir or on write error.
pub(crate) fn persist_cwd_cache(data_dir: &Option<PathBuf>, cache: &HashMap<String, String>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(cache) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize cwd cache: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(CWD_CACHE_FILE), &bytes) {
        eprintln!("[state] failed to persist {CWD_CACHE_FILE}: {e}");
    }
}

/// Persist the read-state atomically. No-op (logs) when there's no data dir or on write error.
pub(crate) fn persist_read_state(data_dir: &Option<PathBuf>, rs: &ReadState) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(rs) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize read-state: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(READ_STATE_FILE), &bytes) {
        eprintln!("[state] failed to persist {READ_STATE_FILE}: {e}");
    }
}

/// Load the persisted collapse state. Absent ⇒ empty (everything expanded). Corrupt/
/// unparseable ⇒ log + empty WITHOUT rewriting the bad file (non-destructive). Never panics.
/// Exact shape-twin of `load_cwd_cache`.
pub(crate) fn load_collapse_state(dir: &Path) -> HashMap<String, bool> {
    let path = dir.join(COLLAPSE_STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty (all expanded)
    };
    match serde_json::from_slice::<HashMap<String, bool>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!(
                "[state] {COLLAPSE_STATE_FILE} is corrupt ({e}); ignoring (all expanded, in-memory only)"
            );
            HashMap::new()
        }
    }
}

/// Persist the collapse state atomically. No-op (logs) when there's no data dir or on write
/// error. Exact shape-twin of `persist_cwd_cache`.
pub(crate) fn persist_collapse_state(data_dir: &Option<PathBuf>, map: &HashMap<String, bool>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(map) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize collapse state: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(COLLAPSE_STATE_FILE), &bytes) {
        eprintln!("[state] failed to persist {COLLAPSE_STATE_FILE}: {e}");
    }
}

/// Load the persisted comments map. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty WITHOUT
/// rewriting the bad file (non-destructive). Never panics. Exact shape-twin of
/// `load_collapse_state`.
pub(crate) fn load_comments(dir: &Path) -> HashMap<String, Vec<CommentRecord>> {
    let path = dir.join(COMMENTS_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty (no comments)
    };
    match serde_json::from_slice::<HashMap<String, Vec<CommentRecord>>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!(
                "[state] {COMMENTS_FILE} is corrupt ({e}); ignoring (no comments, in-memory only)"
            );
            HashMap::new()
        }
    }
}

/// Persist the comments map atomically. No-op (logs) when there's no data dir or on write
/// error. Exact shape-twin of `persist_collapse_state`.
pub(crate) fn persist_comments(data_dir: &Option<PathBuf>, map: &HashMap<String, Vec<CommentRecord>>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(map) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize comments: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(COMMENTS_FILE), &bytes) {
        eprintln!("[state] failed to persist {COMMENTS_FILE}: {e}");
    }
}

/// Load the persisted `tree_id → cwd` index. Absent ⇒ empty. Corrupt/unparseable ⇒ log + empty
/// WITHOUT rewriting the bad file (non-destructive). Never panics. Exact shape-twin of
/// `load_cwd_cache` (both are `HashMap<String, String>`).
pub(crate) fn load_tree_cwd_index(dir: &Path) -> HashMap<String, String> {
    let path = dir.join(TREE_CWD_INDEX_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return HashMap::new(), // absent ⇒ empty
    };
    match serde_json::from_slice::<HashMap<String, String>>(&bytes) {
        Ok(map) => map,
        Err(e) => {
            eprintln!(
                "[state] {TREE_CWD_INDEX_FILE} is corrupt ({e}); ignoring (in-memory only)"
            );
            HashMap::new()
        }
    }
}

/// Persist the `tree_id → cwd` index atomically. No-op (logs) when there's no data dir or on
/// write error. Exact shape-twin of `persist_cwd_cache`.
pub(crate) fn persist_tree_cwd_index(data_dir: &Option<PathBuf>, index: &HashMap<String, String>) {
    let Some(dir) = data_dir else {
        return; // in-memory only
    };
    let bytes = match serde_json::to_vec_pretty(index) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[state] failed to serialize tree-cwd index: {e}");
            return;
        }
    };
    if let Err(e) = atomic_write(&dir.join(TREE_CWD_INDEX_FILE), &bytes) {
        eprintln!("[state] failed to persist {TREE_CWD_INDEX_FILE}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    #[test]
    fn cwd_cache_round_trips() {
        let dir = unique_dir("persA");
        let mut cache = HashMap::new();
        cache.insert("stem-a".to_string(), "/cwd/a".to_string());
        cache.insert("stem-b".to_string(), "/cwd/b".to_string());

        persist_cwd_cache(&Some(dir.clone()), &cache);
        let loaded = load_cwd_cache(&dir);
        assert_eq!(loaded, cache, "cwd cache must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_state_round_trips() {
        let dir = unique_dir("persB");
        let mut rs = ReadState {
            baseline_ms: 12_345,
            viewed: HashMap::new(),
        };
        rs.viewed.insert("/tmp/p.md".to_string(), 99_999);

        persist_read_state(&Some(dir.clone()), &rs);
        let (loaded, seeded) = load_read_state(&dir);
        assert!(!seeded, "loading an existing file must not be flagged as a fresh seed");
        assert_eq!(loaded.baseline_ms, 12_345);
        assert_eq!(loaded.viewed.get("/tmp/p.md").copied(), Some(99_999));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_read_state_is_empty_with_baseline_now() {
        let dir = unique_dir("persC"); // exists but has no read-state.json
        let before = now_ms();
        let (rs, seeded) = load_read_state(&dir);
        let after = now_ms();
        assert!(seeded, "an absent read-state must be flagged for baseline seeding");
        assert!(rs.viewed.is_empty(), "absent ⇒ empty viewed map");
        assert!(
            rs.baseline_ms >= before && rs.baseline_ms <= after,
            "absent ⇒ baseline seeded to ~now (got {}, window {before}..={after})",
            rs.baseline_ms
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_cwd_cache_is_empty() {
        let dir = unique_dir("persD"); // exists but has no cwd-cache.json
        let loaded = load_cwd_cache(&dir);
        assert!(loaded.is_empty(), "absent cwd cache ⇒ empty map");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_read_state_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("persE");
        let path = dir.join(READ_STATE_FILE);
        let garbage = b"{ this is : not valid json @@@ ";
        std::fs::write(&path, garbage).expect("write garbage");

        // Must NOT panic, must degrade to empty, must NOT re-seed a fresh baseline.
        let (rs, seeded) = load_read_state(&dir);
        assert!(!seeded, "corrupt file must NOT be flagged as a fresh seed");
        assert_eq!(rs.baseline_ms, 0, "corrupt ⇒ baseline 0 (nothing force-marked read)");
        assert!(rs.viewed.is_empty());

        // The corrupt file must be left UNTOUCHED (non-destructive).
        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt file must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_cwd_cache_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("persF");
        let path = dir.join(CWD_CACHE_FILE);
        let garbage = b"<<<not json>>>";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_cwd_cache(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt cwd cache ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt cwd cache must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_overwrites_existing_target() {
        let dir = unique_dir("atomic");
        let target = dir.join("data.json");
        std::fs::write(&target, b"old contents").expect("seed");
        atomic_write(&target, b"new contents").expect("atomic write");
        let got = std::fs::read(&target).expect("read back");
        assert_eq!(got, b"new contents");
        // No leftover temp files in the dir.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with(".tmp-"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftovers.is_empty(), "atomic_write must not leave temp files behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collapse_state_round_trips() {
        let dir = unique_dir("collapseA");
        let mut map = HashMap::new();
        map.insert("tree-a".to_string(), true);
        map.insert("tree-b".to_string(), false);

        persist_collapse_state(&Some(dir.clone()), &map);
        let loaded = load_collapse_state(&dir);
        assert_eq!(loaded, map, "collapse state must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_collapse_state_is_empty() {
        let dir = unique_dir("collapseB"); // exists but has no collapse-state.json
        let loaded = load_collapse_state(&dir);
        assert!(loaded.is_empty(), "absent collapse state ⇒ empty (all expanded)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_collapse_state_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("collapseC");
        let path = dir.join(COLLAPSE_STATE_FILE);
        let garbage = b"{ not : valid json @@@";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_collapse_state(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt collapse state ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt collapse state must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn comments_round_trip() {
        let dir = unique_dir("commentsA");
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        map.insert(
            "/plans/p1.md".to_string(),
            vec![
                comment_rec("hello world", Some(5), 1, 0),
                // A block_line: None record MUST round-trip as JSON null (no -1 sentinel).
                comment_rec("whole pane quote", None, 0, 1),
            ],
        );
        map.insert(
            "/plans/p2.md".to_string(),
            vec![comment_rec("another", Some(0), 0, 0)],
        );

        persist_comments(&Some(dir.clone()), &map);

        // The block_line: None record must serialize to literal JSON `null`, never omitted/-1.
        let raw = std::fs::read_to_string(dir.join(COMMENTS_FILE)).expect("read comments file");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid json");
        let none_rec = &v["/plans/p1.md"][1];
        assert_eq!(
            none_rec.get("block_line"),
            Some(&serde_json::Value::Null),
            "a None block_line must serialize as JSON null, not omitted or -1"
        );

        let loaded = load_comments(&dir);
        assert_eq!(loaded, map, "comments must round-trip write→read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_comments_is_empty() {
        let dir = unique_dir("commentsB"); // exists but has no comments.json
        let loaded = load_comments(&dir);
        assert!(loaded.is_empty(), "absent comments ⇒ empty map");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_comments_degrades_without_panic_or_rewrite() {
        let dir = unique_dir("commentsC");
        let path = dir.join(COMMENTS_FILE);
        let garbage = b"{ not : valid json @@@";
        std::fs::write(&path, garbage).expect("write garbage");

        let loaded = load_comments(&dir); // must not panic
        assert!(loaded.is_empty(), "corrupt comments ⇒ empty");

        let after = std::fs::read(&path).expect("file still present");
        assert_eq!(after, garbage, "corrupt comments must not be destructively rewritten");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `#[serde(default)]` must rescue OLD saved files that predate `block_end_line`: a comments
    /// JSON object whose records lack the key deserializes to `None` (not an error). Pins the
    /// backward-compat guarantee the task requires.
    #[test]
    fn old_comment_files_without_block_end_line_deserialize() {
        let dir = unique_dir("commentsOld");
        // Hand-written legacy 5-key record (no `block_end_line`).
        let legacy = r#"{"/plans/old.md":[{"quote":"legacy quote","block_line":3,"occurrence":0,"comment":"old note","id":0}]}"#;
        std::fs::write(dir.join(COMMENTS_FILE), legacy).expect("write legacy comments");

        let loaded = load_comments(&dir);
        let recs = loaded.get("/plans/old.md").expect("legacy key present");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].block_line, Some(3));
        assert_eq!(
            recs[0].block_end_line, None,
            "a record missing block_end_line must deserialize to None via serde(default)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Index persistence round-trips and degrades gracefully (absent ⇒ empty), mirroring the
    /// `cwd_cache_round_trips` / `missing_cwd_cache_is_empty` pattern.
    #[test]
    fn tree_cwd_index_round_trips_and_missing_is_empty() {
        let dir = unique_dir("treeIndexPersist");
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("t1".to_string(), "/repos/x".to_string());
        index.insert("t2".to_string(), "/repos/y".to_string());
        persist_tree_cwd_index(&Some(dir.clone()), &index);
        assert_eq!(load_tree_cwd_index(&dir), index, "round-trip must be lossless");

        let empty = unique_dir("treeIndexMissing"); // exists, but no tree-cwd-index.json
        assert!(
            load_tree_cwd_index(&empty).is_empty(),
            "a missing index file must load as empty (best-effort)"
        );

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

}
