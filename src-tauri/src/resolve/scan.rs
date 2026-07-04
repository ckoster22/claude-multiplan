// Pure cwd-corpus resolution engine: enumerate `~/.claude/projects` transcripts and rank
// stem->cwd matches by provenance. No Tauri, no app state -- unit-testable against a temp corpus.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::paths::system_time_to_ms;

/// Provenance of a stem→cwd match, in priority order. `PlanModeAttachment` is authoritative
/// and is NEVER downgraded by a later weaker match (preserved
/// per-stem across the single corpus pass).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Provenance {
    LineContains = 1,     // last resort
    WriteFilePath = 2,    // fallback
    PlanModeAttachment = 3, // authoritative
}

/// A resolved (or partially-resolved) stem entry built up across the corpus pass.
#[derive(Debug, Clone)]
pub(crate) struct Resolution {
    cwd: Option<String>,
    provenance: Provenance,
}

/// The projects transcript root (`~/.claude/projects`). Returns None if home is unlocatable.
pub(crate) fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// Enumerate every transcript file under `root`: top-level `<session>.jsonl` files AND
/// `<session>/subagents/agent-*.jsonl`. Takes the root as a parameter so tests can point it
/// at a fabricated temp corpus.
pub(crate) fn collect_transcripts(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(project_dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for proj in project_dirs.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&proj_path) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                    out.push(p.clone());
                }
                if p.is_dir() {
                    let sub = p.join("subagents");
                    if let Ok(subs) = std::fs::read_dir(&sub) {
                        for se in subs.flatten() {
                            let sp = se.path();
                            let is_agent_jsonl = sp
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|n| n.starts_with("agent-") && n.ends_with(".jsonl"))
                                .unwrap_or(false);
                            if is_agent_jsonl {
                                out.push(sp);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// First top-level `cwd` value found across the transcript's lines. (All records in one
/// transcript share the session cwd.)
pub(crate) fn first_cwd(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Extract a `Write` tool_use's `input.file_path` from a record, if present.
pub(crate) fn write_file_path(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?.as_array()?;
    for c in content {
        if c.get("type").and_then(|t| t.as_str()) == Some("tool_use")
            && c.get("name").and_then(|n| n.as_str()) == Some("Write")
        {
            if let Some(fp) = c
                .get("input")
                .and_then(|i| i.get("file_path"))
                .and_then(|f| f.as_str())
            {
                return Some(fp.to_string());
            }
        }
    }
    None
}

/// Order transcripts so the resolution pass is DETERMINISTIC and same-provenance ties resolve
/// to the most-recent session. `collect_transcripts` yields files in raw `read_dir` order
/// (unsorted, OS-dependent), and `offer` keeps the first-seen match on a provenance tie — so
/// without this sort a stem with two equally-authoritative (or two last-resort) matches in
/// different transcripts would resolve to whichever file `read_dir` happened to yield first,
/// which can differ across runs. We sort **newest-mtime-first** (a plan's "current" cwd is its
/// most recent session), breaking remaining ties by path descending for full determinism.
pub(crate) fn sort_transcripts_newest_first(transcripts: &mut [PathBuf]) {
    transcripts.sort_by(|a, b| {
        let ma = std::fs::metadata(a)
            .and_then(|m| m.modified())
            .map(system_time_to_ms)
            .unwrap_or(i64::MIN);
        let mb = std::fs::metadata(b)
            .and_then(|m| m.modified())
            .map(system_time_to_ms)
            .unwrap_or(i64::MIN);
        // mtime descending, then path descending (stable, fully deterministic tie-break).
        mb.cmp(&ma).then_with(|| b.cmp(a))
    });
}

/// Consider one matched-stem candidate against the running best for that stem. Records the
/// candidate only if it has strictly higher provenance than what's already there — so an
/// authoritative `plan_mode` match is never downgraded by a later `Write`/`LineContains`
/// match in another transcript, REGARDLESS of transcript visitation order. On a provenance
/// TIE the first-seen wins, which — because the pass visits transcripts newest-mtime-first
/// (see `sort_transcripts_newest_first`) — means the most-recent session's cwd wins.
pub(crate) fn offer(best: &mut HashMap<String, Resolution>, stem: &str, cand: Resolution) {
    match best.get(stem) {
        Some(existing) if existing.provenance >= cand.provenance => {
            // Keep the existing higher-or-equal-priority resolution (first-wins on ties).
        }
        _ => {
            best.insert(stem.to_string(), cand);
        }
    }
}

/// Single corpus pass: resolve the WHOLE set of requested `stems` against `transcripts`,
/// preserving per-stem provenance priority. Pure (takes the transcript list); reads each
/// file at most once. Returns the full requested map with `None` for unresolved stems.
pub(crate) fn resolve_stems(stems: &[String], transcripts: &[PathBuf]) -> HashMap<String, Option<String>> {
    // Pre-compute the `/plans/<stem>.md` suffix for every requested stem once.
    let suffixes: Vec<(String, String)> = stems
        .iter()
        .map(|s| (s.clone(), format!("/plans/{s}.md")))
        .collect();

    // Deterministic, newest-session-wins tie-break: sort an owned copy newest-mtime-first so
    // the pass order does NOT depend on how the caller (or `read_dir`) ordered the slice.
    let mut ordered: Vec<PathBuf> = transcripts.to_vec();
    sort_transcripts_newest_first(&mut ordered);

    let mut best: HashMap<String, Resolution> = HashMap::new();

    for fp in &ordered {
        let Ok(text) = std::fs::read_to_string(fp) else {
            continue;
        };

        // Which requested stems does this file even mention? Cheap pre-filter.
        let mentioned: Vec<&(String, String)> = suffixes
            .iter()
            .filter(|(_, suffix)| text.contains(suffix.as_str()))
            .collect();
        if mentioned.is_empty() {
            continue;
        }

        let session_cwd = first_cwd(&text);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            // Record-level cwd (falls back to the session cwd).
            let record_cwd = || {
                v.get("cwd")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| session_cwd.clone())
            };

            // (1) AUTHORITATIVE — plan_mode attachment.
            if let Some(att) = v.get("attachment") {
                if att.get("type").and_then(|t| t.as_str()) == Some("plan_mode") {
                    if let Some(pfp) = att.get("planFilePath").and_then(|p| p.as_str()) {
                        for (stem, suffix) in &mentioned {
                            if pfp.ends_with(suffix.as_str()) {
                                offer(
                                    &mut best,
                                    stem,
                                    Resolution {
                                        cwd: record_cwd(),
                                        provenance: Provenance::PlanModeAttachment,
                                    },
                                );
                            }
                        }
                    }
                }
            }

            // (2) FALLBACK — Write tool_use input.file_path.
            if let Some(fpath) = write_file_path(&v) {
                for (stem, suffix) in &mentioned {
                    if fpath.ends_with(suffix.as_str()) {
                        offer(
                            &mut best,
                            stem,
                            Resolution {
                                cwd: record_cwd(),
                                provenance: Provenance::WriteFilePath,
                            },
                        );
                    }
                }
            }
        }

        // (3) LAST RESORT — the file mentions a stem but no structured match was recorded
        // for it. Use the session cwd at the weakest priority (never downgrades a stronger
        // match thanks to `offer`).
        for (stem, _suffix) in &mentioned {
            offer(
                &mut best,
                stem,
                Resolution {
                    cwd: session_cwd.clone(),
                    provenance: Provenance::LineContains,
                },
            );
        }
    }

    // Materialize the FULL requested map (None for unresolved / cwd-less stems).
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    for s in stems {
        let resolved = best.get(s).and_then(|r| r.cwd.clone());
        out.insert(s.clone(), resolved);
    }
    out
}

/// The winning transcript candidate for a single stem: the matched file's path plus its
/// resolved cwd and the provenance level that selected it. Internal to `resolve_stem_path`.
#[derive(Debug, Clone)]
struct StemPath {
    path: PathBuf,
    cwd: Option<String>,
    provenance: Provenance,
}

/// Locate the SINGLE transcript that authored `stem`, returning that file's `PathBuf` plus its
/// cwd. Runs the SAME provenance ranking as `resolve_stems` (3 = `plan_mode` attachment whose
/// `planFilePath` ends with `/plans/<stem>.md`; 2 = a `Write` tool_use whose `input.file_path`
/// matches; 1 = a bare substring mention), sharing `offer`/`Provenance`/`first_cwd`/
/// `write_file_path`. Highest provenance wins; ties break to the NEWEST-mtime transcript exactly
/// as `resolve_stems` does (we sort an owned copy newest-mtime-first and keep the first-seen
/// match on a tie). Returns `None` when no transcript mentions the stem.
pub(crate) fn resolve_stem_path(
    stem: &str,
    transcripts: &[PathBuf],
) -> Option<(PathBuf, Option<String>)> {
    let suffix = format!("/plans/{stem}.md");

    // Deterministic, newest-session-wins tie-break (mirrors resolve_stems): sort an owned copy
    // newest-mtime-first so the visitation order does NOT depend on the caller's slice order.
    let mut ordered: Vec<PathBuf> = transcripts.to_vec();
    sort_transcripts_newest_first(&mut ordered);

    let mut best: Option<StemPath> = None;

    // Local "offer" mirroring `offer`'s semantics but recording the winning PathBuf: a strictly
    // higher provenance replaces; on a tie the first-seen (newest-mtime) candidate is kept.
    let consider = |cand: StemPath, best: &mut Option<StemPath>| match best {
        Some(existing) if existing.provenance >= cand.provenance => {}
        _ => *best = Some(cand),
    };

    for fp in &ordered {
        let Ok(text) = std::fs::read_to_string(fp) else {
            continue;
        };
        if !text.contains(suffix.as_str()) {
            continue;
        }

        let session_cwd = first_cwd(&text);

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            let record_cwd = || {
                v.get("cwd")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| session_cwd.clone())
            };

            // (1) AUTHORITATIVE — plan_mode attachment.
            if let Some(att) = v.get("attachment") {
                if att.get("type").and_then(|t| t.as_str()) == Some("plan_mode") {
                    if let Some(pfp) = att.get("planFilePath").and_then(|p| p.as_str()) {
                        if pfp.ends_with(suffix.as_str()) {
                            consider(
                                StemPath {
                                    path: fp.clone(),
                                    cwd: record_cwd(),
                                    provenance: Provenance::PlanModeAttachment,
                                },
                                &mut best,
                            );
                        }
                    }
                }
            }

            // (2) FALLBACK — Write tool_use input.file_path.
            if let Some(fpath) = write_file_path(&v) {
                if fpath.ends_with(suffix.as_str()) {
                    consider(
                        StemPath {
                            path: fp.clone(),
                            cwd: record_cwd(),
                            provenance: Provenance::WriteFilePath,
                        },
                        &mut best,
                    );
                }
            }
        }

        // (3) LAST RESORT — the file mentions the stem but no structured match was recorded.
        consider(
            StemPath {
                path: fp.clone(),
                cwd: session_cwd.clone(),
                provenance: Provenance::LineContains,
            },
            &mut best,
        );
    }

    best.map(|b| (b.path, b.cwd))
}

