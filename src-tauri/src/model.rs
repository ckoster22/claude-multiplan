// Wire types shared across the Tauri command surface + the four frozen serde contracts.
//
// Serde casing: the crate's convention is snake_case field names with NO `rename_all`. The wire
// keys serialize verbatim. Field/enum-variant order and names here are a FROZEN contract — the
// `*_wire_contract_is_frozen` tests pin the exact key sets; a pure code-move keeps serialization
// byte-identical. Visibility is `pub(crate)` (types) + `pub(crate)` fields so the command modules
// and the `#[cfg(test)]` blocks can construct/read them; visibility never affects serde output.

use serde::{Deserialize, Serialize};

/// Which Claude model (and, for Opus, effort) should execute a plan. Also a `write_agent_plan`
/// command parameter type, so `Deserialize` is mandatory (tauri deserializes command args).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelOptions {
    pub(crate) model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
}

/// One row in the sidebar. The wire shape is a stable contract — the
/// `planrecord_wire_contract_is_frozen` test locks the exact key set and value types, and the
/// frontend's `contract.test.ts` pins the same 13 keys from the consuming side; keep field
/// names/order in sync with both. `cwd` and `unread` are populated by the resolver / read-state.
#[derive(Serialize, Clone)]
pub(crate) struct PlanRecord {
    pub(crate) absolute_path: String,
    pub(crate) filename_stem: String,
    pub(crate) mtime_ms: i64,        // millis since UNIX_EPOCH, JS-friendly
    pub(crate) cwd: Option<String>,
    pub(crate) unread: bool,
    /// Closed flavor set, never absent: "master" | "sub" | "standalone".
    pub(crate) flavor: Flavor,
    /// Join key linking a master to its subs; `null` for standalone.
    pub(crate) tree_id: Option<String>,
    /// Sub sequence number; `null` for master/standalone. With dotted hierarchical ids
    /// this stays the FIRST segment only (legacy sidebar behavior byte-identical) — the full
    /// dotted id lives in `nn_path`.
    pub(crate) nn: Option<u32>,
    /// Full canonical zero-padded dotted id (e.g. `"02.01"`; flat legacy ⇒ `"02"`); `null` for
    /// master/standalone. The frontend builds visual nesting depth from
    /// these prefixes; `nn` above keeps its legacy first-segment meaning.
    pub(crate) nn_path: Option<String>,
    /// Master only: OBSERVED count of present children (>= 0); `null` otherwise.
    pub(crate) child_count: Option<u32>,
    /// Master only (meaningful): persisted collapse state; `false` otherwise.
    pub(crate) collapsed: bool,
    /// The plan's ATX H1 heading texts (fence-aware, within the bounded head read), in
    /// document order. Used by the frontend sidebar filter to match on headings. `[]` when
    /// none. snake_case JSON key `h1s` (no rename).
    pub(crate) h1s: Vec<String>,
    /// Which model should execute this plan (`{model, effort}`), or `null` to fall back to the
    /// app's global model resolution. Serialized present-as-`null` (no `skip_serializing_if`).
    pub(crate) execution_model: Option<ModelOptions>,
}

/// Closed set of plan flavors. `#[serde(rename_all = "lowercase")]` makes the JSON emit
/// `"master" | "sub" | "standalone"`, so an invalid flavor is unrepresentable on the wire.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Flavor {
    Master,
    Sub,
    Standalone,
}

/// The two flavors a *marker* can carry (a marker never says "standalone" — that is the
/// normalized result of an absent/invalid marker, computed in `arrange_plans`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawFlavor {
    Master,
    Sub,
}

/// A parsed frontmatter marker. `tree_id` is mandatory (a marker without it is rejected);
/// `nn` is only meaningful for `Sub`. Dotted hierarchical ids: `nn` is the parsed
/// segment vector — legacy `nn: 2` is the single-segment `vec![2]`, `nn: 02.01` is `vec![2, 1]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawMarker {
    pub(crate) tree_id: String,
    pub(crate) flavor: RawFlavor,
    pub(crate) nn: Option<Vec<u32>>,
    pub(crate) execution_model: Option<ModelOptions>,
}

