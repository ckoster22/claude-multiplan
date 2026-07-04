// Control-dir lifecycle: the `app.alive` heartbeat, orphaned-control-file pruning, the one-time
// tree-cwd backfill, and the debounced watcher over `requests/` that emits review
// requested/cancelled events. The plans-dir watcher lives in `watcher`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use notify_debouncer_full::DebounceEventResult;
use tauri::{Emitter, Manager};

use crate::model::{ReviewCancelled, ReviewRequest, ReviewRequested};
use crate::paths::{app_alive_path, plan_reader_dir, requests_dir, responses_dir, valid_review_id};
use crate::plans::resume::tree_id_from_state_json;
use crate::review::is_ignored_control_filename;
use crate::state::app_state::AppState;
use crate::state::persist::persist_tree_cwd_index;

/// Max age (seconds) before a control file (a `requests/`/`responses/` entry) is considered an
/// orphan and pruned. A live review never lives this long (the hook deadline is 570s and the
/// app responds far sooner), so anything older is from a SIGKILLed/timed-out hook.
const CONTROL_FILE_MAX_AGE_SECS: u64 = 600;

/// Best-effort prune of orphaned control files. Deletes any entry in `requests_dir()` /
/// `responses_dir()` whose mtime is older than `CONTROL_FILE_MAX_AGE_SECS`. This intentionally
/// includes `.tmp-…` and other dotfiles — stale temps are exactly the orphans we want to age
/// out. `app.alive` lives in `plan_reader_dir()` (not requests/responses), so it is never
/// touched. Every error is swallowed (panic-safe): a failed prune just leaves the file for the
/// next tick.
pub(crate) fn prune_stale_control_files() {
    let now = SystemTime::now();
    for dir in [requests_dir(), responses_dir()].into_iter().flatten() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue; // dir not yet created ⇒ nothing to prune
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            let age = now.duration_since(mtime).unwrap_or(Duration::ZERO);
            if age.as_secs() > CONTROL_FILE_MAX_AGE_SECS {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Spawn the heartbeat thread: touch `app.alive` every 5s so the hook knows the app is live.
/// Also opportunistically prunes orphaned control files (cheap — once per loop tick). Panic-safe
/// — directory creation and every write error are ignored (a missed heartbeat just makes the
/// hook fall through, which is the safe failure mode).
pub(crate) fn spawn_heartbeat() {
    std::thread::spawn(|| {
        if let Some(dir) = plan_reader_dir() {
            let _ = std::fs::create_dir_all(&dir);
        }
        loop {
            if let Some(path) = app_alive_path() {
                let _ = std::fs::write(&path, b"");
            }
            prune_stale_control_files();
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

// App-generated plan-tree plans predating this index have no `tree-cwd-index.json` entry, so
// their cwd would still resolve "unknown" until the next `state.json` write touches them. The
// backfill seeds the index ONCE at startup by walking the repo root for existing
// `<dir>/.plan-tree/state.json` ledgers and mapping each `tree_id → <dir>` (the cwd). It runs on
// a background thread so it never blocks startup, and is idempotent (re-running overwrites the
// same mappings).

/// The directory tree the backfill scans. Default `${HOME}/Documents/repos`; overridable via the
/// `PLAN_READER_BACKFILL_ROOT` env var (used by tests + power users). `None` only if neither the
/// env var nor `$HOME` is available.
pub(crate) fn backfill_root() -> Option<PathBuf> {
    if let Ok(root) = std::env::var("PLAN_READER_BACKFILL_ROOT") {
        if !root.is_empty() {
            return Some(PathBuf::from(root));
        }
    }
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(|home| PathBuf::from(home).join("Documents").join("repos"))
}

/// Directory names the backfill walk PRUNES (never descends into). `.archive` is included so an
/// archived (superseded) plan-tree is never indexed — only the live tree at the repo root wins.
const BACKFILL_PRUNE_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".archive"];

/// Max directory depth the backfill walk descends (root = depth 0). Bounds the hand-rolled walk
/// so a pathological tree can never run unbounded; ~8 is deep enough to reach any real project's
/// `.plan-tree` while skipping the pruned heavy dirs above.
const BACKFILL_MAX_DEPTH: usize = 8;

/// Pure backfill core: bounded recursive walk of `root` for `<dir>/.plan-tree/state.json` ledgers,
/// returning `tree_id → <dir>` (the cwd — the PARENT of `.plan-tree`). Hand-rolled with `std::fs`
/// (no `walkdir` dependency exists). PRUNES `BACKFILL_PRUNE_DIRS` (so `.archive`d trees are never
/// indexed) and caps recursion at `BACKFILL_MAX_DEPTH`. Best-effort throughout: unreadable dirs,
/// unreadable/unparseable `state.json`, and ledgers without a `tree_id` are skipped silently.
/// Deterministic last-writer-wins on a duplicate tree_id is acceptable — distinct live dirs
/// sharing one tree_id is not an expected state, and archived dirs are already pruned.
pub(crate) fn scan_plan_trees(root: &Path) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    walk_for_plan_trees(root, 0, &mut out);
    out
}

/// Recursion helper for `scan_plan_trees`. At each directory, if it is itself a `.plan-tree`
/// holding a `state.json` with a `tree_id`, record `tree_id → <parent-of-.plan-tree>`; then
/// descend into non-pruned subdirectories until `BACKFILL_MAX_DEPTH`.
fn walk_for_plan_trees(dir: &Path, depth: usize, out: &mut HashMap<String, String>) {
    if depth > BACKFILL_MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // unreadable dir ⇒ skip (best-effort)
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if BACKFILL_PRUNE_DIRS.contains(&name.as_ref()) {
            continue; // pruned (incl. .archive ⇒ archived trees never indexed)
        }
        if name == ".plan-tree" {
            // This IS a .plan-tree dir: harvest its state.json (the cwd is its parent).
            if let Some(cwd) = path.parent() {
                let state_json = path.join("state.json");
                if let Ok(content) = std::fs::read_to_string(&state_json) {
                    if let Some(tree_id) = tree_id_from_state_json(&content) {
                        out.insert(tree_id, cwd.to_string_lossy().to_string());
                    }
                }
            }
            // Do NOT descend into .plan-tree itself (its `.archive`/`prototype` are not roots).
            continue;
        }
        walk_for_plan_trees(&path, depth + 1, out);
    }
}

/// Spawn the one-time backfill on a background thread (NEVER blocks startup). Scans `backfill_root`,
/// merges the discovered `tree_id → cwd` mappings into the managed index, and persists ONCE. The
/// merge is idempotent and additive — existing entries are overwritten with the freshly scanned
/// live dir, and untouched tree_ids are preserved. Best-effort: a missing root or unavailable
/// managed state simply yields no merge.
pub(crate) fn spawn_backfill(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let Some(root) = backfill_root() else {
            return; // no root ⇒ nothing to backfill
        };
        let discovered = scan_plan_trees(&root);
        if discovered.is_empty() {
            return;
        }
        let state = app.state::<Mutex<AppState>>();
        let (snapshot, data_dir) = {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            for (tree_id, cwd) in discovered {
                guard.tree_cwd_index.insert(tree_id, cwd);
            }
            (guard.tree_cwd_index.clone(), guard.data_dir.clone())
        };
        persist_tree_cwd_index(&data_dir, &snapshot);
        println!("[backfill] tree-cwd index seeded ({} entries)", snapshot.len());
    });
}

/// Newtype wrapper so the control-dir debouncer can live in Tauri managed state alongside the
/// plans-dir debouncer. `app.manage` is keyed by TYPE; both debouncers share the same concrete
/// `Debouncer` type, so without distinct wrapper types the second `manage` would silently
/// collide with the first. This wrapper gives the control debouncer its own type key.
pub(crate) struct ControlWatcher<T>(#[allow(dead_code)] pub(crate) T);

/// Start the debounced watcher on the CONTROL dir (`requests/`, non-recursive). Emits
/// `plan-review-requested` on a created/modified `requests/<id>.json`, and
/// `plan-review-cancelled` on a removed one. SEPARATE from `start_watcher` — the plans-dir
/// watcher and its `plan-changed` path are untouched. Returns the live debouncer to keep alive.
pub(crate) fn start_control_watcher(app: tauri::AppHandle) -> Option<impl Sized> {
    let dir = requests_dir()?;

    let app_for_handler = app.clone();
    let mut debouncer = match new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errs) => {
                    for e in errs {
                        eprintln!("[control-watcher] debounce error: {e:?}");
                    }
                    return;
                }
            };

            for ev in events {
                let kind = ev.kind;
                let is_remove = matches!(kind, EventKind::Remove(_));
                let is_upsert = matches!(
                    kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
                );
                if !is_remove && !is_upsert {
                    continue;
                }
                for p in ev.paths.iter() {
                    let is_json = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("json"))
                        .unwrap_or(false);
                    if !is_json {
                        continue;
                    }
                    // Skip dotfiles / in-flight atomic-write temps.
                    let name = match p.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n,
                        None => continue,
                    };
                    if is_ignored_control_filename(name) {
                        continue;
                    }
                    // review_id is the file stem; validate before trusting it.
                    let review_id = match p.file_stem().and_then(|s| s.to_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    if !valid_review_id(&review_id) {
                        continue;
                    }

                    if is_remove {
                        let payload = ReviewCancelled {
                            review_id: review_id.clone(),
                        };
                        if let Err(e) = app_for_handler.emit("plan-review-cancelled", payload) {
                            eprintln!("[control-watcher] emit cancelled failed: {e:?}");
                        }
                        continue;
                    }

                    // Upsert: read + parse the request. On parse failure, no-op — the atomic
                    // rename's settled event (a later modify/create) will arrive with full JSON.
                    let bytes = match std::fs::read(p) {
                        Ok(b) => b,
                        Err(_) => continue,
                    };
                    let req: ReviewRequest = match serde_json::from_slice(&bytes) {
                        Ok(r) => r,
                        Err(_) => continue, // partial / unparseable ⇒ wait for the settled event
                    };
                    let payload = ReviewRequested {
                        review_id: review_id.clone(),
                        plan_text: req.plan_text,
                        plan_file_path: req.plan_file_path,
                    };
                    if let Err(e) = app_for_handler.emit("plan-review-requested", payload) {
                        eprintln!("[control-watcher] emit requested failed: {e:?}");
                    }
                }
            }
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[control-watcher] failed to create debouncer: {e:?}");
            return None;
        }
    };

    match debouncer.watch(&dir, RecursiveMode::NonRecursive) {
        Ok(()) => {
            println!("[control-watcher] watching {}", dir.display());
        }
        Err(e) => {
            eprintln!(
                "[control-watcher] could not watch {} (dir may not exist yet): {e:?}",
                dir.display()
            );
        }
    }

    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    /// BACKFILL: a temp root with `proj-a/.plan-tree/state.json` (tree_id "t1") and
    /// `proj-b/.plan-tree/.archive/state.json` (tree_id "t2") must yield t1→proj-a and must NOT
    /// contain t2 (the `.archive` subtree is pruned). FALSIFIABLE: if `.archive` were not pruned,
    /// t2 would appear; if the live ledger were missed, t1 would be absent.
    #[test]
    fn scan_plan_trees_indexes_live_and_prunes_archive() {
        let root = unique_dir("treeBackfill");

        // proj-a: a LIVE plan-tree.
        let a = root.join("proj-a").join(".plan-tree");
        std::fs::create_dir_all(&a).expect("mkdir proj-a/.plan-tree");
        std::fs::write(a.join("state.json"), r#"{"tree_id":"t1","phase":"done"}"#)
            .expect("write proj-a state.json");

        // proj-b: only an ARCHIVED ledger (must be pruned, never indexed).
        let b_archive = root.join("proj-b").join(".plan-tree").join(".archive");
        std::fs::create_dir_all(&b_archive).expect("mkdir proj-b/.plan-tree/.archive");
        std::fs::write(b_archive.join("state.json"), r#"{"tree_id":"t2","phase":"done"}"#)
            .expect("write proj-b archived state.json");

        // A pruned heavy dir holding a ledger must also be skipped (node_modules).
        let nm = root.join("node_modules").join("pkg").join(".plan-tree");
        std::fs::create_dir_all(&nm).expect("mkdir node_modules ledger");
        std::fs::write(nm.join("state.json"), r#"{"tree_id":"t3"}"#).expect("write nm ledger");

        // A live-shaped `.plan-tree` reachable only THROUGH an `.archive` ancestor: the `.archive`
        // prune must block the walk from descending here, so t4 is never indexed. This makes the
        // `.archive` entry in BACKFILL_PRUNE_DIRS load-bearing (falsifiable): drop it and the walk
        // descends through `.archive/` and harvests t4.
        let arch = root.join("proj-c").join(".archive").join("snap").join(".plan-tree");
        std::fs::create_dir_all(&arch).expect("mkdir proj-c archived snapshot");
        std::fs::write(arch.join("state.json"), r#"{"tree_id":"t4"}"#).expect("write t4 ledger");

        let index = scan_plan_trees(&root);

        assert_eq!(
            index.get("t1").map(String::as_str),
            Some(root.join("proj-a").to_string_lossy().as_ref()),
            "the live tree must map t1 → proj-a (parent of .plan-tree)"
        );
        assert!(
            !index.contains_key("t2"),
            "an archived (.archive) ledger must NOT be indexed; got {index:?}"
        );
        assert!(
            !index.contains_key("t3"),
            "a ledger under node_modules must be pruned; got {index:?}"
        );
        assert!(
            !index.contains_key("t4"),
            "a .plan-tree reachable only through an .archive ancestor must be pruned; got {index:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

}
