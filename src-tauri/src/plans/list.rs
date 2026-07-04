// The `list_plans` fan-in command + its head-read / unread-rule leaf helpers.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use crate::model::{PlanRecord, RawRow};
use crate::paths::{plans_dir, system_time_to_ms};
use crate::plans::arrange::arrange_plans;
use crate::plans::frontmatter::{extract_h1s, parse_marker, split_frontmatter};
use crate::plans::resume::{indexed_cwd_if_live, merge_synthetic_rows, synthesize_resume_rows};
use crate::state::app_state::AppState;
use crate::state::persist::{persist_collapse_state, persist_cwd_cache};

/// Read the plans dir, filter `*.md`, stat each, sort newest-first by mtime.
/// Missing or empty dir => empty list (UI shows empty-state, never errors).
/// Per-entry I/O errors skip that entry rather than failing the whole call.
///
/// Populates `cwd` from the in-memory cache (NO transcript scan here — that lives in
/// `resolve_cwds`, which must stay fast) and `unread` per the baseline / viewed / open-path
/// rules in `compute_unread`. Also reads a bounded head of each file, runs
/// `split_frontmatter` → `parse_marker`, builds raw rows, and delegates ordering +
/// flavor-normalization to the pure `arrange_plans`.
/// Collapse-state entries whose `tree_id` no longer appears in any record are pruned.
#[tauri::command]
pub fn list_plans(state: tauri::State<'_, Mutex<AppState>>) -> Vec<PlanRecord> {
    // Snapshot what we need from the lock, then release it before doing any I/O.
    let (cwd_cache, baseline_ms, viewed, open_path, collapse_state, data_dir, tree_cwd_index) = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.cwd_cache.clone(),
            guard.read_state.baseline_ms,
            guard.read_state.viewed.clone(),
            guard.open_path.clone(),
            guard.collapse_state.clone(),
            guard.data_dir.clone(),
            guard.tree_cwd_index.clone(),
        )
    };
    // Newly indexed (tree_id → cwd) resolutions discovered during this pass — folded into the
    // persisted cwd-cache at the end so the rest of the pipeline behaves as if the scan resolved
    // them (the index fast-path replaces the transcript scan for app-generated plan-tree plans,
    // which never emit a plan-write event into a `projects/` transcript).
    let mut newly_cached: HashMap<String, String> = HashMap::new();

    let Some(dir) = plans_dir() else {
        return Vec::new();
    };

    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Vec::new(), // dir missing / not yet created
    };

    let mut rows: Vec<RawRow> = Vec::new();

    for entry in read_dir.flatten() {
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md"))
            .unwrap_or(false);
        if !is_md {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // can't stat — skip
        };
        if !metadata.is_file() {
            continue;
        }
        let mtime = match metadata.modified() {
            Ok(t) => t,
            Err(_) => continue, // platform without mtime — skip
        };

        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let abs = path.to_string_lossy().to_string();
        let mtime_ms = system_time_to_ms(mtime);

        let mut cwd = cwd_cache.get(&stem).cloned();
        let unread = unread_for_row(
            &abs,
            mtime_ms,
            viewed.get(&abs).copied(),
            baseline_ms,
            open_path.as_deref(),
        );

        // Bounded head-read: enough to capture the (line-1) frontmatter marker. A codepoint
        // split at the byte cap is harmless — the marker lives in the first ~5 lines, and the
        // lossy decode never panics on a split multibyte sequence.
        let head = read_head_string(&path, FRONTMATTER_HEAD_BYTES);
        // Split frontmatter once; the marker rides the yaml half and the H1 scan rides the
        // body half (which the old code discarded as `_body`). Near-zero added I/O — same
        // bounded head read that already runs on every entry / `plan-changed`.
        let (marker, h1s) = match head.as_deref() {
            Some(h) => {
                let (yaml, body) = split_frontmatter(h);
                (yaml.and_then(parse_marker), extract_h1s(body))
            }
            None => (None, Vec::new()),
        };

        // Index fast-path: an app-generated plan-tree plan carries a frontmatter `tree_id` but
        // emits NO plan-write event into a `projects/` transcript, so the scan returns "unknown".
        // If the index maps that tree_id to a still-existing dir, use it FIRST (it is
        // authoritative for these plans). Falling through preserves every transcript-resolving
        // plan unchanged. The hit also populates the cwd-cache so the rest of the pipeline (and
        // future `list_plans` calls before the cache load) behave as if the scan resolved it.
        if let Some(tid) = marker.as_ref().map(|m| m.tree_id.as_str()) {
            if let Some(indexed) = indexed_cwd_if_live(&tree_cwd_index, tid) {
                if cwd.as_deref() != Some(indexed.as_str()) {
                    newly_cached.insert(stem.clone(), indexed.clone());
                }
                cwd = Some(indexed);
            }
        }

        rows.push(RawRow {
            stem,
            absolute_path: abs,
            mtime_ms,
            cwd,
            unread,
            marker,
            h1s,
        });
    }

    // Synthetic-row suppression set, built from the RAW frontmatter markers BEFORE `arrange_plans`
    // consumes `rows`. `arrange_plans` NULLS an orphan sub's `tree_id` (sub file present,
    // master absent → reclassified Standalone, tree_id=None), so a set built from ARRANGED
    // `records[].tree_id` would miss that tree and wrongly synthesize a master ALONGSIDE the orphan
    // sub (a double row for one tree). Keying off the raw marker means ANY real plan file of ANY
    // flavor for a tree_id suppresses its synthetic row, regardless of arrange-time reclassification.
    let real_tree_ids: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|r| r.marker.as_ref().map(|m| m.tree_id.clone()))
        .collect();

    // Pure ordering + flavor-normalization.
    let records = arrange_plans(rows, &collapse_state);

    // A plan-tree mid-decompose can have a live `<cwd>/.plan-tree/state.json` but NO plan `.md`
    // file in `~/.claude/plans/` — so it has zero real rows here and would be INVISIBLE (its
    // resume banner unreachable). Synthesize a standalone master row for every NON-done tree in
    // the `tree-cwd-index` that has zero real rows (a real plan file for a tree_id always wins —
    // the zero-real-rows dedup). The sentinel `absolute_path` is `plan-tree-resume://<tree_id>`;
    // the frontend opens it specially (resume banner, no `read_plan_contents`). The suppression set
    // `real_tree_ids` was built from the RAW markers above (see the comment there) — NOT from
    // arranged `records[].tree_id`, which nulls an orphan sub's tree_id and would double-render.
    let synthetic = synthesize_resume_rows(
        &tree_cwd_index,
        &real_tree_ids,
        open_path.as_deref(),
        &viewed,
        baseline_ms,
    );
    let records = merge_synthetic_rows(records, synthetic);

    // Prune collapse-state entries whose tree_id no longer appears in ANY record (keeps the
    // persisted file from accumulating dead trees). Cheap — the full record set is in hand.
    let live_tree_ids: std::collections::HashSet<&str> = records
        .iter()
        .filter_map(|r| r.tree_id.as_deref())
        .collect();
    let stale: Vec<String> = collapse_state
        .keys()
        .filter(|k| !live_tree_ids.contains(k.as_str()))
        .cloned()
        .collect();
    if !stale.is_empty() {
        let snapshot = {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            for k in &stale {
                guard.collapse_state.remove(k);
            }
            guard.collapse_state.clone()
        };
        persist_collapse_state(&data_dir, &snapshot);
    }

    // Fold any index fast-path hits into the persisted cwd-cache (the same field successful scan
    // resolutions land in), so the cwd survives a relaunch and the rest of the pipeline is
    // unaffected. Cheap and only fires when the index actually resolved something new.
    if !newly_cached.is_empty() {
        let snapshot = {
            let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
            for (stem, cwd) in &newly_cached {
                guard.cwd_cache.insert(stem.clone(), cwd.clone());
            }
            guard.cwd_cache.clone()
        };
        persist_cwd_cache(&data_dir, &snapshot);
    }

    records
}

