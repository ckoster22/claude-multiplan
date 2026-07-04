// Frontmatter boundary + marker parsing. The single source of truth for where a plan's YAML
// frontmatter ends (used by both the list head-parse and the contents body-strip) plus the
// line-based marker/nn parsers.

use crate::model::{ModelOptions, RawFlavor, RawMarker};

/// THE single source of truth for the frontmatter boundary — used by BOTH `list_plans`
/// (head-parse for the marker) and `read_plan_contents` (strip the marker from the body).
/// They MUST never disagree, so there is exactly one parser.
///
/// If `content` begins (at line 1) with a `---` fence line and a later `---` fence line
/// closes it, returns `(Some(yaml_block_between_fences), body_after_closing_fence)`. Else
/// `(None, content)`. Only a LEADING block counts — a mid-document `---` thematic break is
/// never treated as an opening fence (and so is never stripped). Tolerates trailing
/// whitespace on a fence line and both `\n` / `\r\n` line endings, so the two read paths
/// can never disagree on where the body begins.
pub(crate) fn split_frontmatter(content: &str) -> (Option<&str>, &str) {
    // A fence line is exactly `---` after trimming trailing whitespace (CR included).
    fn is_fence(line: &str) -> bool {
        line.trim_end() == "---"
    }

    // The first line must be an opening fence. Find its byte span (incl. the newline).
    let first_line_end = content.find('\n').map(|i| i + 1).unwrap_or(content.len());
    let first_line = &content[..first_line_end];
    if !is_fence(first_line) {
        return (None, content);
    }

    // Scan subsequent lines for the CLOSING fence.
    let mut cursor = first_line_end;
    let yaml_start = first_line_end;
    while cursor < content.len() {
        let rest = &content[cursor..];
        let line_end_rel = rest.find('\n').map(|i| i + 1).unwrap_or(rest.len());
        let line = &rest[..line_end_rel];
        if is_fence(line) {
            // yaml block is everything between the two fences (excludes both fence lines).
            let yaml = &content[yaml_start..cursor];
            let body = &content[cursor + line_end_rel..];
            return (Some(yaml), body);
        }
        cursor += line_end_rel;
    }

    // Opening fence but no closing fence ⇒ NOT frontmatter; pass through unchanged.
    (None, content)
}

/// Extract the ATX H1 heading texts from a plan body, in document order. FENCE-AWARE: a
/// line whose trimmed-start opens or closes a ``` / ~~~ fenced code block toggles an
/// "inside fence" flag, and ALL lines inside a fence are skipped — so a `# Comment` line in
/// a code block is NOT harvested as a heading (a fence-blind scan would wrongly collect it;
/// at least one real corpus plan has ~25 such `#` lines inside a `python` fence).
///
/// Outside fences we collect ONLY ATX H1: a line whose content (after stripping a leading
/// `> ` is NOT considered — only a leading `# ` exactly) starts with `# ` (one hash then a
/// space) and whose heading text is the trimmed remainder. `## ` (H2+) and `#NoSpace` (no
/// following space) are excluded. The empty-string heading (`# ` with nothing after) yields
/// an empty string entry — but in practice the title line always carries text.
pub(crate) fn extract_h1s(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed_start = line.trim_start();
        // A fence open/close is a line whose trimmed-start begins with ``` or ~~~.
        if trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // ATX H1: exactly one leading `#` followed by a space. `## ` (the char after the
        // first `#` is another `#`) and `#NoSpace` are excluded.
        if let Some(rest) = trimmed_start.strip_prefix("# ") {
            // `strip_prefix("# ")` already requires `#` + space, so `## x` (starts with
            // `##`) and `#x` (no space) do not match. Trim the heading text.
            out.push(rest.trim().to_string());
        }
    }
    out
}