/// One per-file row fed into `arrange_plans`: the raw stat/cwd/unread facts plus the parsed
/// marker (if any). `arrange_plans` turns a `Vec<RawRow>` into the final ordered records.
#[derive(Debug, Clone)]
pub(crate) struct RawRow {
    pub(crate) stem: String,
    pub(crate) absolute_path: String,
    pub(crate) mtime_ms: i64,
    pub(crate) cwd: Option<String>,
    pub(crate) unread: bool,
    pub(crate) marker: Option<RawMarker>,
    /// ATX H1 heading texts (fence-aware) extracted from this file's body head. Threaded
    /// straight through to the final `PlanRecord.h1s`.
    pub(crate) h1s: Vec<String>,
}

/// Payload for the `plan-changed` event. The frontend `PlanChanged` type mirrors these keys.
#[derive(Serialize, Clone)]
pub(crate) struct PlanChanged {
    pub(crate) path: String,
    pub(crate) kind: String,
}

/// One persisted comment for a plan. Stable 6-key wire shape — locked by the
/// `comment_record_wire_contract_is_frozen` test; the frontend `CommentRecord` type mirrors it.
/// `block_line` is `Option<i64>` (serde emits `null`)
/// — it mirrors the existing `cwd: Option<String>` precedent; there is NO `-1` sentinel.
/// `null` means the captured selection had no enclosing source block (re-find scans the whole
/// pane by `occurrence`). `block_end_line` is the matching `data-source-end-line` of that same
/// block (markdown-it's `[start, end)` exclusive end); it is `#[serde(default)]` so older saved
/// files lacking the key deserialize to `None`. Keyed-by-plan-path lives in the store map, not
/// the record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct CommentRecord {
    /// Normalized (whitespace-collapsed, trimmed) selected text — the re-anchor key.
    pub(crate) quote: String,
    /// `data-source-line` of the nearest enclosing block, or `null` for a whole-pane anchor.
    pub(crate) block_line: Option<i64>,
    /// `data-source-end-line` (markdown-it `[start, end)` exclusive end) of that same block, or
    /// `null` (unknown / whole-pane). `#[serde(default)]` rescues old files lacking the key.
    #[serde(default)]
    pub(crate) block_end_line: Option<i64>,
    /// 0-based Nth match of `quote` within the chosen root (block element, or whole pane).
    pub(crate) occurrence: i64,
    /// The user's comment text.
    pub(crate) comment: String,
    /// Collision-free id (also the highlight span's `data-c`), minted frontend-side.
    pub(crate) id: i64,
}

/// A plan-review request, written by the ExitPlanMode hook into `requests/<review_id>.json`
/// and read by the app. FROZEN wire shape — exactly 8 snake_case keys (see the frozen-key
/// test `review_request_wire_contract_is_frozen`). Field names match the wire verbatim
/// (snake_case, no `serde(rename)` — mirrors `PlanRecord`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct ReviewRequest {
    /// Wire schema version (`REVIEW_SCHEMA` == 1).
    pub(crate) schema: u32,
    /// Filesystem-safe id minted by the hook; also the request/response file stem.
    pub(crate) review_id: String,
    /// Originating Claude Code session id.
    pub(crate) session_id: String,
    /// Working directory the plan was authored in.
    pub(crate) cwd: String,
    /// Absolute path to the session transcript (`.jsonl`).
    pub(crate) transcript_path: String,
    /// The full plan markdown awaiting review.
    pub(crate) plan_text: String,
    /// Absolute path to the plan markdown file Claude just wrote (e.g.
    /// `~/.claude/plans/foo.md`), sourced from the hook's `tool_input.planFilePath`.
    /// `#[serde(default)]` so request files written by the OLD hook (which lacked this key)
    /// deserialize to `""` instead of erroring — critical for launch recovery.
    #[serde(default)]
    pub plan_file_path: String,
    /// Creation wall-clock time, millis since the UNIX epoch.
    pub(crate) created_ms: u64,
}

/// A plan-review decision, written by the app into `responses/<review_id>.json` and read
/// by the waiting hook. FROZEN wire shape — exactly 4 snake_case keys (see
/// `review_response_wire_contract_is_frozen`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct ReviewResponse {
    /// Wire schema version (`REVIEW_SCHEMA` == 1).
    pub(crate) schema: u32,
    /// Echoes the request's `review_id` so the hook can correlate.
    pub(crate) review_id: String,
    /// The review verdict. EXTERNAL (hook) reviews are DENY-ONLY: this is exactly `"deny"`
    /// (validated by `is_valid_external_decision`); external approvals happen only in the terminal.
    pub(crate) decision: String,
    /// Free-text rationale shown back to the model/hook.
    pub(crate) reason: String,
}