/// Server-side transcript line filter (extracted so it is unit-testable without Tauri). Keeps
/// ONLY records whose top-level `type` is `"user"` or `"assistant"` AND that are not flagged
/// true on any of `isMeta`/`isVisibleInTranscriptOnly`/`isSidechain`/`isCompactSummary`. Drops
/// every other record type (attachment/summary/last-prompt/ai-title/permission-mode/
/// queue-operation/mode/agent-name/system) and any line that does not parse as a JSON object.
/// Original file order is preserved. This bounds the cross-boundary payload — the corpus has
/// multi-MB transcripts, but only conversational user/assistant turns drive the replay.
pub(crate) fn filter_transcript_lines(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if !v.is_object() {
            continue;
        }
        let kind = v.get("type").and_then(|t| t.as_str());
        if kind != Some("user") && kind != Some("assistant") {
            continue;
        }
        let flagged = |key: &str| v.get(key).and_then(|b| b.as_bool()).unwrap_or(false);
        if flagged("isMeta")
            || flagged("isVisibleInTranscriptOnly")
            || flagged("isSidechain")
            || flagged("isCompactSummary")
        {
            continue;
        }
        out.push(line.clone());
    }
    out
}

/// Best-effort extraction of the session id from the FIRST record (in file order) that carries
/// a `sessionId`/`session_id`. `None` if no record carries one.
pub(crate) fn first_session_id(lines: &[String]) -> Option<String> {
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(sid) = v
            .get("sessionId")
            .or_else(|| v.get("session_id"))
            .and_then(|s| s.as_str())
        {
            return Some(sid.to_string());
        }
    }
    None
}

