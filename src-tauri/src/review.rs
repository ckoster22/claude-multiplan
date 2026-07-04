// Headless plan-review file-IPC: render pending review requests the ExitPlanMode hook drops
// under `~/.claude/plan-reader/requests/`, and write the user's decision to `responses/`.
// External (hook) reviews are DENY-ONLY; the path builders are containment-guarded.

use std::path::PathBuf;

use crate::model::{ReviewRequest, ReviewResponse};
use crate::paths::{guarded_path_in, requests_dir, responses_dir};
use crate::state::persist::atomic_write;

/// Schema version stamped into every `ReviewRequest` / `ReviewResponse` on the wire.
pub(crate) const REVIEW_SCHEMA: u32 = 1;

/// Build the containment-guarded path `responses/<review_id>.json`. Returns `Err` if the id
/// is syntactically unsafe (`valid_review_id`). Because the response file does NOT exist yet,
/// we cannot `canonicalize` the target itself — instead we canonicalize the PARENT (the
/// responses dir, which exists) and assert the joined path's canonicalized parent IS that
/// dir. That rejects any id that — despite passing the syntactic check — would resolve outside
/// `responses/` (defense in depth; `valid_review_id` already forbids separators and dots).
pub(crate) fn response_path_for(review_id: &str) -> Result<PathBuf, String> {
    guarded_path_in(responses_dir(), review_id)
}

/// Twin of `response_path_for` for `requests/<review_id>.json`.
pub(crate) fn request_path_for(review_id: &str) -> Result<PathBuf, String> {
    guarded_path_in(requests_dir(), review_id)
}

/// True iff a control-dir filename should be IGNORED by the watcher / listers: the in-flight
/// atomic-write temp (`.tmp-…`) and any other dotfile. Centralized so the watcher and
/// `list_pending_reviews` apply the identical skip rule.
pub(crate) fn is_ignored_control_filename(name: &str) -> bool {
    name.starts_with('.') || name.starts_with(".tmp-")
}

/// List the pending review requests (newest-first by `created_ms`). Reads `requests_dir()`,
/// parses each `*.json` (skipping dot/temp files and unparseable files), and returns the
/// `ReviewRequest`s. A missing dir is not an error — it yields an empty list.
#[tauri::command]
pub fn list_pending_reviews() -> Result<Vec<ReviewRequest>, String> {
    let Some(dir) = requests_dir() else {
        return Ok(Vec::new());
    };
    let read_dir = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(Vec::new()), // dir not yet created ⇒ empty
    };

    let mut out: Vec<ReviewRequest> = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if is_ignored_control_filename(name) {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue, // unreadable ⇒ skip
        };
        match serde_json::from_slice::<ReviewRequest>(&bytes) {
            Ok(req) => out.push(req),
            Err(_) => continue, // unparseable (e.g. partial write) ⇒ skip
        }
    }

    // Newest-first by created_ms.
    out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(out)
}

/// Read the plan text for a single pending review. Containment is enforced by the guarded
/// `request_path_for` (rejects an id that escapes `requests/`); the file must exist and parse.
#[tauri::command]
pub fn read_review_plan(review_id: String) -> Result<String, String> {
    let path = request_path_for(&review_id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("read failed: {e}"))?;
    let req: ReviewRequest =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse failed: {e}"))?;
    Ok(req.plan_text)
}

/// The EXTERNAL (settings.json ExitPlanMode hook) decision vocabulary is strictly narrower than the
/// general one: external/hook reviews are DENY-ONLY. The app exposes no in-app affordance to approve
/// an external review (#review-approve is hidden for external reviews); external approvals happen
/// exclusively in the terminal. So
/// `respond_to_review` — which is reached ONLY by the external file-IPC path — must reject "allow"
/// and accept only "deny", making an in-app external approval impossible-by-construction.
pub(crate) fn is_valid_external_decision(d: &str) -> bool {
    d == "deny"
}