/// Event payload emitted to the frontend when a new review request arrives
/// (`plan-review-requested`). Carries only what the UI needs to render the prompt.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ReviewRequested {
    pub(crate) review_id: String,
    pub(crate) plan_text: String,
    pub(crate) plan_file_path: String,
}

/// Event payload emitted to the frontend when a pending review is cancelled
/// (`plan-review-cancelled`) — e.g. the request file was removed before a decision.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct ReviewCancelled {
    pub(crate) review_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{comment_rec, record_with_mtime, sample_review_request, sample_review_response};
    use serde_json::Value;

    /// Locks the `PlanRecord` wire shape — the stable contract the frontend consumes.
    /// Any serde drift — a `rename`, an added/removed field, or a casing change — flips
    /// the top-level key set or the `flavor` string and turns this RED.
    #[test]
    fn planrecord_wire_contract_is_frozen() {
        use std::collections::BTreeSet;

        // The exact, frozen set of top-level JSON keys (snake_case).
        let expected_keys: BTreeSet<&str> = [
            "absolute_path",
            "filename_stem",
            "mtime_ms",
            "cwd",
            "unread",
            "flavor",
            "tree_id",
            "nn",
            "nn_path",
            "child_count",
            "collapsed",
            "h1s",
            "execution_model",
        ]
        .into_iter()
        .collect();

        // One record per flavor, exercising the lowercase `flavor` strings and the
        // None-valued option fields that the contract requires to be present-as-null.
        let master = PlanRecord {
            absolute_path: "/tmp/master.md".to_string(),
            filename_stem: "master".to_string(),
            mtime_ms: 1,
            cwd: None,
            unread: false,
            flavor: Flavor::Master,
            tree_id: Some("tree-1".to_string()),
            nn: None,
            nn_path: None,
            child_count: Some(2),
            collapsed: true,
            h1s: vec!["Plan: master title".to_string()],
            execution_model: Some(ModelOptions {
                model: "claude-opus-4-8".to_string(),
                effort: Some("high".to_string()),
            }),
        };
        let sub = PlanRecord {
            absolute_path: "/tmp/01-sub.md".to_string(),
            filename_stem: "01-sub".to_string(),
            mtime_ms: 2,
            cwd: None,
            unread: false,
            flavor: Flavor::Sub,
            tree_id: Some("tree-1".to_string()),
            nn: Some(1),
            nn_path: Some("01".to_string()),
            child_count: None,
            collapsed: false,
            h1s: Vec::new(),
            execution_model: None,
        };
        let standalone = record_with_mtime("standalone", 3); // Flavor::Standalone, all options None

        for (record, expected_flavor) in [
            (&master, "master"),
            (&sub, "sub"),
            (&standalone, "standalone"),
        ] {
            let value = serde_json::to_value(record).unwrap();
            let obj = value
                .as_object()
                .expect("PlanRecord must serialize to a JSON object");

            // Top-level key set must equal the frozen contract exactly — no more, no less.
            let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
            assert_eq!(
                actual_keys, expected_keys,
                "PlanRecord top-level JSON keys drifted from the frozen contract \
                 (flavor = {expected_flavor})"
            );

            // `flavor` must serialize to the lowercase contract string.
            assert_eq!(
                obj.get("flavor"),
                Some(&serde_json::Value::String(expected_flavor.to_string())),
                "flavor must serialize to the lowercase string {expected_flavor:?}"
            );

            // Value TYPES of the always-present scalar fields must match the contract,
            // so a value-type drift (e.g. mtime_ms number->String) that keeps key names
            // still turns this RED.
            assert!(obj["absolute_path"].is_string(), "absolute_path must be a JSON string");
            assert!(obj["filename_stem"].is_string(), "filename_stem must be a JSON string");
            assert!(obj["mtime_ms"].is_i64() || obj["mtime_ms"].is_u64(), "mtime_ms must be a JSON integer");
            assert!(obj["unread"].is_boolean(), "unread must be a JSON boolean");
            assert!(obj["flavor"].is_string(), "flavor must be a JSON string");
            assert!(obj["collapsed"].is_boolean(), "collapsed must be a JSON boolean");
            assert!(obj["h1s"].is_array(), "h1s must be a JSON array (always present)");
        }

        // Populated option fields must carry the contract value types: `tree_id` a
        // string, `nn`/`child_count` integers (master has tree_id+child_count, sub has nn).
        let master_value = serde_json::to_value(&master).unwrap();
        assert!(master_value["tree_id"].is_string(), "tree_id must be a JSON string when populated");
        assert!(master_value["child_count"].is_u64(), "child_count must be a JSON integer when populated");
        let sub_value = serde_json::to_value(&sub).unwrap();
        assert!(sub_value["nn"].is_u64(), "nn must be a JSON integer when populated");

        // The sub's nn_path is a JSON string when populated (the full canonical dotted id).
        assert!(sub_value["nn_path"].is_string(), "nn_path must be a JSON string when populated");

        // Contract: tree_id / nn / nn_path / child_count / execution_model are always-present keys;
        // when the Rust value is `None` they must serialize as JSON `null`, never be omitted.
        let standalone_value = serde_json::to_value(&standalone).unwrap();
        for key in ["tree_id", "nn", "nn_path", "child_count", "execution_model"] {
            assert_eq!(
                standalone_value.get(key),
                Some(&serde_json::Value::Null),
                "{key} must be present as JSON null when None, not omitted"
            );
        }

        // A populated `execution_model` serializes to a nested `{model, effort}` object.
        assert_eq!(
            master_value.get("execution_model"),
            Some(&serde_json::json!({"model": "claude-opus-4-8", "effort": "high"})),
            "execution_model must serialize to a nested {{model, effort}} object when populated"
        );
    }

    /// Serde pin: the EXACT byte shape of a flat (single-segment) sub `PlanRecord`. There are now
    /// TWO additive fields relative to the pre-Phase-2 shape — `nn_path` and the trailing
    /// `execution_model` — while `nn` keeps its legacy first-segment integer meaning byte-
    /// identically. The old shape is re-derived by deleting BOTH additive key/values from the
    /// pinned bytes and compared too, proving NOTHING ELSE moved. Falsifiable: any field reorder,
    /// rename, or value-type drift breaks the byte equality.
    #[test]
    fn planrecord_flat_wire_shape_byte_pin() {
        let sub = PlanRecord {
            absolute_path: "/tmp/01-sub.md".to_string(),
            filename_stem: "01-sub".to_string(),
            mtime_ms: 2,
            cwd: None,
            unread: false,
            flavor: Flavor::Sub,
            tree_id: Some("tree-1".to_string()),
            nn: Some(1),
            nn_path: Some("01".to_string()),
            child_count: None,
            collapsed: false,
            h1s: Vec::new(),
            execution_model: None,
        };
        let json = serde_json::to_string(&sub).unwrap();
        let pinned_new = r#"{"absolute_path":"/tmp/01-sub.md","filename_stem":"01-sub","mtime_ms":2,"cwd":null,"unread":false,"flavor":"sub","tree_id":"tree-1","nn":1,"nn_path":"01","child_count":null,"collapsed":false,"h1s":[],"execution_model":null}"#;
        assert_eq!(json, pinned_new, "flat sub PlanRecord JSON must match the pinned Phase-2 bytes");
        // Deleting BOTH additive keys reproduces the old bytes EXACTLY — `nn` is
        // still the bare integer 1 and every other byte is unchanged.
        let pinned_old = r#"{"absolute_path":"/tmp/01-sub.md","filename_stem":"01-sub","mtime_ms":2,"cwd":null,"unread":false,"flavor":"sub","tree_id":"tree-1","nn":1,"child_count":null,"collapsed":false,"h1s":[]}"#;
        assert_eq!(
            json.replace(r#","nn_path":"01""#, "").replace(r#","execution_model":null"#, ""),
            pinned_old,
            "removing the additive nn_path + execution_model keys must yield the pre-change shape byte-identically"
        );
    }

    /// Locks the `CommentRecord` wire shape to the frozen contract: exactly 6 snake_case keys,
    /// with `block_line` / `block_end_line` present as JSON `null` when `None` (mirrors the
    /// `cwd: Option<String>` precedent — never omitted, never a -1 sentinel). Twin of
    /// `planrecord_wire_contract_is_frozen`.
    #[test]
    fn comment_record_wire_contract_is_frozen() {
        use std::collections::BTreeSet;

        let expected_keys: BTreeSet<&str> =
            ["quote", "block_line", "block_end_line", "occurrence", "comment", "id"]
                .into_iter()
                .collect();

        // One record with a real block_line, one with None — both must carry all 6 keys.
        let with_block = comment_rec("anchored quote", Some(7), 2, 0);
        let whole_pane = comment_rec("floating quote", None, 0, 1);

        for rec in [&with_block, &whole_pane] {
            let value = serde_json::to_value(rec).unwrap();
            let obj = value
                .as_object()
                .expect("CommentRecord must serialize to a JSON object");
            let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
            assert_eq!(
                actual_keys, expected_keys,
                "CommentRecord top-level JSON keys drifted from the frozen 6-key contract"
            );

            // Value types of the always-present scalar fields.
            assert!(obj["quote"].is_string(), "quote must be a JSON string");
            assert!(obj["comment"].is_string(), "comment must be a JSON string");
            assert!(obj["occurrence"].is_i64() || obj["occurrence"].is_u64(), "occurrence must be an integer");
            assert!(obj["id"].is_i64() || obj["id"].is_u64(), "id must be an integer");
        }

        // `block_line` must be a JSON integer when Some, and JSON null (present) when None.
        let with_block_value = serde_json::to_value(&with_block).unwrap();
        assert!(
            with_block_value["block_line"].is_i64() || with_block_value["block_line"].is_u64(),
            "block_line must be a JSON integer when populated"
        );
        let whole_pane_value = serde_json::to_value(&whole_pane).unwrap();
        assert_eq!(
            whole_pane_value.get("block_line"),
            Some(&serde_json::Value::Null),
            "block_line must be present as JSON null when None (no -1 sentinel, never omitted)"
        );

        // `block_end_line` follows the same rule: integer when Some, present JSON null when None.
        assert!(
            with_block_value["block_end_line"].is_i64() || with_block_value["block_end_line"].is_u64(),
            "block_end_line must be a JSON integer when populated"
        );
        assert_eq!(
            whole_pane_value.get("block_end_line"),
            Some(&serde_json::Value::Null),
            "block_end_line must be present as JSON null when None (never omitted)"
        );
    }

    /// Locks the `ReviewRequest` wire shape to exactly 8 snake_case keys against the ACTUAL
    /// serialized JSON. Twin of `planrecord_wire_contract_is_frozen`.
    #[test]
    fn review_request_wire_contract_is_frozen() {
        use std::collections::BTreeSet;
        let expected_keys: BTreeSet<&str> = [
            "schema",
            "review_id",
            "session_id",
            "cwd",
            "transcript_path",
            "plan_text",
            "plan_file_path",
            "created_ms",
        ]
        .into_iter()
        .collect();

        let value = serde_json::to_value(sample_review_request()).unwrap();
        let obj = value.as_object().expect("ReviewRequest serializes to an object");
        let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            actual_keys, expected_keys,
            "ReviewRequest top-level JSON keys drifted from the frozen 8-key contract"
        );
        // Value types of the always-present fields.
        assert!(obj["schema"].is_u64(), "schema must be a JSON integer");
        assert_eq!(obj["schema"], Value::from(1), "schema must serialize as 1");
        assert!(obj["review_id"].is_string());
        assert!(obj["session_id"].is_string());
        assert!(obj["cwd"].is_string());
        assert!(obj["transcript_path"].is_string());
        assert!(obj["plan_text"].is_string());
        assert!(obj["plan_file_path"].is_string());
        assert!(obj["created_ms"].is_u64(), "created_ms must be a JSON integer");
    }

    /// Locks the `ReviewResponse` wire shape to exactly 4 snake_case keys.
    #[test]
    fn review_response_wire_contract_is_frozen() {
        use std::collections::BTreeSet;
        let expected_keys: BTreeSet<&str> =
            ["schema", "review_id", "decision", "reason"].into_iter().collect();

        let value = serde_json::to_value(sample_review_response()).unwrap();
        let obj = value.as_object().expect("ReviewResponse serializes to an object");
        let actual_keys: BTreeSet<&str> = obj.keys().map(String::as_str).collect();
        assert_eq!(
            actual_keys, expected_keys,
            "ReviewResponse top-level JSON keys drifted from the frozen 4-key contract"
        );
        assert!(obj["schema"].is_u64());
        assert_eq!(obj["schema"], Value::from(1), "schema must serialize as 1");
        assert!(obj["review_id"].is_string());
        assert!(obj["decision"].is_string());
        assert!(obj["reason"].is_string());
    }

}