/// Parse an `nn` frontmatter value into its dotted segment vector. Accepts the dotted form
/// `SEG("."SEG)*` where each segment is 1-2 ASCII digits with value 1-99 (read-side leniency:
/// the legacy unpadded `nn: 2` is the single-segment `vec![2]`; the canonical write side always
/// zero-pads). Rejects (None) an empty value, an empty segment (`02.`, `02..01`, `.02`), a 3+
/// digit segment, a non-digit, and the out-of-range values 0 and 100+.
pub(crate) fn parse_nn_segments(value: &str) -> Option<Vec<u32>> {
    if value.is_empty() {
        return None;
    }
    let mut out: Vec<u32> = Vec::new();
    for seg in value.split('.') {
        if seg.is_empty() || seg.len() > 2 || !seg.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: u32 = seg.parse().ok()?;
        if !(1..=99).contains(&n) {
            return None;
        }
        out.push(n);
    }
    Some(out)
}

/// Canonical zero-padded dotted rendering of an nn segment vector: `[2, 1]` ⇒ `"02.01"`.
/// The inverse of `parse_nn_segments` on canonical input; the single mint for `PlanRecord.nn_path`.
pub(crate) fn format_nn_path(segments: &[u32]) -> String {
    segments
        .iter()
        .map(|n| format!("{n:02}"))
        .collect::<Vec<_>>()
        .join(".")
}

