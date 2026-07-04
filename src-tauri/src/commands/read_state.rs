// Open-plan / viewed / collapse read-state mutators. Each mutates `AppState` under the lock,
// snapshots, releases, then persists outside the lock (never holds the std Mutex across I/O).

use std::sync::Mutex;

use crate::paths::{file_mtime_ms, now_ms};
use crate::state::app_state::AppState;
use crate::state::persist::{persist_collapse_state, persist_read_state};

/// Record the currently-open plan (or `null` when nothing is selected). The open plan is
/// read by fiat in `list_plans`, so this is what keeps a live-edited open plan from re-bolding.
#[tauri::command]
pub fn set_open_plan(path: Option<String>, state: tauri::State<'_, Mutex<AppState>>) {
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    guard.open_path = path;
}

// INVARIANT[viewed-stamp-outlasts-simultaneous-edit] (runtime-guard): the recorded view stamp is `max(now, mtime + 1)`, so a just-viewed plan can never re-appear unread against a same-instant or future-dated edit; a stat failure falls back to `now`.
//   prevents: a plan you just opened flashing back to unread because an edit landed at the same millisecond (mtime == now) or the file carries a future mtime (mtime > now).
//   test: viewed_stamp_outlasts_simultaneous_and_future_edits
pub(crate) fn viewed_stamp(now_ms: i64, mtime_ms: Option<i64>) -> i64 {
    match mtime_ms {
        Some(mtime) => now_ms.max(mtime + 1),
        None => now_ms,
    }
}

#[tauri::command]
pub fn mark_viewed(path: String, state: tauri::State<'_, Mutex<AppState>>) {
    let stamp = viewed_stamp(now_ms(), file_mtime_ms(&path));

    let (snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.read_state.viewed.insert(path, stamp);
        (guard.read_state.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_read_state(&data_dir, &snapshot);
}

/// Set (and persist) the collapsed state for a master's `tree_id`. Mirrors `mark_viewed`'s
/// snapshot-then-persist-outside-lock discipline: mutate the in-memory map under the lock,
/// clone a snapshot, release the lock, then write to disk (the `std::sync::Mutex` is never
/// held across the blocking file I/O).
#[tauri::command]
pub fn set_tree_collapsed(tree_id: String, collapsed: bool, state: tauri::State<'_, Mutex<AppState>>) {
    let (snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.collapse_state.insert(tree_id, collapsed);
        (guard.collapse_state.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_collapse_state(&data_dir, &snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewed_stamp_outlasts_simultaneous_and_future_edits() {
        // mtime == now ⇒ now + 1 (the +1 clears a same-instant edit).
        assert_eq!(viewed_stamp(1_000, Some(1_000)), 1_001);
        // mtime > now (future-dated edit) ⇒ mtime + 1.
        assert_eq!(viewed_stamp(1_000, Some(5_000)), 5_001);
        // mtime < now ⇒ now (already strictly past the edit).
        assert_eq!(viewed_stamp(1_000, Some(500)), 1_000);
        // No mtime (stat failure) ⇒ now.
        assert_eq!(viewed_stamp(1_000, None), 1_000);
    }

}
