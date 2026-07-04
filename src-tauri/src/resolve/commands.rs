// The two transcript/cwd resolution commands (`resolve_cwds`, `read_plan_transcript`) plus the
// `tree_id` transcript fallback -- thin Tauri/async wrappers over the pure `scan` engine.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::paths::{is_within, plans_dir};
use crate::plans::frontmatter::{parse_marker, split_frontmatter};
use crate::plans::list::{read_head_string, FRONTMATTER_HEAD_BYTES};
use crate::plans::resume::indexed_cwd_if_live;
use crate::resolve::scan::{
    collect_transcripts, filter_transcript_lines, first_session_id, pick_transcript_source,
    projects_root, resolve_stem_path, resolve_stems, resolve_tree_session,
};
use crate::state::app_state::AppState;
use crate::state::persist::persist_cwd_cache;

/// Return shape for `read_plan_transcript`. snake_case JSON keys (no rename — matches the
/// `PlanRecord` convention). `found=false` with empty `lines` means no transcript authored the
/// requested stem (or its content yielded nothing); the frontend paints an explicit empty state.
#[derive(Serialize, Clone, Debug, Default)]
pub(crate) struct PlanTranscript {
    found: bool,
    path: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
    lines: Vec<String>,
}

/// Reconstruct a plan's authoring conversation: locate the transcript that wrote `stem` (the
/// SAME provenance ranking as cwd resolution, via `resolve_stem_path`) and return its
/// server-filtered (`user`/`assistant`, non-meta) jsonl lines in file order, plus the matched
/// path, cwd, and session id. Unmatched ⇒ `{ found:false, lines:[] }`. The matched path is
/// canonicalized and containment-guarded against the canonical projects root before any read
/// (mirrors `read_plan_contents`). The CLI-record → `AgentStream` transform lives in TS
/// (`src/conversation/history.ts`) — only raw lines cross this boundary.
///
/// PRIMARY resolution is the provenance scan (`resolve_stem_path`), which covers CLI-authored /
/// plan-mode plans. When the scan misses AND the plan's frontmatter carries a `tree_id`
/// (app-authored `agent-plan-tree-*` plans emit NO plan-write event), a FALLBACK resolves the
/// session via the `tree_id → cwd` index (`tree_cwd_index`) + `<cwd>/.plan-tree/state.json`'s
/// `sdk_session_id` (filename match) — see `resolve_tree_session`. A genuinely transcript-less
/// plan still yields `{ found:false }`.
#[tauri::command]
pub async fn read_plan_transcript(
    stem: String,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<PlanTranscript, String> {
    // Run the blocking corpus scan off the main thread (mirrors `resolve_cwds`). We never touch
    // the std Mutex inside the closure, so it is not held across the await.
    let scan_stem = stem.clone();
    let matched: Option<(PathBuf, Option<String>)> =
        tauri::async_runtime::spawn_blocking(move || {
            let root = projects_root()?;
            let transcripts = collect_transcripts(&root);
            resolve_stem_path(&scan_stem, &transcripts)
        })
        .await
        .map_err(|e| format!("transcript scan failed: {e}"))?;

    // Scan-before-fallback ordering: a scan hit short-circuits and the `tree_id` fallback is
    // NEVER consulted (CLI-authored plans are unaffected). Only a scan MISS runs the
    // (async) fallback resolver. We pre-await the fallback ONLY on a miss, then apply the pure
    // `pick_transcript_source` ordering (the unit-tested short-circuit spec).
    let fallback_result: Option<(PathBuf, Option<String>)> = if matched.is_some() {
        None // not consulted on a scan hit
    } else {
        resolve_tree_fallback(&stem, &state).await?
    };
    let selected = pick_transcript_source(matched, || fallback_result);
    let Some((path, cwd)) = selected else {
        return Ok(PlanTranscript::default());
    };

    // Containment guard (mirrors `read_plan_contents`): canonicalize BOTH the projects root and
    // the matched path and verify the matched path lives inside the root before reading.
    let root = projects_root().ok_or_else(|| "could not locate home directory".to_string())?;
    let canon_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("projects dir unavailable: {e}"))?;
    let canon_path = std::fs::canonicalize(&path)
        .map_err(|e| format!("cannot resolve transcript path: {e}"))?;
    if !is_within(&canon_root, &canon_path) {
        return Err("transcript path is outside the projects directory".to_string());
    }

    let bytes = std::fs::read(&canon_path).map_err(|e| format!("read failed: {e}"))?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let all_lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let session_id = first_session_id(&all_lines);
    let lines = filter_transcript_lines(&all_lines);

    Ok(PlanTranscript {
        found: true,
        path: Some(canon_path.to_string_lossy().into_owned()),
        cwd,
        session_id,
        lines,
    })
}