/// Parse a frontmatter YAML block into a `RawMarker` with a minimal line-based `key: value`
/// scan — deliberately NO `serde_yaml` (the marker is a fixed, skill-generated 2-3 key
/// block, so a full YAML parser is unwarranted dependency surface). Recognizes only the
/// keys `tree_id`, `flavor`, `nn`, `execution_model`, `execution_effort`. Returns `None` when
/// `tree_id` is missing or `flavor` is absent/unrecognized. `nn` parses via `parse_nn_segments`
/// (dotted ⇒ multi-segment vec; legacy plain `nn: 2` ⇒ the single-segment `vec![2]`).
/// `execution_model` yields `Some(ModelOptions{..})` only when the `execution_model` line is
/// present; `execution_effort` is optional (⇒ `None`).
pub(crate) fn parse_marker(yaml_block: &str) -> Option<RawMarker> {
    let mut tree_id: Option<String> = None;
    let mut flavor: Option<RawFlavor> = None;
    let mut nn: Option<Vec<u32>> = None;
    let mut execution_model_id: Option<String> = None;
    let mut execution_effort: Option<String> = None;

    for line in yaml_block.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        // Strip an optional trailing comment and surrounding whitespace/quotes from the value.
        let value = value.trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        match key {
            "tree_id" => {
                if !value.is_empty() {
                    tree_id = Some(value.to_string());
                }
            }
            "flavor" => {
                flavor = match value {
                    "master" => Some(RawFlavor::Master),
                    "sub" => Some(RawFlavor::Sub),
                    _ => None,
                };
            }
            "nn" => {
                nn = parse_nn_segments(value);
            }
            "execution_model" => {
                if !value.is_empty() {
                    execution_model_id = Some(value.to_string());
                }
            }
            "execution_effort" => {
                if !value.is_empty() {
                    execution_effort = Some(value.to_string());
                }
            }
            _ => {}
        }
    }

    let execution_model = execution_model_id.map(|model| ModelOptions {
        model,
        effort: execution_effort,
    });

    Some(RawMarker {
        tree_id: tree_id?,
        flavor: flavor?,
        nn,
        execution_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_frontmatter_extracts_leading_block_and_body() {
        let content = "---\ntree_id: t\nflavor: master\n---\n# Title\n\nbody\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(
            yaml,
            Some("tree_id: t\nflavor: master\n"),
            "the yaml block between the fences must be returned verbatim"
        );
        assert!(
            body.starts_with("# Title"),
            "body must begin AFTER the closing fence, got {body:?}"
        );
    }

    #[test]
    fn split_frontmatter_tolerates_crlf_and_trailing_fence_whitespace() {
        // CRLF line endings AND trailing whitespace on both fences — both read paths must
        // still agree on the boundary.
        let content = "--- \r\ntree_id: t\r\nflavor: sub\r\nnn: 2\r\n---\t\r\n# Title\r\n";
        let (yaml, body) = split_frontmatter(content);
        assert!(yaml.is_some(), "a CRLF/whitespace-padded fence must still be recognized");
        let marker = parse_marker(yaml.unwrap()).expect("parses");
        assert_eq!(marker.flavor, RawFlavor::Sub);
        assert_eq!(marker.nn, Some(vec![2]));
        assert!(body.starts_with("# Title"), "body begins after closing fence, got {body:?}");
    }

    #[test]
    fn split_frontmatter_no_frontmatter_passes_through() {
        let content = "# Just a heading\n\nsome body\n";
        let (yaml, body) = split_frontmatter(content);
        // INVERT-CHECK target: this MUST be None. (Asserting Some(...) here would go red.)
        assert_eq!(yaml, None, "a no-frontmatter document must yield None");
        assert_eq!(body, content, "body must be the unchanged content");
    }

    #[test]
    fn split_frontmatter_unterminated_fence_is_not_stripped() {
        // Opening fence but NO closing fence ⇒ not frontmatter; nothing stripped.
        let content = "---\ntree_id: t\nflavor: master\n# never closed\nbody\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(yaml, None, "an unterminated --- must NOT be treated as frontmatter");
        assert_eq!(body, content, "unterminated fence ⇒ body unchanged");
    }

    #[test]
    fn split_frontmatter_mid_document_rule_is_not_stripped() {
        // A `---` thematic break NOT at line 1 must never open a frontmatter block.
        let content = "# Title\n\nsome text\n\n---\n\nmore text\n";
        let (yaml, body) = split_frontmatter(content);
        assert_eq!(yaml, None, "a mid-document --- thematic break must not be frontmatter");
        assert_eq!(body, content, "mid-document --- ⇒ body unchanged");
    }

    #[test]
    fn extract_h1s_collects_atx_h1_only() {
        // `# Title` is collected (trimmed); `## H2` and `#NoSpace` are excluded.
        let body = "# Title\n\nsome text\n## H2 section\n\n#NoSpace\n\n#   Padded H1   \n";
        let h1s = extract_h1s(body);
        assert_eq!(
            h1s,
            vec!["Title".to_string(), "Padded H1".to_string()],
            "only ATX H1 (`# ` + space) collected, trimmed; H2 and #NoSpace excluded"
        );
    }

    #[test]
    fn extract_h1s_empty_body_is_empty() {
        assert_eq!(extract_h1s(""), Vec::<String>::new());
        assert_eq!(extract_h1s("just paragraph text\nno headings\n"), Vec::<String>::new());
    }

    #[test]
    fn extract_h1s_is_fence_aware_skips_hash_lines_in_code_fences() {
        // A `# Comment` line INSIDE a ```python fence must NOT be harvested. This is the real
        // corpus failure mode: a fence-blind scan would return ["Comment"]. Inverting the
        // fence-awareness (treating fenced `# ` lines as headings) makes this assertion RED.
        let body = "# Real Title\n\n```python\n# Comment inside a code fence\nx = 1  # not a heading\n```\n\n# Second Real Title\n";
        let h1s = extract_h1s(body);
        assert_eq!(
            h1s,
            vec!["Real Title".to_string(), "Second Real Title".to_string()],
            "the `# Comment` line inside the python fence must be skipped (fence-aware)"
        );
        assert!(
            !h1s.iter().any(|h| h.contains("Comment")),
            "no fenced code comment may leak into the H1 list"
        );
    }

    #[test]
    fn extract_h1s_tilde_fence_is_also_aware() {
        // `~~~` fences are handled exactly like ``` fences.
        let body = "# Title\n~~~\n# fenced comment\n~~~\n# After\n";
        assert_eq!(
            extract_h1s(body),
            vec!["Title".to_string(), "After".to_string()]
        );
    }

    #[test]
    fn parse_marker_reads_master_block() {
        let m = parse_marker("tree_id: nested-2026\nflavor: master\n").expect("master parses");
        assert_eq!(m.tree_id, "nested-2026");
        assert_eq!(m.flavor, RawFlavor::Master);
        assert_eq!(m.nn, None);
    }

    #[test]
    fn parse_marker_reads_sub_block_with_nn() {
        let m = parse_marker("tree_id: nested-2026\nflavor: sub\nnn: 3\n").expect("sub parses");
        assert_eq!(m.tree_id, "nested-2026");
        assert_eq!(m.flavor, RawFlavor::Sub);
        // LEGACY PIN: the plain unpadded `nn: 3` u32 frontmatter still parses (single-segment vec).
        assert_eq!(m.nn, Some(vec![3]));
    }

    /// A DOTTED `nn` frontmatter value parses to its per-segment integer vector, with
    /// read-side leniency for 1-digit segments; malformed/out-of-range values parse to nn None
    /// (the marker survives — only the nn is dropped). Falsifiable: revert `parse_nn_segments`
    /// to `value.parse::<u32>()` and the dotted asserts go RED.
    #[test]
    fn parse_marker_reads_dotted_nn() {
        let m = parse_marker("tree_id: t\nflavor: sub\nnn: 02.01\n").expect("dotted parses");
        assert_eq!(m.nn, Some(vec![2, 1]));
        let m = parse_marker("tree_id: t\nflavor: sub\nnn: 02.01.07\n").expect("deep parses");
        assert_eq!(m.nn, Some(vec![2, 1, 7]));
        // Read-side leniency: unpadded segments accepted (1-2 digits, value 1-99).
        let m = parse_marker("tree_id: t\nflavor: sub\nnn: 2.1\n").expect("unpadded parses");
        assert_eq!(m.nn, Some(vec![2, 1]));
        // Malformed/out-of-range nn values drop to None (the marker itself survives).
        for bad in ["02.", "02..01", ".02", "100", "0", "02.100", "2x", ""] {
            let yaml = format!("tree_id: t\nflavor: sub\nnn: {bad}\n");
            let m = parse_marker(&yaml).expect("marker survives a bad nn");
            assert_eq!(m.nn, None, "nn {bad:?} must parse to None");
        }
    }

    #[test]
    fn parse_marker_missing_tree_id_is_none() {
        // No tree_id ⇒ None (a marker without a join key is useless).
        assert_eq!(parse_marker("flavor: master\n"), None);
    }

    #[test]
    fn parse_marker_bad_flavor_is_none() {
        // INVERT-CHECK target: an unrecognized flavor must yield None.
        assert_eq!(parse_marker("tree_id: t\nflavor: wizard\n"), None);
        // Absent flavor entirely ⇒ also None.
        assert_eq!(parse_marker("tree_id: t\n"), None);
    }

    /// `execution_model` (+ optional `execution_effort`) frontmatter parses into the marker's
    /// `Some(ModelOptions{..})`; the effort line is optional (absent ⇒ `None`) and its absence
    /// entirely ⇒ `execution_model: None`. Falsifiable: drop the two key arms in `parse_marker`
    /// and every non-None assert here goes RED.
    #[test]
    fn parse_marker_reads_execution_model() {
        let m = parse_marker(
            "tree_id: t\nflavor: sub\nnn: 1\nexecution_model: claude-opus-4-8\nexecution_effort: high\n",
        )
        .expect("model+effort parses");
        assert_eq!(
            m.execution_model,
            Some(ModelOptions {
                model: "claude-opus-4-8".to_string(),
                effort: Some("high".to_string()),
            }),
            "execution_model + execution_effort must parse into the full ModelOptions"
        );

        // execution_model alone (no effort line) ⇒ Some with effort None.
        let m = parse_marker("tree_id: t\nflavor: sub\nnn: 1\nexecution_model: claude-sonnet-5\n")
            .expect("model-only parses");
        assert_eq!(
            m.execution_model,
            Some(ModelOptions {
                model: "claude-sonnet-5".to_string(),
                effort: None,
            }),
            "execution_model with no execution_effort must parse to effort None"
        );

        // Neither key present ⇒ None (the legacy/pre-feature frontmatter).
        let m = parse_marker("tree_id: t\nflavor: master\n").expect("no-model parses");
        assert_eq!(m.execution_model, None, "absent execution_model ⇒ None");
    }

}