/// Write the user's decision for a review. This is the EXTERNAL (hook) file-IPC path ONLY — the
/// in-process Agent SDK seam resolves via `resolve_tool_permission`, never here. External reviews are
/// DENY-ONLY, so this rejects any decision other than `"deny"` (notably "allow"), builds a
/// `ReviewResponse`, and atomically writes it to the guarded `responses/<review_id>.json` path
/// (where the polling hook will find it).
#[tauri::command]
pub fn respond_to_review(review_id: String, decision: String, reason: String) -> Result<(), String> {
    if !is_valid_external_decision(&decision) {
        return Err(format!(
            "external reviews are deny-only (approve in the terminal); rejected decision: {decision}"
        ));
    }
    // Ensure the responses dir exists so the guarded path builder (which canonicalizes the
    // parent) and the atomic write both succeed.
    if let Some(dir) = responses_dir() {
        let _ = std::fs::create_dir_all(&dir);
    }
    let path = response_path_for(&review_id)?;
    let resp = ReviewResponse {
        schema: REVIEW_SCHEMA,
        review_id,
        decision,
        reason,
    };
    let bytes = serde_json::to_vec_pretty(&resp).map_err(|e| format!("serialize failed: {e}"))?;
    atomic_write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{sample_review_request, sample_review_response};

    /// Serialize → deserialize → equal. Falsifiable: change a field after the round-trip and
    /// the `assert_eq!` goes red.
    #[test]
    fn review_request_round_trips() {
        let req = sample_review_request();
        let json = serde_json::to_string(&req).expect("serialize");
        let back: ReviewRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(req, back, "ReviewRequest must survive a serde round-trip unchanged");
    }

    /// A request JSON written by the OLD hook (no `plan_file_path` key) must still deserialize,
    /// defaulting the missing field to `""` — this is the launch-recovery path against
    /// pre-existing request files. Falsifiable: remove `#[serde(default)]` on `plan_file_path`
    /// and this `from_str` errors instead of yielding `""`.
    #[test]
    fn review_request_without_plan_file_path_defaults_to_empty() {
        let legacy = r##"{
            "schema": 1,
            "review_id": "rid-1",
            "session_id": "sid",
            "cwd": "/c",
            "transcript_path": "/t",
            "plan_text": "# Plan",
            "created_ms": 1717100000000
        }"##;
        let req: ReviewRequest =
            serde_json::from_str(legacy).expect("legacy request (no plan_file_path) must parse");
        assert_eq!(
            req.plan_file_path, "",
            "missing plan_file_path must default to empty string"
        );
    }

    /// EXTERNAL (hook) reviews are DENY-ONLY: `respond_to_review` (the external file-IPC path) must
    /// REJECT "allow" and ACCEPT "deny". External approvals happen only in the terminal — there is no
    /// in-app affordance to approve an external review — so `is_valid_external_decision` (which gates
    /// `respond_to_review`) makes an in-app external "allow" impossible-by-construction.
    /// Falsifiable: if `is_valid_external_decision` accepted "allow" (i.e. reverted to the general
    /// `is_valid_decision` vocabulary), the `!`-assertion on "allow" would go red.
    #[test]
    fn external_decision_is_deny_only() {
        assert!(is_valid_external_decision("deny"), "external \"deny\" must be valid");
        assert!(
            !is_valid_external_decision("allow"),
            "external \"allow\" must be rejected (approve in the terminal)"
        );
        assert!(!is_valid_external_decision("accept"), "stale \"accept\" must be rejected");
        assert!(!is_valid_external_decision(""), "empty must be rejected");
        assert!(!is_valid_external_decision("DENY"), "external decision is case-sensitive");
    }

    #[test]
    fn review_response_round_trips() {
        let resp = sample_review_response();
        let json = serde_json::to_string(&resp).expect("serialize");
        let back: ReviewResponse = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(resp, back, "ReviewResponse must survive a serde round-trip unchanged");
    }

    /// `response_path_for`: Err on traversal / separator ids; Ok for a valid id with the
    /// path's parent equal to `responses_dir()`. Asserts NO file is created (pure builder).
    #[test]
    fn response_path_for_is_a_guarded_pure_builder() {
        // Rejections (these short-circuit at `valid_review_id`, before any canonicalize).
        assert!(response_path_for("../escape").is_err(), "traversal id must be Err");
        assert!(response_path_for("a/b").is_err(), "slash id must be Err");

        // Valid id. `responses_dir()` must canonicalize, so create it for the duration.
        let dir = responses_dir().expect("home dir resolvable");
        let preexisting = dir.exists();
        std::fs::create_dir_all(&dir).expect("create responses dir for test");

        let id = "valid-review-id-123";
        let path = response_path_for(id).expect("valid id yields Ok");

        // Parent is the responses dir.
        assert_eq!(
            path.parent().expect("has parent"),
            dir.as_path(),
            "built path's parent must be responses_dir()"
        );
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("valid-review-id-123.json"),
            "built path must be <id>.json"
        );
        // The pure builder must NOT create the target file.
        assert!(!path.exists(), "response_path_for must not create the file");

        // request_path_for twin: parent is requests_dir().
        let rdir = requests_dir().expect("home dir resolvable");
        std::fs::create_dir_all(&rdir).expect("create requests dir for test");
        let rpath = request_path_for(id).expect("valid id yields Ok");
        assert_eq!(rpath.parent().expect("has parent"), rdir.as_path());
        assert!(!rpath.exists(), "request_path_for must not create the file");

        // Cleanup: only remove dirs we created (leave a pre-existing real dir alone).
        if !preexisting {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

}