/// The `tree_id` fallback for `read_plan_transcript`: read the plan file's frontmatter marker,
/// resolve its `tree_id` to a live cwd via the `tree_cwd_index`, then locate the session
/// transcript via `resolve_tree_session`. Returns `(transcript_path, Some(cwd))` on success.
///
/// State access discipline (mirrors `resolve_cwds`): the std `Mutex<AppState>` is locked ONLY to
/// clone the `tree_cwd_index` out; the lock is dropped before any blocking read or the
/// `spawn_blocking` boundary, so it is never held across `.await`.
pub(crate) async fn resolve_tree_fallback(
    stem: &str,
    state: &tauri::State<'_, Mutex<AppState>>,
) -> Result<Option<(PathBuf, Option<String>)>, String> {
    // 1) Read the plan file head and parse its frontmatter `tree_id`. No tree_id ⇒ genuinely
    //    transcript-less (keep the `found:false`).
    let Some(plans) = plans_dir() else {
        return Ok(None);
    };
    let plan_path = plans.join(format!("{stem}.md"));
    let Some(head) = read_head_string(&plan_path, FRONTMATTER_HEAD_BYTES) else {
        return Ok(None);
    };
    let (yaml, _body) = split_frontmatter(&head);
    let Some(tree_id) = yaml.and_then(parse_marker).map(|m| m.tree_id) else {
        return Ok(None);
    };

    // 2) Resolve cwd for the tree_id (lock, clone index out, drop lock — never held across await).
    let index = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.tree_cwd_index.clone()
    };
    let Some(cwd) = indexed_cwd_if_live(&index, &tree_id) else {
        return Ok(None);
    };

    // 3) Read `<cwd>/.plan-tree/state.json` (absent/malformed tolerated → None).
    let tree_id_for_blk = tree_id.clone();
    let cwd_for_blk = cwd.clone();
    let resolved: Option<(PathBuf, String)> = tauri::async_runtime::spawn_blocking(move || {
        let state_path = Path::new(&cwd_for_blk).join(".plan-tree").join("state.json");
        let state_json: Option<Value> = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());

        // 4) Locate the transcript via the tree_id link.
        let root = projects_root()?;
        let transcripts = collect_transcripts(&root);
        resolve_tree_session(&tree_id_for_blk, &cwd_for_blk, &transcripts, state_json.as_ref())
    })
    .await
    .map_err(|e| format!("tree-id transcript resolution failed: {e}"))?;

    Ok(resolved.map(|(path, _session_id)| (path, Some(cwd))))
}

/// Resolve the cwd for the requested still-unknown `stems` in ONE corpus pass. Async: the
/// blocking scan runs on `spawn_blocking` so the (potentially thousands of files) pass never
/// blocks the main thread or other commands. Updates the in-memory cache + atomically
/// persists `cwd-cache.json` for the `Some` results, and returns the full requested map
/// (incl. `None` for unresolved stems).
#[tauri::command]
pub async fn resolve_cwds(
    stems: Vec<String>,
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<HashMap<String, Option<String>>, String> {
    if stems.is_empty() {
        return Ok(HashMap::new());
    }

    // Index fast-path (mirrors `list_plans`): an app-generated plan-tree plan carries a
    // frontmatter `tree_id` but emits NO plan-write event into a `projects/` transcript, so the
    // scan can never resolve it. Read each requested stem's frontmatter marker; if the index maps
    // its tree_id to a still-existing dir, resolve it WITHOUT a scan. Stems we can't resolve this
    // way fall through to the unchanged transcript scan, so no currently-resolving plan regresses.
    let index = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.tree_cwd_index.clone()
    };
    let mut indexed: HashMap<String, String> = HashMap::new();
    if !index.is_empty() {
        if let Some(plans) = plans_dir() {
            for stem in &stems {
                let path = plans.join(format!("{stem}.md"));
                let Some(head) = read_head_string(&path, FRONTMATTER_HEAD_BYTES) else {
                    continue;
                };
                let (yaml, _body) = split_frontmatter(&head);
                let Some(tid) = yaml.and_then(parse_marker).map(|m| m.tree_id) else {
                    continue;
                };
                if let Some(cwd) = indexed_cwd_if_live(&index, &tid) {
                    indexed.insert(stem.clone(), cwd);
                }
            }
        }
    }

    // Only stems the index did NOT resolve go to the (blocking, off-thread) transcript scan.
    let scan_stems: Vec<String> = stems
        .iter()
        .filter(|s| !indexed.contains_key(*s))
        .cloned()
        .collect();

    // Run the blocking corpus scan off the main thread. We do NOT hold the std Mutex across
    // this await (we don't touch it inside the closure at all).
    let scanned = if scan_stems.is_empty() {
        HashMap::new()
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            let Some(root) = projects_root() else {
                // No projects root ⇒ everything unresolved.
                return scan_stems.iter().map(|s| (s.clone(), None)).collect();
            };
            let transcripts = collect_transcripts(&root);
            resolve_stems(&scan_stems, &transcripts)
        })
        .await
        .map_err(|e| format!("resolve scan failed: {e}"))?
    };

    // Merge: index hits (authoritative) over scan results, keeping the full requested key set.
    let mut resolved: HashMap<String, Option<String>> = scanned;
    for (stem, cwd) in indexed {
        resolved.insert(stem, Some(cwd));
    }

    // Update the in-memory cache for the Some results, snapshot it, release the lock.
    let (cache_snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        for (stem, cwd) in &resolved {
            if let Some(c) = cwd {
                guard.cwd_cache.insert(stem.clone(), c.clone());
            }
        }
        (guard.cwd_cache.clone(), guard.data_dir.clone())
    };
    // Persist outside the lock.
    persist_cwd_cache(&data_dir, &cache_snapshot);

    Ok(resolved)
}
