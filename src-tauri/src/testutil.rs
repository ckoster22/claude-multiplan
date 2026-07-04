// Shared test fixtures used by more than one module's `#[cfg(test)] mod tests` block.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::{
    CommentRecord, Flavor, PlanRecord, RawFlavor, RawMarker, RawRow, ReviewRequest, ReviewResponse,
};
use crate::review::REVIEW_SCHEMA;
use crate::state::app_state::AppState;

pub(crate) fn record_with_mtime(stem: &str, mtime_ms: i64) -> PlanRecord {
    PlanRecord {
        absolute_path: format!("/tmp/{stem}.md"),
        filename_stem: stem.to_string(),
        mtime_ms,
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
    }
}

/// Build a `RawRow` for `arrange_plans` tests. `marker` is supplied separately.
pub(crate) fn raw_row(stem: &str, mtime_ms: i64, marker: Option<RawMarker>) -> RawRow {
    RawRow {
        stem: stem.to_string(),
        absolute_path: format!("/tmp/{stem}.md"),
        mtime_ms,
        cwd: None,
        unread: false,
        marker,
        h1s: Vec::new(),
    }
}

pub(crate) fn master_marker(tree_id: &str) -> RawMarker {
    RawMarker {
        tree_id: tree_id.to_string(),
        flavor: RawFlavor::Master,
        nn: None,
        execution_model: None,
    }
}

pub(crate) fn sub_marker(tree_id: &str, nn: u32) -> RawMarker {
    RawMarker {
        tree_id: tree_id.to_string(),
        flavor: RawFlavor::Sub,
        nn: Some(vec![nn]),
        execution_model: None,
    }
}

/// A sub marker with a DOTTED hierarchical id, e.g. `&[2, 1]` for `nn: 02.01`.
pub(crate) fn dotted_sub_marker(tree_id: &str, segments: &[u32]) -> RawMarker {
    RawMarker {
        tree_id: tree_id.to_string(),
        flavor: RawFlavor::Sub,
        nn: Some(segments.to_vec()),
        execution_model: None,
    }
}

pub(crate) fn unique_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "plan_reader_{tag}_{}_{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp");
    dir
}

/// A bare line that merely contains the plan path (last-resort substring match).
pub(crate) fn line_contains_only(cwd: &str, stem: &str) -> String {
    serde_json::json!({
        "cwd": cwd,
        "text": format!("see /whatever/plans/{stem}.md for details")
    })
    .to_string()
}

/// A minimal session line carrying the in-file `cwd` + `sessionId`. The transcript FILENAME
/// (its stem) is the canonical session id; this line lets `first_cwd`/`first_session_id`
/// observe matching values for the fallback path.
pub(crate) fn session_meta_line(cwd: &str, session_id: &str) -> String {
    serde_json::json!({
        "type": "user",
        "cwd": cwd,
        "sessionId": session_id,
        "message": { "content": "hello" }
    })
    .to_string()
}

pub(crate) fn comment_rec(quote: &str, block_line: Option<i64>, occurrence: i64, id: i64) -> CommentRecord {
    CommentRecord {
        quote: quote.to_string(),
        block_line,
        // Derive a plausible end line from the start (start + 2) so round-trip exercises a
        // populated value; None when there is no block (whole-pane anchor).
        block_end_line: block_line.map(|s| s + 2),
        occurrence,
        comment: format!("note for {quote}"),
        id,
    }
}

pub(crate) fn sample_review_request() -> ReviewRequest {
    ReviewRequest {
        schema: REVIEW_SCHEMA,
        review_id: "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12".to_string(),
        session_id: "session-abc".to_string(),
        cwd: "/Users/me/Documents/repos/claude-plan-reader".to_string(),
        transcript_path: "/Users/me/.claude/projects/x/session.jsonl".to_string(),
        plan_text: "# Plan\n\nDo the thing.".to_string(),
        plan_file_path: "/Users/me/.claude/plans/do-the-thing.md".to_string(),
        created_ms: 1_717_100_000_000,
    }
}

pub(crate) fn sample_review_response() -> ReviewResponse {
    ReviewResponse {
        schema: REVIEW_SCHEMA,
        review_id: "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12".to_string(),
        decision: "allow".to_string(),
        reason: "Looks good; ship it.".to_string(),
    }
}

/// Build an `AppState` whose persistence lands in `dir` (everything else default/empty), so the
/// index helpers can be exercised against a real on-disk `tree-cwd-index.json`.
pub(crate) fn app_state_in(dir: &Path) -> Mutex<AppState> {
    Mutex::new(AppState {
        data_dir: Some(dir.to_path_buf()),
        ..AppState::default()
    })
}

