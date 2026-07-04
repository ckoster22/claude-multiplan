// Per-plan comment CRUD commands plus their pure map-transition cores.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::model::CommentRecord;
use crate::state::app_state::AppState;
use crate::state::persist::persist_comments;

// The backend is the SINGLE SOURCE OF TRUTH for the comment count. `set_comments`/
// `clear_comments` return the authoritative resulting array so the frontend can adopt it as
// its per-path cache (cache == last backend-confirmed value); `get_comment_count` is the
// cold-read path that answers the count for a plan WITHOUT loading its array frontend-side.
// All four follow the snapshot-then-persist-outside-lock discipline (the std Mutex is never
// held across the blocking `atomic_write`).

/// Read all comments for a plan (empty when none).
#[tauri::command]
pub fn get_comments(path: String, state: tauri::State<'_, Mutex<AppState>>) -> Vec<CommentRecord> {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.comments.get(&path).cloned().unwrap_or_default()
}

/// Cold-read the comment count for a plan WITHOUT loading its array into the frontend cache
/// (the count must persist when the pane is empty or a different plan is open). NOT redundant
/// with `array.length`, which only answers for the currently-open, loaded plan.
#[tauri::command]
pub fn get_comment_count(path: String, state: tauri::State<'_, Mutex<AppState>>) -> usize {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.comments.get(&path).map(|v| v.len()).unwrap_or(0)
}

/// THE pure map transition for `set_comments`. Full-array replacement: a non-empty array inserts/
/// replaces the key; an EMPTY array REMOVES the key (so the persisted map never accumulates
/// empty entries). Returns the AUTHORITATIVE resulting array (what the frontend adopts as its
/// cache) — on success this equals the post-mutation stored value for the key.
pub(crate) fn apply_set_comments(
    map: &mut HashMap<String, Vec<CommentRecord>>,
    path: String,
    comments: Vec<CommentRecord>,
) -> Vec<CommentRecord> {
    if comments.is_empty() {
        map.remove(&path);
    } else {
        map.insert(path.clone(), comments);
    }
    map.get(&path).cloned().unwrap_or_default()
}

/// THE pure map transition for `clear_comments`.
/// Wipes all comments for a plan; returns the resulting (empty) array.
pub(crate) fn apply_clear_comments(
    map: &mut HashMap<String, Vec<CommentRecord>>,
    path: &str,
) -> Vec<CommentRecord> {
    map.remove(path);
    map.get(path).cloned().unwrap_or_default()
}

/// Full-array replacement of a plan's comments. An EMPTY array removes the key entirely (so
/// the persisted map never accumulates empty entries). Returns the AUTHORITATIVE resulting
/// array so the frontend adopts it as its cache (one round-trip, no separate count query).
#[tauri::command]
pub fn set_comments(
    path: String,
    comments: Vec<CommentRecord>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Vec<CommentRecord> {
    let (result, snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let result = apply_set_comments(&mut guard.comments, path, comments);
        (result, guard.comments.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_comments(&data_dir, &snapshot);
    result
}

/// Wipe all comments for a plan. Returns the resulting (empty) array.
#[tauri::command]
pub fn clear_comments(path: String, state: tauri::State<'_, Mutex<AppState>>) -> Vec<CommentRecord> {
    let (result, snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        let result = apply_clear_comments(&mut guard.comments, &path);
        (result, guard.comments.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_comments(&data_dir, &snapshot);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    /// `set_comments` semantics, exercised against the REAL command path's pure core
    /// (`apply_set_comments` — the same free function the `#[tauri::command]` calls, NOT a local
    /// copy). This makes the return-after-mutation contract falsifiable: the frontend adopts the
    /// RETURNED array as its cache, so the function MUST return the POST-mutation value. A
    /// non-empty array inserts/replaces and returns it; an EMPTY array REMOVES the key and
    /// returns the resulting (empty) array.
    #[test]
    fn set_comments_empty_removes_key_and_returns_array() {
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        let key = "/plans/p.md".to_string();

        // Non-empty replacement inserts and RETURNS the post-mutation array (== what was set).
        let recs = vec![comment_rec("x", Some(1), 0, 0), comment_rec("y", None, 2, 1)];
        let returned = apply_set_comments(&mut map, key.clone(), recs.clone());
        assert_eq!(
            returned, recs,
            "set_comments must RETURN the post-mutation array (the frontend adopts it as cache)"
        );
        assert!(map.contains_key(&key), "non-empty set keeps the key present");

        // A SECOND non-empty set fully replaces (not appends) and returns the new array.
        let replacement = vec![comment_rec("z", Some(3), 0, 5)];
        let returned2 = apply_set_comments(&mut map, key.clone(), replacement.clone());
        assert_eq!(returned2, replacement, "set is full-array replacement, not append");

        // Empty array removes the key; the returned array is empty (and the key is gone).
        let returned3 = apply_set_comments(&mut map, key.clone(), Vec::new());
        assert!(returned3.is_empty(), "an empty set returns an empty array");
        assert!(
            !map.contains_key(&key),
            "an empty set must REMOVE the key (no accumulation of empty entries)"
        );
    }

    /// `clear_comments` semantics via its real pure core `apply_clear_comments`: wipes the key
    /// and RETURNS the resulting (empty) array. Falsifiable for the same reason as above —
    /// returning a stale pre-clear array would break the frontend cache adoption.
    #[test]
    fn clear_comments_removes_key_and_returns_empty_array() {
        let mut map: HashMap<String, Vec<CommentRecord>> = HashMap::new();
        let key = "/plans/p.md".to_string();
        map.insert(key.clone(), vec![comment_rec("x", Some(1), 0, 0)]);

        let returned = apply_clear_comments(&mut map, &key);
        assert!(returned.is_empty(), "clear must RETURN the resulting empty array");
        assert!(!map.contains_key(&key), "clear must remove the key");

        // Clearing an absent key is a benign no-op returning empty.
        let again = apply_clear_comments(&mut map, &key);
        assert!(again.is_empty());
    }

}