/// Bytes of the head of each plan file read by `list_plans` for marker detection. The marker
/// (YAML frontmatter) sits in the first few lines; ~8 KB is a generous bound that still keeps
/// `list_plans` cheap for the ~73 small files in a typical corpus.
pub(crate) const FRONTMATTER_HEAD_BYTES: usize = 8 * 1024;

/// Read up to `cap` bytes from the head of `path` and lossy-decode (mirrors
/// `read_plan_contents`' decode). Returns `None` on any I/O error (the file is simply
/// treated as having no marker). A codepoint split at the cap is harmless.
pub(crate) fn read_head_string(path: &Path, cap: usize) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; cap];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Sort plan records newest-first (largest `mtime_ms` at index 0). Extracted from
/// `list_plans` so the ordering invariant is unit-testable without touching the real
/// plans dir.
#[allow(dead_code)]
pub(crate) fn sort_newest_first(records: &mut [PlanRecord]) {
    records.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
}

/// Pure unread rule: a plan is unread iff its mtime is strictly newer than the effective
/// "last viewed" time. The effective time is the per-plan `viewed` stamp when present,
/// else the first-launch `baseline_ms`. So a pre-baseline plan with no view stamp is read;
/// a post-baseline (new / changed-after-seed) plan is unread.
pub(crate) fn compute_unread(mtime_ms: i64, viewed_ms: Option<i64>, baseline_ms: i64) -> bool {
    let effective = viewed_ms.unwrap_or(baseline_ms);
    mtime_ms > effective
}