/// Resolve an app-authored (`tree_id`) plan's session transcript WITHOUT a provenance scan.
/// Pure + filesystem-reading-but-testable: given the tree's `tree_id`, its resolved live `cwd`,
/// the enumerated `transcripts`, and the optionally-parsed `<cwd>/.plan-tree/state.json` value,
/// return the `(PathBuf, session_id)` of the originating transcript — or `None`.
///
/// PRIMARY (filename match): if `state_json` records this exact `tree_id` AND carries an
/// `sdk_session_id`, locate the transcript whose file **stem equals that session id** (the
/// transcript is `projects/<encoded-cwd>/<session_id>.jsonl`) — no reverse-decoding of the lossy
/// encoded-cwd dir name. The stem-matched file is ACCEPTED only if its in-file `first_cwd` equals
/// `cwd` (the same invariant the FALLBACK enforces): a stale/mismatched `sdk_session_id` could name
/// a transcript from a DIFFERENT directory, which must NOT be returned under the resolved cwd —
/// on mismatch we fall through to the newest-by-cwd FALLBACK. The session id is the resolved id.
///
/// FALLBACK (newest-by-cwd): when there is no usable `sdk_session_id` (or PRIMARY's cwd check
/// fails), pick the NEWEST transcript (mtime-descending, the same ordering used everywhere) whose
/// in-file `first_cwd` equals `cwd`, and take its `first_session_id` as the session id. Subagent
/// files are excluded — only a top-level `<session>.jsonl` (one whose parent dir is a project dir,
/// not a `subagents/` dir) can be the originating session.
pub(crate) fn resolve_tree_session(
    tree_id: &str,
    cwd: &str,
    transcripts: &[PathBuf],
    state_json: Option<&Value>,
) -> Option<(PathBuf, String)> {
    // Read a top-level (non-subagent) transcript and accept it ONLY if its in-file cwd matches
    // `cwd`. Returns `(text, resolved_session_id)`; the session id prefers the in-file
    // `first_session_id`, falling back to the file stem. Used by BOTH branches so the cwd
    // invariant is identical (no stem-match can bypass the cwd check). Subagent files never
    // qualify as the originating session.
    let accept_at_cwd = |fp: &Path| -> Option<String> {
        let is_subagent = fp
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some("subagents");
        if is_subagent {
            return None;
        }
        let text = std::fs::read_to_string(fp).ok()?;
        if first_cwd(&text).as_deref() != Some(cwd) {
            return None;
        }
        let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
        first_session_id(&lines).or_else(|| fp.file_stem().and_then(|s| s.to_str()).map(String::from))
    };

    // PRIMARY: state.json's sdk_session_id ⇒ filename match, GATED by the cwd cross-check.
    if let Some(state) = state_json {
        let id_matches = state
            .get("tree_id")
            .and_then(|t| t.as_str())
            .map(|t| t == tree_id)
            .unwrap_or(false);
        if id_matches {
            if let Some(sid) = state.get("sdk_session_id").and_then(|s| s.as_str()) {
                if !sid.is_empty() {
                    for fp in transcripts {
                        if fp.file_stem().and_then(|s| s.to_str()) == Some(sid) {
                            // Stem matched; accept ONLY if cwd also matches. On mismatch, do NOT
                            // return it — fall through to the newest-by-cwd FALLBACK below.
                            if let Some(resolved_sid) = accept_at_cwd(fp) {
                                return Some((fp.clone(), resolved_sid));
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // FALLBACK: newest top-level transcript whose in-file cwd matches.
    let mut ordered: Vec<PathBuf> = transcripts.to_vec();
    sort_transcripts_newest_first(&mut ordered);
    for fp in &ordered {
        if let Some(sid) = accept_at_cwd(fp) {
            return Some((fp.clone(), sid));
        }
    }

    None
}

/// THE pure scan-before-fallback ordering for `read_plan_transcript`: when the provenance scan
/// produced a hit (`scan.is_some()`), return it WITHOUT invoking `fallback` — a scan hit always
/// short-circuits the `tree_id` fallback, so CLI-authored / plan-mode plans never reach it. Only a
/// scan MISS (`None`) calls `fallback`. Generic over the fallback's return so it is unit-testable
/// (a spy closure proves the short-circuit) while the command wires the async resolver as the arm.
pub(crate) fn pick_transcript_source<T>(scan: Option<T>, fallback: impl FnOnce() -> Option<T>) -> Option<T> {
    match scan {
        Some(hit) => Some(hit),
        None => fallback(),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::paths::is_within;

    /// Write a top-level session transcript `<root>/<proj>/<session>.jsonl`.
    fn write_session(root: &Path, proj: &str, session: &str, lines: &[String]) -> PathBuf {
        let dir = root.join(proj);
        std::fs::create_dir_all(&dir).expect("mkdir proj");
        let p = dir.join(format!("{session}.jsonl"));
        std::fs::write(&p, lines.join("\n")).expect("write session");
        p
    }

    /// Write a subagent transcript `<root>/<proj>/<session>/subagents/agent-<hex>.jsonl`.
    fn write_subagent(
        root: &Path,
        proj: &str,
        session: &str,
        hex: &str,
        lines: &[String],
    ) -> PathBuf {
        let dir = root.join(proj).join(session).join("subagents");
        std::fs::create_dir_all(&dir).expect("mkdir subagents");
        let p = dir.join(format!("agent-{hex}.jsonl"));
        std::fs::write(&p, lines.join("\n")).expect("write subagent");
        p
    }

    fn plan_mode_line(cwd: &str, stem: &str) -> String {
        serde_json::json!({
            "cwd": cwd,
            "attachment": {
                "type": "plan_mode",
                "planFilePath": format!("/whatever/plans/{stem}.md"),
                "isSubAgent": false
            }
        })
        .to_string()
    }

    fn write_tool_line(cwd: &str, stem: &str) -> String {
        serde_json::json!({
            "cwd": cwd,
            "message": {
                "content": [
                    { "type": "tool_use", "name": "Write",
                      "input": { "file_path": format!("/whatever/plans/{stem}.md") } }
                ]
            }
        })
        .to_string()
    }

    /// Set a file's mtime to an explicit `YYYYMMDDhhmm` timestamp via `touch -t` (no extra
    /// crate dependency). Used to give fixtures distinct, deterministic mtimes so the
    /// newest-session tie-break can be asserted without relying on write-order timing.
    fn set_mtime(path: &Path, touch_stamp: &str) {
        let status = std::process::Command::new("touch")
            .arg("-t")
            .arg(touch_stamp)
            .arg(path)
            .status()
            .expect("run touch");
        assert!(status.success(), "touch -t {touch_stamp} {path:?} failed");
    }

    #[test]
    fn same_provenance_tie_resolves_to_newest_mtime_deterministically() {
        let stem = "tie-break-stem";
        // Two transcripts with the SAME (authoritative) provenance for `stem` but different
        // cwds and different mtimes. The NEWER-mtime transcript's cwd must win — and must do
        // so regardless of the order the slice is passed in (proves it's mtime, not order).
        for forward in [true, false] {
            let root = unique_dir(if forward { "tie_fwd" } else { "tie_rev" });
            let old = write_session(&root, "projOld", "sOld", &[plan_mode_line("/OLD", stem)]);
            let new = write_session(&root, "projNew", "sNew", &[plan_mode_line("/NEW", stem)]);
            // /OLD = Jan 2020, /NEW = Jan 2024 (strictly newer).
            set_mtime(&old, "202001010000");
            set_mtime(&new, "202401010000");

            let transcripts = if forward {
                vec![old.clone(), new.clone()]
            } else {
                vec![new.clone(), old.clone()]
            };
            let out = resolve_stems(&[stem.to_string()], &transcripts);
            assert_eq!(
                out.get(stem).cloned().flatten(),
                Some("/NEW".to_string()),
                "on a same-provenance tie the newest-mtime session's cwd must win, forward={forward}"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn authoritative_beats_fallback_regardless_of_file_order() {
        let stem = "cross-priority-stem";
        // Transcript A: Write-fallback match, cwd = /A.
        // Transcript B: authoritative plan_mode match, cwd = /B.
        // The resolved cwd MUST be /B under BOTH file orderings.
        for forward in [true, false] {
            let root = unique_dir(if forward { "resA_fwd" } else { "resA_rev" });
            let a = write_session(&root, "projA", "sessA", &[write_tool_line("/A", stem)]);
            let b = write_session(&root, "projB", "sessB", &[plan_mode_line("/B", stem)]);

            let transcripts = if forward {
                vec![a.clone(), b.clone()]
            } else {
                vec![b.clone(), a.clone()]
            };
            let out = resolve_stems(&[stem.to_string()], &transcripts);
            assert_eq!(
                out.get(stem).cloned().flatten(),
                Some("/B".to_string()),
                "authoritative plan_mode (/B) must win over Write-fallback (/A), forward={forward}"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn authoritative_not_downgraded_by_later_write_or_substring() {
        let stem = "no-downgrade-stem";
        let root = unique_dir("resB");
        // First file (authoritative). Later files only carry weaker signals.
        let auth = write_session(&root, "p0", "s0", &[plan_mode_line("/AUTH", stem)]);
        let weak_write = write_session(&root, "p1", "s1", &[write_tool_line("/WRITE", stem)]);
        let weak_sub = write_session(&root, "p2", "s2", &[line_contains_only("/SUBSTR", stem)]);

        let out = resolve_stems(
            &[stem.to_string()],
            &[auth.clone(), weak_write.clone(), weak_sub.clone()],
        );
        assert_eq!(
            out.get(stem).cloned().flatten(),
            Some("/AUTH".to_string()),
            "an already-authoritative stem must NOT be downgraded by a later Write/substring"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn subagent_transcript_resolves_from_its_own_file() {
        let hex = "0000000000000002";
        let stem = format!("gentle-waving-maple-agent-{hex}");
        let root = unique_dir("resC");
        // No top-level <session>.jsonl exists for this stem — only the subagent file does.
        // The subagent file carries its OWN cwd and a Write match for the stem.
        write_subagent(
            &root,
            "someproj",
            "parent-session",
            hex,
            &[write_tool_line("/Users/me/.example-project", &stem)],
        );

        let root2 = projects_for(&root);
        let transcripts = collect_transcripts(&root2);
        let out = resolve_stems(&[stem.clone()], &transcripts);
        assert_eq!(
            out.get(&stem).cloned().flatten(),
            Some("/Users/me/.example-project".to_string()),
            "a subagent plan must resolve from its own subagents/agent-<hex>.jsonl"
        );

        // collect_transcripts must actually have picked up the subagent file.
        assert!(
            transcripts.iter().any(|p| p.to_string_lossy().contains("/subagents/")),
            "collect_transcripts must descend into subagents/"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The fabricated fixtures are written directly under `root` as the projects-root, so
    /// `collect_transcripts(root)` is the entry point. This helper just returns `root` (it
    /// documents intent: `root` IS the `~/.claude/projects` analogue in tests).
    fn projects_for(root: &Path) -> PathBuf {
        root.to_path_buf()
    }

    #[test]
    fn fake_stem_resolves_to_none() {
        let root = unique_dir("resD");
        // A real transcript that mentions some OTHER plan, never the fake stem.
        write_session(
            &root,
            "proj",
            "sess",
            &[plan_mode_line("/X", "some-real-other-plan")],
        );
        let transcripts = collect_transcripts(&root);
        let fake = "totally-fake-nonexistent-plan-zzz-9999".to_string();
        let out = resolve_stems(&[fake.clone()], &transcripts);
        assert_eq!(
            out.get(&fake).cloned(),
            Some(None),
            "a fake stem must be present in the map with a None resolution"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_stem_path_authoritative_beats_fallback_regardless_of_file_order() {
        let stem = "transcript-priority-stem";
        // Transcript A: Write-fallback match, cwd = /A.
        // Transcript B: authoritative plan_mode match, cwd = /B.
        // resolve_stem_path MUST return B's PathBuf (and /B cwd) under BOTH orderings —
        // provenance, not file order, decides the winner.
        for forward in [true, false] {
            let root = unique_dir(if forward { "rsp_fwd" } else { "rsp_rev" });
            let a = write_session(&root, "projA", "sessA", &[write_tool_line("/A", stem)]);
            let b = write_session(&root, "projB", "sessB", &[plan_mode_line("/B", stem)]);

            let transcripts = if forward {
                vec![a.clone(), b.clone()]
            } else {
                vec![b.clone(), a.clone()]
            };
            let (path, cwd) = resolve_stem_path(stem, &transcripts)
                .expect("a matching transcript must be found");
            assert_eq!(
                path, b,
                "authoritative plan_mode transcript (B) must win over Write-fallback (A), forward={forward}"
            );
            assert_eq!(
                cwd,
                Some("/B".to_string()),
                "the winning transcript's cwd must be /B, forward={forward}"
            );

            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn filter_transcript_lines_keeps_user_assistant_drops_meta_and_attachment() {
        let user = serde_json::json!({
            "type": "user",
            "message": { "content": "hello" }
        })
        .to_string();
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "content": [ { "type": "text", "text": "hi" } ] }
        })
        .to_string();
        // Should be DROPPED: a user record flagged isMeta.
        let meta_user = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "message": { "content": "meta noise" }
        })
        .to_string();
        // Should be DROPPED: an attachment record (non user/assistant type).
        let attachment = serde_json::json!({
            "type": "attachment",
            "attachment": { "type": "plan_mode", "planFilePath": "/x/plans/y.md" }
        })
        .to_string();
        // Should be DROPPED: a summary record.
        let summary = serde_json::json!({ "type": "summary", "summary": "done" }).to_string();
        // Should be DROPPED: an assistant record flagged isVisibleInTranscriptOnly.
        let visible_only = serde_json::json!({
            "type": "assistant",
            "isVisibleInTranscriptOnly": true,
            "message": { "content": [ { "type": "text", "text": "x" } ] }
        })
        .to_string();
        // Should be DROPPED: an assistant flagged isSidechain.
        let sidechain = serde_json::json!({
            "type": "assistant",
            "isSidechain": true,
            "message": { "content": [] }
        })
        .to_string();
        // Should be DROPPED: a non-JSON garbage line.
        let garbage = "not json at all".to_string();

        let input = vec![
            user.clone(),
            meta_user,
            attachment,
            assistant.clone(),
            summary,
            visible_only,
            sidechain,
            garbage,
        ];
        let kept = filter_transcript_lines(&input);
        assert_eq!(
            kept,
            vec![user, assistant],
            "only the un-flagged user + assistant lines survive, in original order"
        );
    }

    #[test]
    fn resolve_stem_path_returns_none_for_fake_stem() {
        let root = unique_dir("rspD");
        // A real transcript that mentions some OTHER plan, never the fake stem.
        write_session(
            &root,
            "proj",
            "sess",
            &[plan_mode_line("/X", "some-real-other-plan")],
        );
        let transcripts = collect_transcripts(&root);
        let fake = "totally-fake-nonexistent-plan-zzz-9999";
        assert!(
            resolve_stem_path(fake, &transcripts).is_none(),
            "a fake stem must yield no matched transcript"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_stem_path_matched_file_is_inside_projects_root() {
        let stem = "containment-stem";
        let root = unique_dir("rspContain");
        let projects_root = projects_for(&root);
        let session =
            write_session(&root, "someproj", "sess", &[plan_mode_line("/C", stem)]);

        let transcripts = collect_transcripts(&projects_root);
        let (path, _cwd) =
            resolve_stem_path(stem, &transcripts).expect("must match the fabricated transcript");
        assert_eq!(path, session, "resolved path must be the fabricated session file");
        // The matched path lives inside the fabricated projects root (containment invariant
        // that read_plan_transcript enforces via canonicalize + is_within).
        assert!(
            is_within(&projects_root, &path),
            "matched transcript path must be contained within the projects root"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A `.plan-tree/state.json` value with the verified schema-2 shape.
    fn state_json(tree_id: &str, sdk_session_id: &str) -> Value {
        serde_json::json!({
            "schema": 2,
            "tree_id": tree_id,
            "sdk_session_id": sdk_session_id,
        })
    }

    #[test]
    fn resolve_tree_session_filename_match_via_state_sdk_session_id() {
        // PRIMARY path: state.json gives sdk_session_id; the transcript named <session_id>.jsonl
        // is selected by filename match — even when another, NEWER transcript shares the cwd.
        let root = unique_dir("rts_primary");
        let cwd = "/Users/x/proj";
        let session_id = "5cfbc968-3a83-496b-b809-149e079a4c66";
        let want = write_session(
            &root,
            "encoded-proj",
            session_id,
            &[session_meta_line(cwd, session_id)],
        );
        // A decoy newer transcript with the same cwd but a DIFFERENT session id — the filename
        // match must still pick `want`, not the newest-by-cwd decoy.
        let decoy = write_session(
            &root,
            "encoded-proj",
            "decoy-newer-session-id",
            &[session_meta_line(cwd, "decoy-newer-session-id")],
        );
        let _ = std::process::Command::new("touch")
            .args(["-t", "203012312359"])
            .arg(&decoy)
            .status();

        let transcripts = collect_transcripts(&root);
        let state = state_json("tree-abc", session_id);
        let (path, sid) =
            resolve_tree_session("tree-abc", cwd, &transcripts, Some(&state))
                .expect("filename match must resolve");
        assert_eq!(path, want, "must select the <session_id>.jsonl transcript");
        assert_eq!(sid, session_id, "resolved session id is the sdk_session_id");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_wrong_sdk_session_id_misses_filename_match() {
        // Falsifiability: a state.json whose sdk_session_id does NOT name any transcript file
        // gets no filename match; with no cwd-matching transcript either, resolution is None.
        let root = unique_dir("rts_falsify");
        let cwd = "/Users/x/proj";
        // The on-disk transcript is for a DIFFERENT cwd, so the fallback can't rescue it.
        write_session(
            &root,
            "encoded-proj",
            "real-session-id",
            &[session_meta_line("/Users/x/OTHER", "real-session-id")],
        );
        let transcripts = collect_transcripts(&root);
        let state = state_json("tree-abc", "this-id-names-no-file");
        assert!(
            resolve_tree_session("tree-abc", cwd, &transcripts, Some(&state)).is_none(),
            "a wrong sdk_session_id (no file, no cwd match) must NOT resolve"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_fallback_newest_by_cwd_without_state() {
        // FALLBACK path: no state.json (None) ⇒ newest transcript whose in-file cwd matches.
        let root = unique_dir("rts_fallback");
        let cwd = "/Users/x/proj";
        let older = write_session(
            &root,
            "encoded-proj",
            "older-session",
            &[session_meta_line(cwd, "older-session")],
        );
        let newer = write_session(
            &root,
            "encoded-proj",
            "newer-session",
            &[session_meta_line(cwd, "newer-session")],
        );
        // Make `older` strictly older and `newer` strictly newer by explicit mtimes.
        let _ = std::process::Command::new("touch")
            .args(["-t", "200001010000"])
            .arg(&older)
            .status();
        let _ = std::process::Command::new("touch")
            .args(["-t", "203012312359"])
            .arg(&newer)
            .status();

        let transcripts = collect_transcripts(&root);
        let (path, sid) = resolve_tree_session("tree-abc", cwd, &transcripts, None)
            .expect("newest-by-cwd fallback must resolve");
        assert_eq!(path, newer, "newest cwd-matching transcript must win");
        assert_eq!(sid, "newer-session", "session id from first_session_id");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_no_cwd_match_is_none() {
        // Neither a usable sdk_session_id nor any cwd-matching transcript ⇒ None (drives the
        // command's `found:false`). Models a dead/missing index entry's downstream effect.
        let root = unique_dir("rts_none");
        write_session(
            &root,
            "encoded-proj",
            "some-session",
            &[session_meta_line("/Users/x/ELSEWHERE", "some-session")],
        );
        let transcripts = collect_transcripts(&root);
        assert!(
            resolve_tree_session("tree-abc", "/Users/x/proj", &transcripts, None).is_none(),
            "no cwd-matching transcript and no state.json ⇒ None"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_state_tree_id_mismatch_falls_through() {
        // Defensive: a state.json whose tree_id does NOT match is ignored for the PRIMARY path;
        // resolution falls through to newest-by-cwd (here that rescues it).
        let root = unique_dir("rts_mismatch");
        let cwd = "/Users/x/proj";
        let session_id = "named-session";
        let want = write_session(
            &root,
            "encoded-proj",
            session_id,
            &[session_meta_line(cwd, session_id)],
        );
        let transcripts = collect_transcripts(&root);
        // state.json references the right session id but the WRONG tree → PRIMARY path skipped,
        // fallback by cwd still finds `want`.
        let state = state_json("tree-DIFFERENT", session_id);
        let (path, _sid) = resolve_tree_session("tree-abc", cwd, &transcripts, Some(&state))
            .expect("fallback by cwd resolves despite tree_id mismatch");
        assert_eq!(path, want, "newest-by-cwd fallback selects the cwd-matching file");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_excludes_subagent_files_from_fallback() {
        // A subagent transcript shares the cwd but must never be selected as the originating
        // SESSION in the newest-by-cwd fallback (only top-level <session>.jsonl qualifies).
        let root = unique_dir("rts_subagent");
        let cwd = "/Users/x/proj";
        let top = write_session(
            &root,
            "encoded-proj",
            "top-session",
            &[session_meta_line(cwd, "top-session")],
        );
        let sub = write_subagent(
            &root,
            "encoded-proj",
            "top-session",
            "deadbeef",
            &[session_meta_line(cwd, "agent-run")],
        );
        // Make the subagent file strictly NEWER so, absent the exclusion, it would win.
        let _ = std::process::Command::new("touch")
            .args(["-t", "200001010000"])
            .arg(&top)
            .status();
        let _ = std::process::Command::new("touch")
            .args(["-t", "203012312359"])
            .arg(&sub)
            .status();

        let transcripts = collect_transcripts(&root);
        let (path, _sid) = resolve_tree_session("tree-abc", cwd, &transcripts, None)
            .expect("must resolve the top-level session, not the subagent");
        assert_eq!(path, top, "subagent file must be excluded from session fallback");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_primary_rejects_stem_match_from_wrong_cwd() {
        // PRIMARY cwd invariant: a stale `sdk_session_id` names a transcript whose in-file cwd is a
        // DIFFERENT directory than the resolved `cwd`. That stem-matched file must NOT be returned;
        // resolution falls through to the newest correct-cwd transcript instead.
        let root = unique_dir("rts_primary_cwd");
        let resolved_cwd = "/Users/x/RIGHT";
        let stale_session = "stale-session-id";
        // The stem-matched file (named after the stale sdk_session_id) belongs to a DIFFERENT cwd.
        write_session(
            &root,
            "encoded-proj",
            stale_session,
            &[session_meta_line("/Users/x/WRONG", stale_session)],
        );
        // A correct-cwd transcript that the fallback should select instead.
        let correct = write_session(
            &root,
            "encoded-proj",
            "correct-session",
            &[session_meta_line(resolved_cwd, "correct-session")],
        );

        let transcripts = collect_transcripts(&root);
        let state = state_json("tree-abc", stale_session);
        let (path, sid) = resolve_tree_session("tree-abc", resolved_cwd, &transcripts, Some(&state))
            .expect("must fall through to the correct-cwd transcript");
        assert_eq!(
            path, correct,
            "a stem match from the WRONG cwd must be rejected; the correct-cwd file wins"
        );
        assert_eq!(sid, "correct-session");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_tree_session_primary_wrong_cwd_with_no_alternative_is_none() {
        // Same invariant, isolated: the ONLY transcript is the stale stem-match from the wrong cwd.
        // With no correct-cwd alternative, resolution is None (never the wrong-cwd file).
        let root = unique_dir("rts_primary_cwd_none");
        let stale_session = "stale-session-id";
        write_session(
            &root,
            "encoded-proj",
            stale_session,
            &[session_meta_line("/Users/x/WRONG", stale_session)],
        );
        let transcripts = collect_transcripts(&root);
        let state = state_json("tree-abc", stale_session);
        assert!(
            resolve_tree_session("tree-abc", "/Users/x/RIGHT", &transcripts, Some(&state)).is_none(),
            "a wrong-cwd stem match with no correct-cwd alternative must NOT be returned"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cli_authored_stem_resolves_via_scan_not_fallback() {
        // Regression guard (part 1): a CLI-authored / plan-mode stem resolves through the PRIMARY
        // scan (`resolve_stem_path`), so the tree_id fallback is never reached.
        let stem = "cli-authored-plan-stem";
        let root = unique_dir("rts_cli");
        let session = write_session(&root, "proj", "sess", &[plan_mode_line("/cli", stem)]);
        let transcripts = collect_transcripts(&root);
        let (path, cwd) =
            resolve_stem_path(stem, &transcripts).expect("scan must resolve a CLI-authored stem");
        assert_eq!(path, session, "scan selects the plan_mode transcript");
        assert_eq!(cwd, Some("/cli".to_string()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_transcript_source_scan_hit_short_circuits_fallback() {
        // Regression guard (part 2): proves the command's scan-before-fallback ORDERING, not by
        // code inspection. A scan hit must return WITHOUT invoking the fallback closure; a scan
        // miss must invoke it. We use a Cell spy to observe whether the fallback ran.
        use std::cell::Cell;

        // Scan hit ⇒ fallback NOT invoked, scan value returned verbatim.
        let invoked = Cell::new(false);
        let out = pick_transcript_source(Some("scan-hit"), || {
            invoked.set(true);
            Some("fallback")
        });
        assert_eq!(out, Some("scan-hit"), "a scan hit returns verbatim");
        assert!(
            !invoked.get(),
            "the fallback MUST NOT be invoked when the scan already hit (short-circuit)"
        );

        // Scan miss ⇒ fallback invoked, its value returned.
        let invoked2 = Cell::new(false);
        let out2 = pick_transcript_source(None::<&str>, || {
            invoked2.set(true);
            Some("fallback")
        });
        assert_eq!(out2, Some("fallback"), "a scan miss returns the fallback");
        assert!(invoked2.get(), "the fallback MUST run on a scan miss");
    }

}
