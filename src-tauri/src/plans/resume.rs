// Synthetic "resume" rows for plan-trees that have a live `state.json` but no plan `.md` file,
// plus the `state.json`-parsing leaves and the tree-cwd-index live lookup they share.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use crate::model::{Flavor, PlanRecord};
use crate::paths::system_time_to_ms;
use crate::plans::list::unread_for_row;

/// Extract a `tree_id` from `state.json` content (best-effort). Parses the JSON into a `Value`
/// and reads the top-level `tree_id` string. Returns `None` on any parse failure or a
/// missing/non-string `tree_id` — the caller (auto-capture / backfill) then skips silently and
/// NEVER fails its write. Pure; unit-testable without disk.
pub(crate) fn tree_id_from_state_json(content: &str) -> Option<String> {
    let value: Value = serde_json::from_str(content).ok()?;
    value
        .get("tree_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The indexed cwd for `tree_id`, but ONLY if the mapping exists AND still points at an
/// existing directory (a stale entry for a since-deleted/moved tree must fall through to the
/// transcript scan, never resolve to a dead path). Pure lookup over an in-hand snapshot.
pub(crate) fn indexed_cwd_if_live(index: &HashMap<String, String>, tree_id: &str) -> Option<String> {
    let cwd = index.get(tree_id)?;
    if Path::new(cwd).is_dir() {
        Some(cwd.clone())
    } else {
        None
    }
}

/// URI-scheme sentinel `absolute_path` for a SYNTHETIC sidebar row — a row the backend invents
/// for a plan-tree that has a live `state.json` but NO plan `.md` file in `~/.claude/plans/`
/// (a tree mid-decompose: visible so the resume banner can be reached). Form:
/// `plan-tree-resume://<tree_id>`.
///
/// This scheme can NEVER collide with a real `~/.claude/plans/*.md` path, and `read_plan_contents`
/// rejects it safely (its `std::fs::canonicalize` fails on a `plan-tree-resume://…` string, so the
/// containment guard never even runs — a synthetic path can never be mistaken for a real plan file
/// to read). The FRONTEND detects this prefix and treats the row specially (open → resume banner,
/// no `read_plan_contents` call). The `<tree_id>` suffix makes it stable + unambiguous per tree.
const RESUME_SENTINEL_SCHEME: &str = "plan-tree-resume://";

/// Mint the sentinel `absolute_path` for a synthetic resume row from a `tree_id`.
pub(crate) fn resume_sentinel_path(tree_id: &str) -> String {
    format!("{RESUME_SENTINEL_SCHEME}{tree_id}")
}

/// PURE port of the TS `treeIsDone` (src/conversation/plan-tree.ts): the tree is DONE iff the ROOT
/// has summarized — `root.state.stage != "open" && root.state.phase == "summarized"`. Reads the
/// parsed schema-2 `state.json` Value (`root.state.{stage,phase}` strings). Any missing/non-string
/// field reads as NOT done (a malformed/incomplete ledger is never treated as complete — the row is
/// kept visible rather than silently hidden).
///
/// CRITICAL parity case: the Phase-5 forced-acceptance window — the root rests in `split`/
/// `running-children` (NOT `summarized`) — MUST return false (not done), exactly as the TS does
/// (`treeIsDone` is false there because the phase is running-children, not summarized).
pub(crate) fn tree_is_done(state_json: &Value) -> bool {
    let state = match state_json.get("root").and_then(|r| r.get("state")) {
        Some(s) => s,
        None => return false,
    };
    let stage = state.get("stage").and_then(|v| v.as_str());
    let phase = state.get("phase").and_then(|v| v.as_str());
    // LITERAL PORT of the TS `treeIsDone`: `root.state.stage !== "open" && root.state.phase ===
    // "summarized"`. A stage-LESS ledger (`stage` is `None`) is done iff summarized, exactly as the
    // TS yields (`undefined !== "open"` is true).
    stage != Some("open") && phase == Some("summarized")
}

/// Best-effort `root.title` from a parsed `state.json` Value — the human title the synthetic
/// resume row displays. Absent/non-string ⇒ `None` (the caller supplies a fallback).
pub(crate) fn root_title_from_state_json(state_json: &Value) -> Option<String> {
    state_json
        .get("root")
        .and_then(|r| r.get("title"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Best-effort top-level `created_ms` from a parsed `state.json` Value — the STABLE sort key for a
/// synthetic resume row (see `synthesize_resume_rows`). Absent/non-integer ⇒ `None`.
pub(crate) fn created_ms_from_state_json(state_json: &Value) -> Option<i64> {
    state_json
        .get("created_ms")
        .and_then(|v| v.as_i64())
}

/// PURE synthesis core (unit-testable without Tauri state): for every `tree_id → cwd` in the loaded
/// `tree-cwd-index` that has ZERO real rows AND a live, parseable, NON-done `<cwd>/.plan-tree/
/// state.json`, mint exactly ONE synthetic `master` `PlanRecord` so a plan-file-less tree mid-
/// decompose is still visible (and its resume banner reachable). Returns the synthetic rows;
/// the caller merges them into the arranged real rows by recency.
///
/// DEDUP RULE — "zero real rows wins": a real plan `.md` file for a tree_id ALWAYS suppresses its
/// synthetic row (passed in via `real_tree_ids`). We deliberately do NOT adopt orphan subs: even a
/// childless real sub for that tree_id counts as a real row (its tree_id is in `real_tree_ids`), so
/// the master is not synthesized — there is already SOMETHING in the sidebar to open.
///
/// SORT KEY = ledger `created_ms` (NOT the state.json file mtime): created_ms is stable across the
/// frequent `persist` rewrites, so the synthetic row does not churn to the top of the recency-
/// sorted sidebar on every poll. Falls back to the state.json file mtime only when created_ms is
/// absent (an old/sketch ledger).
///
/// `read_state` is `(open_path, viewed, baseline_ms)` so the synthetic row's `unread`/open-by-fiat
/// follow the SAME rules as a real row (keyed by the sentinel `absolute_path`).
pub(crate) fn synthesize_resume_rows(
    tree_cwd_index: &HashMap<String, String>,
    real_tree_ids: &std::collections::HashSet<String>,
    open_path: Option<&str>,
    viewed: &HashMap<String, i64>,
    baseline_ms: i64,
) -> Vec<PlanRecord> {
    let mut out: Vec<PlanRecord> = Vec::new();
    for (tree_id, cwd) in tree_cwd_index {
        // Zero-real-rows dedup: a real plan file (master OR sub) for this tree_id always wins.
        if real_tree_ids.contains(tree_id) {
            continue;
        }
        let state_path = Path::new(cwd).join(".plan-tree").join("state.json");
        let content = match std::fs::read_to_string(&state_path) {
            Ok(c) => c,
            Err(_) => continue, // no state.json on disk ⇒ nothing to resume
        };
        let value: Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue, // unparseable ⇒ skip silently
        };
        // Reused-cwd ghost guard: the index can hold a STALE `tree_id → cwd` entry after
        // a re-genesis (orchestrator archives the old tree, starts a new tree_id in the SAME cwd).
        // The cwd's `state.json` now describes the NEW tree, so without this check we'd mint a ghost
        // sentinel for the OLD tree_id reading the NEW tree's ledger. Only synthesize when the
        // ledger's own top-level `tree_id` matches the index KEY (the tree this entry claims to be).
        if value.get("tree_id").and_then(|v| v.as_str()) != Some(tree_id.as_str()) {
            continue;
        }
        if tree_is_done(&value) {
            continue; // a completed tree needs no resume row
        }
        // STABLE sort key: ledger created_ms; fall back to the file mtime only when absent.
        let mtime_ms = created_ms_from_state_json(&value).unwrap_or_else(|| {
            std::fs::metadata(&state_path)
                .and_then(|m| m.modified())
                .map(system_time_to_ms)
                .unwrap_or(0)
        });
        let abs = resume_sentinel_path(tree_id);
        let unread = unread_for_row(&abs, mtime_ms, viewed.get(&abs).copied(), baseline_ms, open_path);
        let title = root_title_from_state_json(&value).unwrap_or_else(|| tree_id.clone());
        out.push(PlanRecord {
            absolute_path: abs,
            // The stem is display-incidental for a synthetic row (the frontend renders `title`);
            // use the tree_id so it is stable + collision-free among synthetic rows.
            filename_stem: tree_id.clone(),
            mtime_ms,
            cwd: Some(cwd.clone()),
            unread,
            flavor: Flavor::Master,
            tree_id: Some(tree_id.clone()),
            nn: None,
            nn_path: None,
            // A synthetic master has no on-disk children rows of its own.
            child_count: Some(0),
            collapsed: false,
            // The title rides `h1s` (the sidebar filter / display reads it the same as a real
            // master's H1) — a synthetic row has no file body to scan.
            h1s: vec![title],
            execution_model: None,
        });
    }
    out
}

/// Merge synthetic resume rows into the arranged real records, preserving each real master's
/// children contiguously beneath it while interleaving the (childless) synthetic masters by
/// recency. The arranged `records` are already in display order (master, its children…, next
/// top-level…); we re-group them into top-level GROUPS (a master + trailing subs, or a lone
/// standalone), tag each synthetic row as its own single-row group, then sort GROUPS by recency
/// DESC, stem ASC — the exact tie-break `arrange_plans` uses for top-level entries — and flatten.
/// A real master's group recency is its own `mtime_ms` (which `arrange_plans` already set to the
/// max of master + children mtimes).
pub(crate) fn merge_synthetic_rows(records: Vec<PlanRecord>, synthetic: Vec<PlanRecord>) -> Vec<PlanRecord> {
    if synthetic.is_empty() {
        return records;
    }
    struct Group {
        recency: i64,
        stem: String,
        rows: Vec<PlanRecord>,
    }
    let mut groups: Vec<Group> = Vec::new();
    for rec in records {
        // A sub continues the current (master) group; anything else opens a new group.
        if rec.flavor == Flavor::Sub {
            if let Some(g) = groups.last_mut() {
                g.rows.push(rec);
                continue;
            }
            // Defensive: a leading sub with no preceding master (should not happen) becomes its
            // own group rather than being dropped.
        }
        groups.push(Group {
            recency: rec.mtime_ms,
            stem: rec.filename_stem.clone(),
            rows: vec![rec],
        });
    }
    for syn in synthetic {
        groups.push(Group {
            recency: syn.mtime_ms,
            stem: syn.filename_stem.clone(),
            rows: vec![syn],
        });
    }
    groups.sort_by(|a, b| b.recency.cmp(&a.recency).then_with(|| a.stem.cmp(&b.stem)));
    groups.into_iter().flat_map(|g| g.rows).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::plans::arrange::arrange_plans;

    /// READ FAST-PATH: `indexed_cwd_if_live` returns the indexed cwd when the dir EXISTS, and falls
    /// through (None — no crash) when the dir does NOT exist. This is the exact gate `list_plans` /
    /// `resolve_cwds` apply before the transcript scan. FALSIFIABLE: the missing-dir case must be
    /// None — if the existence check were dropped it would return the dead path.
    #[test]
    fn indexed_cwd_if_live_resolves_existing_falls_back_on_missing() {
        let live = unique_dir("treeLive"); // a real, existing directory
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("t-live".to_string(), live.to_string_lossy().to_string());
        index.insert(
            "t-dead".to_string(),
            live.join("does-not-exist").to_string_lossy().to_string(),
        );

        // Present + existing dir ⇒ the indexed cwd (no transcript needed).
        assert_eq!(
            indexed_cwd_if_live(&index, "t-live"),
            Some(live.to_string_lossy().to_string()),
            "an indexed tree_id pointing at an existing dir must resolve to it"
        );
        // Present but the dir is GONE ⇒ None (fall through to the scan; never a dead path / crash).
        assert_eq!(
            indexed_cwd_if_live(&index, "t-dead"),
            None,
            "an indexed tree_id whose dir no longer exists must fall through (None)"
        );
        // Absent tree_id ⇒ None.
        assert_eq!(indexed_cwd_if_live(&index, "t-absent"), None);

        let _ = std::fs::remove_dir_all(&live);
    }

    /// Build a `state.json` Value with a given root `(stage, phase)` and a `created_ms` / `title`.
    fn resume_state_json(stage: &str, phase: &str, created_ms: i64, title: &str) -> Value {
        serde_json::json!({
            "schema": 2,
            "tree_id": "ignored-here",
            "created_ms": created_ms,
            "updated_ms": created_ms + 5,
            "root": { "nn": 1, "title": title, "state": { "stage": stage, "phase": phase } }
        })
    }

    /// THE SHARED PARITY VECTOR mirroring the TS `treeIsDone` truth table:
    /// done iff `stage != "open" && phase == "summarized"`. The acceptance-window case
    /// (`split`/`running-children`, NOT summarized) is explicitly NOT done.
    fn tree_is_done_parity_vector() -> Vec<((&'static str, &'static str), bool)> {
        vec![
            // open stage is NEVER done (even with a "summarized"-shaped phase, which is unrepresentable).
            (("open", "clarifying-intent"), false),
            (("open", "prototype-review"), false),
            (("open", "pending"), false),
            (("open", "recon"), false),
            (("open", "sizing"), false),
            (("open", "decomposing"), false),
            (("open", "awaiting-decomposition-approval"), false),
            // leaf: done ONLY when summarized.
            (("leaf", "drafting"), false),
            (("leaf", "awaiting-approval"), false),
            (("leaf", "executing"), false),
            (("leaf", "summarized"), true),
            // split: done ONLY when summarized.
            (("split", "running-children"), false), // <-- Phase-5 acceptance window = NOT done
            (("split", "reviewing"), false),
            (("split", "summarized"), true),
        ]
    }

    #[test]
    fn tree_is_done_matches_ts_parity_vector() {
        for ((stage, phase), expected) in tree_is_done_parity_vector() {
            let v = resume_state_json(stage, phase, 1_000, "T");
            assert_eq!(
                tree_is_done(&v),
                expected,
                "tree_is_done({stage}/{phase}) should be {expected} (TS treeIsDone parity)"
            );
        }
    }

    #[test]
    fn tree_is_done_acceptance_window_is_not_done() {
        // The forced-acceptance hold: root rests split/running-children (NOT summarized) — must be
        // reported NOT done so the synthetic row stays visible until a verdict is recorded.
        let v = resume_state_json("split", "running-children", 1_000, "T");
        assert!(!tree_is_done(&v), "acceptance window (running-children) must not read done");
    }

    #[test]
    fn tree_is_done_malformed_ledger_is_not_done() {
        // No `root` / missing state fields ⇒ never treated as complete (kept visible).
        assert!(!tree_is_done(&serde_json::json!({})));
        assert!(!tree_is_done(&serde_json::json!({ "root": {} })));
        // A `state` with NEITHER stage nor phase is not summarized ⇒ not done.
        assert!(!tree_is_done(&serde_json::json!({ "root": { "state": {} } })));
    }

    #[test]
    fn tree_is_done_stageless_summarized_is_done_ts_parity() {
        // LITERAL TS PORT: `stage !== "open" && phase === "summarized"`. A stage-LESS ledger
        // (`stage` absent) that is `summarized` IS done — `undefined !== "open"` is true in TS, so
        // Rust must agree.
        let v = serde_json::json!({ "root": { "state": { "phase": "summarized" } } });
        assert!(
            tree_is_done(&v),
            "stage-less + summarized must read DONE for TS treeIsDone parity"
        );
    }

    /// Write `<cwd>/.plan-tree/state.json` with the given content and return the cwd dir.
    fn write_state_json(cwd: &Path, content: &str) {
        let pt = cwd.join(".plan-tree");
        std::fs::create_dir_all(&pt).expect("mkdir .plan-tree");
        std::fs::write(pt.join("state.json"), content).expect("write state.json");
    }

    #[test]
    fn synthesize_resume_row_for_plan_file_less_non_done_tree() {
        let cwd = unique_dir("synthNonDone");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-A","created_ms":1717000000000,"root":{"title":"Resume me","state":{"stage":"split","phase":"running-children"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-A".to_string(), cwd.to_string_lossy().to_string());

        // No real rows for tree-A.
        let real: std::collections::HashSet<String> = std::collections::HashSet::new();
        let viewed: HashMap<String, i64> = HashMap::new();
        let rows = synthesize_resume_rows(&index, &real, None, &viewed, 0);

        assert_eq!(rows.len(), 1, "exactly one synthetic row for a plan-file-less non-done tree");
        let r = &rows[0];
        assert_eq!(r.absolute_path, "plan-tree-resume://tree-A", "sentinel scheme path");
        assert_eq!(r.flavor, Flavor::Master);
        assert_eq!(r.tree_id.as_deref(), Some("tree-A"));
        assert_eq!(r.cwd.as_deref(), Some(cwd.to_string_lossy().as_ref()), "cwd from the index");
        assert_eq!(r.mtime_ms, 1_717_000_000_000, "sort key = ledger created_ms");
        assert_eq!(r.h1s, vec!["Resume me".to_string()], "title rides h1s from root.title");
        assert!(r.unread, "post-baseline, never-viewed ⇒ unread");

        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn synthetic_row_suppressed_once_a_real_plan_file_exists() {
        let cwd = unique_dir("synthSuppressed");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-B","created_ms":1717000000000,"root":{"title":"T","state":{"stage":"split","phase":"running-children"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-B".to_string(), cwd.to_string_lossy().to_string());

        // A real row for tree-B exists ⇒ zero-real-rows dedup suppresses the synthetic row.
        let mut real: std::collections::HashSet<String> = std::collections::HashSet::new();
        real.insert("tree-B".to_string());
        let viewed: HashMap<String, i64> = HashMap::new();
        let rows = synthesize_resume_rows(&index, &real, None, &viewed, 0);

        assert!(rows.is_empty(), "a real plan file for tree-B must suppress its synthetic row");
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn acceptance_window_tree_is_synthesized_not_hidden() {
        // running-children (acceptance window) is NOT done ⇒ must still be synthesized.
        let cwd = unique_dir("synthAcceptance");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-C","created_ms":1717000000000,"root":{"title":"Accept","state":{"stage":"split","phase":"running-children"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-C".to_string(), cwd.to_string_lossy().to_string());
        let real: std::collections::HashSet<String> = std::collections::HashSet::new();
        let viewed: HashMap<String, i64> = HashMap::new();
        let rows = synthesize_resume_rows(&index, &real, None, &viewed, 0);
        assert_eq!(rows.len(), 1, "an acceptance-window tree must NOT be hidden");
        assert_eq!(rows[0].tree_id.as_deref(), Some("tree-C"));
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn done_tree_yields_no_synthetic_row() {
        let cwd = unique_dir("synthDone");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-D","created_ms":1717000000000,"root":{"title":"Done","state":{"stage":"split","phase":"summarized"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-D".to_string(), cwd.to_string_lossy().to_string());
        let real: std::collections::HashSet<String> = std::collections::HashSet::new();
        let viewed: HashMap<String, i64> = HashMap::new();
        let rows = synthesize_resume_rows(&index, &real, None, &viewed, 0);
        assert!(rows.is_empty(), "a DONE (summarized) tree needs no synthetic resume row");
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn synthesize_skips_tree_without_state_json_on_disk() {
        // Index points at a dir with NO .plan-tree/state.json ⇒ nothing to synthesize.
        let cwd = unique_dir("synthNoState");
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-E".to_string(), cwd.to_string_lossy().to_string());
        let real: std::collections::HashSet<String> = std::collections::HashSet::new();
        let viewed: HashMap<String, i64> = HashMap::new();
        assert!(
            synthesize_resume_rows(&index, &real, None, &viewed, 0).is_empty(),
            "a tree with no state.json on disk must not be synthesized"
        );
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn orphan_sub_does_not_double_render_with_a_synthetic_master() {
        // Regression: a tree whose ONLY real plan file is an orphan SUB (`.md` for a sub,
        // master `.md` absent) is reclassified Standalone by `arrange_plans`, which NULLS its
        // tree_id. The suppression set MUST be built from the RAW markers (this mirrors `list_plans`)
        // so the orphan-sub tree is still recognized as "has a real row" and NO synthetic master is
        // minted alongside it. Building the set from ARRANGED records (the old, buggy way) would miss
        // it (tree_id=None) and produce a SECOND row for the same tree.
        let cwd = unique_dir("synthOrphanSub");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-orphan","created_ms":1717000000000,"root":{"title":"Orphan","state":{"stage":"split","phase":"running-children"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        index.insert("tree-orphan".to_string(), cwd.to_string_lossy().to_string());

        // The only real row: an orphan SUB for tree-orphan (no master file present).
        let rows = vec![raw_row("01-orphan", 100, Some(sub_marker("tree-orphan", 1)))];

        // Production suppression set: built from RAW markers (the fix), BEFORE arrange consumes rows.
        let real_from_raw: std::collections::HashSet<String> = rows
            .iter()
            .filter_map(|r| r.marker.as_ref().map(|m| m.tree_id.clone()))
            .collect();
        assert!(
            real_from_raw.contains("tree-orphan"),
            "raw-marker set must contain the orphan sub's tree_id"
        );

        let arranged = arrange_plans(rows, &HashMap::new());
        // The orphan sub still renders today: a single Standalone row with tree_id NULLED.
        assert_eq!(arranged.len(), 1, "orphan sub still renders as one row");
        assert_eq!(arranged[0].flavor, Flavor::Standalone, "orphan sub ⇒ standalone");
        assert_eq!(arranged[0].tree_id, None, "arrange_plans nulls the orphan sub's tree_id");

        // FALSIFIABILITY: the OLD buggy set (built from arranged records) misses tree-orphan and the
        // synthetic master IS minted — proving the raw-marker set is load-bearing.
        let real_from_arranged: std::collections::HashSet<String> = arranged
            .iter()
            .filter_map(|r| r.tree_id.clone())
            .collect();
        let viewed: HashMap<String, i64> = HashMap::new();
        let buggy = synthesize_resume_rows(&index, &real_from_arranged, None, &viewed, 0);
        assert_eq!(
            buggy.len(),
            1,
            "old arranged-records set MUST double-render (RED-before evidence for the fix)"
        );

        // THE FIX: with the raw-marker set, the orphan-sub tree is suppressed (no synthetic master).
        let fixed = synthesize_resume_rows(&index, &real_from_raw, None, &viewed, 0);
        assert!(
            fixed.is_empty(),
            "raw-marker suppression set must prevent a synthetic master alongside the orphan sub"
        );

        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn reused_cwd_with_stale_index_key_skips_ghost_row() {
        // Regression: a re-genesised cwd (orchestrator archives the old tree, starts a new
        // tree_id in the SAME cwd) leaves a STALE `tree-old → /cwd` index entry. The cwd's state.json
        // now describes `tree-new`. Without the ledger-tree_id guard, synthesis emits a GHOST sentinel
        // for tree-old reading tree-new's ledger. The guard skips the stale key; the matching key for
        // the SAME cwd still synthesizes (one real, non-done tree to resume).
        let cwd = unique_dir("synthReusedCwd");
        write_state_json(
            &cwd,
            r#"{"tree_id":"tree-new","created_ms":1717000000000,"root":{"title":"New tree","state":{"stage":"split","phase":"running-children"}}}"#,
        );
        let mut index: HashMap<String, String> = HashMap::new();
        // STALE key (re-genesis left it behind) AND the current matching key — both point at the cwd.
        index.insert("tree-old".to_string(), cwd.to_string_lossy().to_string());
        index.insert("tree-new".to_string(), cwd.to_string_lossy().to_string());

        let real: std::collections::HashSet<String> = std::collections::HashSet::new();
        let viewed: HashMap<String, i64> = HashMap::new();
        let rows = synthesize_resume_rows(&index, &real, None, &viewed, 0);

        // Exactly ONE row, for tree-new — the stale tree-old key is skipped (no ghost).
        assert_eq!(rows.len(), 1, "stale index key must NOT produce a ghost synthetic row");
        assert_eq!(
            rows[0].tree_id.as_deref(),
            Some("tree-new"),
            "only the index key matching the ledger's own tree_id synthesizes"
        );

        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn merge_synthetic_rows_interleaves_by_recency_keeping_children_contiguous() {
        // A real master (recency 100) with one child, and a real standalone (recency 300).
        let real = vec![
            PlanRecord {
                absolute_path: "/p/m.md".into(),
                filename_stem: "m".into(),
                mtime_ms: 100,
                cwd: None,
                unread: false,
                flavor: Flavor::Master,
                tree_id: Some("real-tree".into()),
                nn: None,
                nn_path: None,
                child_count: Some(1),
                collapsed: false,
                h1s: vec![],
                execution_model: None,
            },
            PlanRecord {
                absolute_path: "/p/01-sub.md".into(),
                filename_stem: "01-sub".into(),
                mtime_ms: 90,
                cwd: None,
                unread: false,
                flavor: Flavor::Sub,
                tree_id: Some("real-tree".into()),
                nn: Some(1),
                nn_path: Some("01".into()),
                child_count: None,
                collapsed: false,
                h1s: vec![],
                execution_model: None,
            },
            PlanRecord {
                absolute_path: "/p/standalone.md".into(),
                filename_stem: "standalone".into(),
                mtime_ms: 300,
                cwd: None,
                unread: false,
                flavor: Flavor::Standalone,
                tree_id: None,
                nn: None,
                nn_path: None,
                child_count: None,
                collapsed: false,
                h1s: vec![],
                execution_model: None,
            },
        ];
        // A synthetic master with recency 200 — should land BETWEEN the standalone (300) and the
        // master (100), and the master's child must stay directly under it.
        let synthetic = vec![PlanRecord {
            absolute_path: "plan-tree-resume://syn".into(),
            filename_stem: "syn".into(),
            mtime_ms: 200,
            cwd: Some("/c".into()),
            unread: true,
            flavor: Flavor::Master,
            tree_id: Some("syn".into()),
            nn: None,
            nn_path: None,
            child_count: Some(0),
            collapsed: false,
            h1s: vec!["S".into()],
            execution_model: None,
        }];
        let out = merge_synthetic_rows(real, synthetic);
        let order: Vec<&str> = out.iter().map(|r| r.absolute_path.as_str()).collect();
        assert_eq!(
            order,
            vec!["/p/standalone.md", "plan-tree-resume://syn", "/p/m.md", "/p/01-sub.md"],
            "synthetic master interleaves by recency; real master keeps its child contiguous"
        );
    }

}