/// Per-row unread decision for `list_plans`: the open plan is read by fiat (a plan being
/// live-edited while open must never re-bold), otherwise apply the baseline/viewed rule.
/// Pure so the fiat invariant is unit-testable without Tauri state injection.
pub(crate) fn unread_for_row(
    abs_path: &str,
    mtime_ms: i64,
    viewed_ms: Option<i64>,
    baseline_ms: i64,
    open_path: Option<&str>,
) -> bool {
    if open_path == Some(abs_path) {
        return false;
    }
    compute_unread(mtime_ms, viewed_ms, baseline_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use crate::model::{Flavor, RawFlavor};

    #[test]
    fn sort_puts_largest_mtime_first() {
        let mut records = vec![
            record_with_mtime("oldest", 100),
            record_with_mtime("newest", 300),
            record_with_mtime("middle", 200),
        ];
        sort_newest_first(&mut records);
        let order: Vec<&str> = records.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(order, vec!["newest", "middle", "oldest"]);
        // Explicit: index 0 carries the strictly-largest mtime.
        assert_eq!(records[0].mtime_ms, 300);
        assert!(records[0].mtime_ms > records[1].mtime_ms);
        assert!(records[1].mtime_ms > records[2].mtime_ms);
    }

    #[test]
    fn sort_newest_first_from_real_temp_file_mtimes() {
        // Fabricate real temp files with distinct, explicitly-set mtimes and confirm the
        // helper orders them newest-first.
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_sort_test_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");

        let mut records = Vec::new();
        for (stem, ms) in [("a", 1_000i64), ("b", 3_000), ("c", 2_000)] {
            let p = dir.join(format!("{stem}.md"));
            std::fs::write(&p, b"x").expect("write temp file");
            records.push(PlanRecord {
                absolute_path: p.to_string_lossy().to_string(),
                filename_stem: stem.to_string(),
                mtime_ms: ms,
                cwd: None,
                unread: false,
                flavor: Flavor::Standalone,
                tree_id: None,
                nn: None,
                nn_path: None,
                child_count: None,
                collapsed: false,
                h1s: Vec::new(),
                execution_model: None,
            });
        }

        sort_newest_first(&mut records);
        let order: Vec<&str> = records.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(order, vec!["b", "c", "a"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unread_when_mtime_newer_than_viewed() {
        // mtime strictly after the viewed stamp ⇒ unread.
        assert!(compute_unread(2_000, Some(1_000), 0));
    }

    #[test]
    fn read_when_mtime_equal_or_older_than_viewed() {
        // Equal ⇒ read (not strictly greater); older ⇒ read.
        assert!(!compute_unread(1_000, Some(1_000), 0));
        assert!(!compute_unread(500, Some(1_000), 0));
    }

    #[test]
    fn absent_entry_falls_back_to_baseline() {
        let baseline = 1_000;
        // No viewed entry, mtime BEFORE baseline ⇒ read (pre-existing plan).
        assert!(!compute_unread(500, None, baseline));
        // No viewed entry, mtime AFTER baseline ⇒ unread (new/changed after seed).
        assert!(compute_unread(1_500, None, baseline));
        // Exactly at baseline ⇒ read (not strictly greater).
        assert!(!compute_unread(1_000, None, baseline));
    }

    #[test]
    fn open_plan_is_read_by_fiat_even_when_mtime_newer() {
        let p = "/tmp/live.md";
        // mtime (3000) is strictly newer than the viewed stamp (1000) — normally unread.
        // But because p is the open plan, the fiat forces it read.
        assert!(
            !unread_for_row(p, 3_000, Some(1_000), 0, Some(p)),
            "the open plan must be read by fiat regardless of mtime > viewed"
        );
        // Sanity: clearing the open plan (None) ⇒ the SAME inputs now yield unread, proving
        // the fiat — not the clock — is what held it read.
        assert!(
            unread_for_row(p, 3_000, Some(1_000), 0, None),
            "with no open plan, mtime > viewed must be unread"
        );
        // And a DIFFERENT open plan does not protect p.
        assert!(unread_for_row(p, 3_000, Some(1_000), 0, Some("/tmp/other.md")));
    }

    /// A reader-equivalent of `read_plan_contents`'s strip step: read bytes, lossy-decode,
    /// return the body with any leading frontmatter stripped (the production command does
    /// exactly this after the containment guards, which a temp dir cannot satisfy).
    fn reader_body(path: &Path) -> String {
        let bytes = std::fs::read(path).expect("read");
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let (_m, body) = split_frontmatter(&content);
        body.to_string()
    }

    /// The list-side classification of a single file via its head: split + parse marker, then
    /// map to the closed flavor set via `arrange_plans` on a one-row corpus (with a master in
    /// the corpus so a sub is not orphan-demoted).
    fn list_side_flavor_of(path: &Path) -> Flavor {
        let head = read_head_string(path, FRONTMATTER_HEAD_BYTES).expect("head");
        let (yaml, _body) = split_frontmatter(&head);
        let marker = yaml.and_then(parse_marker);
        // To classify a `sub` without orphan-demotion, include a master of the same tree_id.
        let mut rows = vec![raw_row("the-file", 1_000, marker.clone())];
        if let Some(m) = &marker {
            if m.flavor == RawFlavor::Sub {
                rows.push(raw_row("companion-master", 500, Some(master_marker(&m.tree_id))));
            }
        }
        let out = arrange_plans(rows, &HashMap::new());
        out.iter()
            .find(|r| r.filename_stem == "the-file")
            .expect("the-file present")
            .flavor
    }

    #[test]
    fn two_read_paths_agree_for_marked_plan() {
        let dir = unique_dir("tworead");
        // A marked sub plan, mirroring the fixture shape.
        let marked = dir.join("humble-exploring-walrus.md");
        std::fs::write(
            &marked,
            "---\ntree_id: nested-sidebar-2026\nflavor: sub\nnn: 1\n---\n\n# Sub-Plan 01 — title\n\nbody\n",
        )
        .expect("write marked");

        // (a) The reader strips the marker → body starts with `#` (no leading `---`/tree_id).
        let body = reader_body(&marked);
        assert!(
            body.trim_start().starts_with('#'),
            "stripped body must start with a heading, got: {:?}",
            &body[..body.len().min(40)]
        );
        assert!(
            !body.contains("tree_id"),
            "stripped body must not contain the marker text"
        );

        // (b) The list head-parse classifies the SAME file as non-standalone.
        let flavor = list_side_flavor_of(&marked);
        assert_ne!(
            flavor,
            Flavor::Standalone,
            "the list path must classify a marked plan as non-standalone (got {flavor:?})"
        );
        assert_eq!(flavor, Flavor::Sub);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_read_paths_legacy_file_is_byte_unchanged_and_standalone() {
        let dir = unique_dir("tworead_legacy");
        let legacy = dir.join("old-plan.md");
        let original = "# Legacy Plan\n\nNo frontmatter here.\n\n---\n\nA mid-doc rule.\n";
        std::fs::write(&legacy, original).expect("write legacy");

        // Reader leaves a no-frontmatter file byte-for-byte unchanged.
        let body = reader_body(&legacy);
        assert_eq!(body, original, "legacy body must be byte-unchanged by the strip");

        // List path classifies it standalone.
        assert_eq!(list_side_flavor_of(&legacy), Flavor::Standalone);

        let _ = std::fs::remove_dir_all(&dir);
    }

}
