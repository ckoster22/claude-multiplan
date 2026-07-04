// The sidecar normalizes the SDK's message union into a small wire vocabulary;
// Rust never interprets the SDK shapes — it parses one JSON line per stdout
// event and RE-EMITS it onto the appropriate Tauri event, nothing more. This
// module owns the PURE wire encode/decode (no Tauri, no state, serde only).

use serde_json::Value;

// The shell plugin's non-raw reader accumulates across pipe reads until a
// `\n`/`\r` and RETAINS the delimiter byte, so a `\r\n` line yields a trailing
// event whose payload is `"\n"` (NOT `""`). The guard is therefore "skip after
// trim," not "skip empty string."
//   - whitespace-only (incl. a lone "\n"/" ") AFTER trim  -> Ok(None)   (skip)
//   - valid JSON                                           -> Ok(Some(event))
//   - non-JSON                                             -> Err(diagnostic)

/// A parsed stdout frame routed to one of three Tauri events. The `kind`
/// distinguishes the committed agent-stream kinds from the permission seam.
#[derive(Debug, PartialEq)]
pub enum AgentEvent {
    /// `tool_permission_requested` -> the `tool-permission-requested` event.
    PermissionRequested(Value),
    /// `error` -> the `agent-error` event.
    Error(Value),
    /// Any committed agent-stream kind (system_init, assistant_text, tool_use,
    /// tool_result, mode_change, result, permission_denied) -> `agent-stream`.
    Stream(Value),
}

/// Parse one stdout line. See the module/section docs for the trim-then-skip
/// invariant. `Ok(None)` = whitespace-only (skip); `Err` = non-JSON (surface
/// as a contamination diagnostic, never a silent drop).
pub fn parse_stream_line(line: &str) -> Result<Option<AgentEvent>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("non-JSON line on sidecar stdout: {e}: {trimmed}"))?;

    let kind = value.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let event = match kind {
        "tool_permission_requested" => AgentEvent::PermissionRequested(value),
        // Sidecar-originated errors arrive as `{kind:"error", error_kind, message,
        // fatal}` — `kind:"error"` is just the sidecar's INTERNAL routing token.
        // The public `agent-error` wire shape emitted to the frontend is `{kind, message,
        // fatal}` where `kind` is the discriminator (auth/sdk/spawn/…). Normalize
        // at this seam: lift `error_kind` into `kind` (default "sdk" if absent) and
        // drop the internal `error_kind` field, so the `payload.kind ===
        // "auth"` onboarding check matches. Rust-originated errors (cwd/io/
        // contamination) never take this path — they emit a conforming `kind`
        // directly in the read task.
        "error" => AgentEvent::Error(normalize_error_payload(value)),
        // Everything else is a committed agent-stream kind (or a future one the
        // sidecar already passes through) — re-emit as `agent-stream`.
        _ => AgentEvent::Stream(value),
    };
    Ok(Some(event))
}

/// Rewrite a sidecar `{kind:"error", error_kind, message, fatal}` payload into
/// the public `agent-error` shape `{kind, message, fatal}`: `kind` becomes the
/// `error_kind` value (falling back to "sdk"), and the internal `error_kind`
/// field is dropped. Other fields (`message`, `fatal`, …) carry through verbatim.
fn normalize_error_payload(mut value: Value) -> Value {
    let public_kind = value
        .get("error_kind")
        .and_then(|k| k.as_str())
        .unwrap_or("sdk")
        .to_string();
    if let Value::Object(map) = &mut value {
        map.remove("error_kind");
        map.insert("kind".to_string(), Value::String(public_kind));
    }
    value
}

/// Build the `start` command JSON line sent over the sidecar stdin. PURE — no
/// I/O, no state — so the resume/null wiring is unit-testable. `resume` carries
/// an SDK session id to resume; serde emits `null` for `None` (the sidecar
/// treats null/absent/empty as "no resume").
pub(crate) fn start_command_json(
    cwd: &str,
    permission_mode: &str,
    model: &Option<String>,
    effort: &Option<String>,
    resume: &Option<String>,
) -> Value {
    serde_json::json!({
        "type": "start",
        "cwd": cwd,
        "permissionMode": permission_mode,
        "model": model,
        "effort": effort,
        "resume": resume,
    })
}

/// One inline image attached to a user turn. Wire shape is **bare snake_case**
/// (`media_type` / `data`) — it matches the frontend `{media_type, data}` payload AND the
/// `ReviewRequest` precedent (lib.rs:177-198, also bare snake_case, no `serde(rename_all)`).
/// A `mediaType` drift would silently break deserialization, so the field name is pinned by the
/// `image_input_wire_rejects_camel_case` test below. `data` is base64 with NO `data:…;base64,`
/// prefix (the frontend strips it).
#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

/// PURE, testable builder for the `user` stdin line sent to the sidecar.
///
/// - `images == None` → `{ "type":"user", "text":text }` with the `images` key **OMITTED**
///   (not null, not `[]`), so the text-only wire shape stays byte-identical to today.
/// - `images == Some(imgs)` → the same object plus `"images": [ {media_type,data}, … ]`.
pub fn build_user_line(text: &str, images: Option<&[ImageInput]>) -> serde_json::Value {
    let mut line = serde_json::json!({ "type": "user", "text": text });
    if let Some(imgs) = images {
        if let Value::Object(map) = &mut line {
            map.insert(
                "images".to_string(),
                serde_json::to_value(imgs).unwrap_or(Value::Null),
            );
        }
    }
    line
}

/// Build the `set-model` command JSON line sent over the sidecar stdin. PURE — no
/// I/O, no state — so the frame shape is unit-testable (mirrors `start_command_json`).
pub(crate) fn set_model_command_json(model: &str) -> Value {
    serde_json::json!({ "type": "set-model", "model": model })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_command_json_carries_resume_when_some_and_null_when_none() {
        // The start line must carry the SDK resume id when the host
        // supplies one, and serde-`null` when it does not (the sidecar treats
        // null/absent/empty as "no resume"). Falsifiability: drop the `resume`
        // field from start_command_json and BOTH assertions below go RED.
        let with_resume = start_command_json(
            "/x",
            "plan",
            &None,
            &None,
            &Some("sess-1".to_string()),
        );
        assert_eq!(
            with_resume["resume"],
            Value::String("sess-1".to_string()),
            "resume id must be forwarded as the `resume` field"
        );
        assert_eq!(with_resume["type"], "start");
        assert_eq!(with_resume["cwd"], "/x");
        assert_eq!(with_resume["permissionMode"], "plan");

        let without_resume = start_command_json("/x", "plan", &None, &None, &None);
        assert_eq!(
            without_resume["resume"],
            Value::Null,
            "None must serialize to JSON null, not be omitted"
        );
    }

    #[test]
    fn set_model_command_json_emits_the_set_model_frame() {
        // The mid-session model switch must emit `{"type":"set-model","model":<model>}` on the
        // sidecar stdin — the frame the sidecar's `set-model` handler routes to `q.setModel`.
        // Falsifiability: change the "type" to "set-permission-mode" or drop the "model" field
        // in set_model_command_json and these assertions go RED.
        let line = set_model_command_json("claude-opus-4-8");
        assert_eq!(line["type"], "set-model");
        assert_eq!(line["model"], Value::String("claude-opus-4-8".to_string()));
    }

    #[test]
    fn valid_json_maps_to_the_right_event() {
        // A committed agent-stream kind -> Stream.
        let line = r#"{"seq":0,"kind":"assistant_text","text":"hi"}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Stream(v))) => {
                assert_eq!(v["kind"], "assistant_text");
                assert_eq!(v["text"], "hi");
            }
            other => panic!("expected Stream event, got {other:?}"),
        }

        // The permission seam -> PermissionRequested (a DIFFERENT variant), so
        // this test goes RED if routing collapses everything into Stream.
        let perm = r#"{"seq":1,"kind":"tool_permission_requested","id":"t1","tool":"Edit"}"#;
        match parse_stream_line(perm) {
            Ok(Some(AgentEvent::PermissionRequested(v))) => {
                assert_eq!(v["id"], "t1");
            }
            other => panic!("expected PermissionRequested event, got {other:?}"),
        }

        // An error frame -> Error variant, normalized to the public wire shape.
        let err = r#"{"kind":"error","error_kind":"auth","fatal":true}"#;
        match parse_stream_line(err) {
            Ok(Some(AgentEvent::Error(v))) => assert_eq!(v["kind"], "auth"),
            other => panic!("expected Error event, got {other:?}"),
        }
    }

    #[test]
    fn sidecar_error_kind_is_normalized_onto_public_kind() {
        // The sidecar emits `{kind:"error", error_kind:"auth", …}` — `kind:"error"`
        // is its INTERNAL routing token. The emitted `agent-error` payload MUST
        // conform to the contract's `{kind, message, fatal}` with `kind` = the
        // discriminator, or the `payload.kind === "auth"` onboarding
        // never matches. Falsifiability: drop the normalize rewrite (re-emit the
        // payload verbatim) and `kind` stays "error" / "auth" leaks only on
        // `error_kind` -> this assertion goes RED.
        let line = r#"{"kind":"error","error_kind":"auth","message":"token expired","fatal":true}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Error(v))) => {
                assert_eq!(v["kind"], "auth", "public kind must be the discriminator");
                assert!(
                    v.get("error_kind").is_none(),
                    "internal error_kind must be dropped from the public payload"
                );
                assert_eq!(v["message"], "token expired");
                assert_eq!(v["fatal"], true);
            }
            other => panic!("expected normalized Error event, got {other:?}"),
        }

        // A sidecar error with NO error_kind falls back to "sdk" (never "error").
        let bare = r#"{"kind":"error","message":"boom","fatal":true}"#;
        match parse_stream_line(bare) {
            Ok(Some(AgentEvent::Error(v))) => assert_eq!(v["kind"], "sdk"),
            other => panic!("expected Error event, got {other:?}"),
        }
    }

    #[test]
    fn rust_originated_error_kinds_are_never_normalized() {
        // Rust-originated errors (cwd/io/contamination) are emitted with a
        // conforming public `kind` directly in the read task — they never carry
        // the sidecar's `kind:"error"` routing token, so they must NOT enter the
        // normalize path (which would downgrade them to "sdk"). Proof: a payload
        // already keyed `cwd`/`io`/`contamination` does not match the "error"
        // arm of parse_stream_line — it routes to Stream untouched, keeping its
        // kind verbatim. Falsifiability: route the "error" arm on ALL kinds and
        // this goes RED (the kind would flip to "sdk").
        for k in ["cwd", "io", "contamination"] {
            let line = format!(r#"{{"kind":"{k}","message":"x","fatal":false}}"#);
            match parse_stream_line(&line) {
                Ok(Some(AgentEvent::Stream(v))) => {
                    assert_eq!(v["kind"], k, "Rust error kind must survive verbatim");
                }
                other => panic!("expected Stream (untouched) for kind={k}, got {other:?}"),
            }
        }
    }

    #[test]
    fn newline_only_payload_is_none() {
        // The REAL `\r\n`-trailing artifact the reader emits is "\n" (NOT ""),
        // so we assert on "\n". If the skip guard were "skip empty string"
        // instead of "skip after trim," this would try to parse "\n" as JSON
        // and return Err -> the test goes RED. (Falsifiability: inverting the
        // trim/skip logic flips this from Ok(None) to Err.)
        assert_eq!(parse_stream_line("\n"), Ok(None));
    }

    #[test]
    fn whitespace_only_payload_is_none() {
        // A lone space is whitespace-only AFTER trim -> skip. Same falsifiable
        // property as the "\n" case.
        assert_eq!(parse_stream_line(" "), Ok(None));
    }

    #[test]
    fn non_json_line_surfaces_an_error() {
        // A non-JSON line must surface an error (a contamination diagnostic),
        // NOT a silent drop. If parse returned Ok(None) for this, the test
        // goes RED.
        match parse_stream_line("this is not json") {
            Err(_) => {}
            other => panic!("expected Err for non-JSON, got {other:?}"),
        }
    }

    #[test]
    fn payload_with_escaped_crlf_parses_as_one_event() {
        // A JSON line whose PAYLOAD contains an escaped `\r`/`\n` (e.g. captured
        // Bash output) must parse as ONE event — proving payload CR/LF do not
        // split frames (they stay escaped through JSON.stringify on the wire).
        let line = r#"{"kind":"tool_result","content":"line1\r\nline2\n"}"#;
        match parse_stream_line(line) {
            Ok(Some(AgentEvent::Stream(v))) => {
                assert_eq!(v["kind"], "tool_result");
                // The decoded content holds the real CR/LF — one whole event.
                assert_eq!(v["content"], "line1\r\nline2\n");
            }
            other => panic!("expected a single Stream event, got {other:?}"),
        }
    }

    // The multimodal `user` wire line.
    //
    // `build_user_line` is the PURE builder for the `{type:"user", …}` stdin
    // line. Two load-bearing invariants:
    //   - text-only (images == None) → the `images` key is OMITTED (not null,
    //     not []), so the wire shape stays byte-identical to the pre-image flow;
    //   - images present → an ORDERED `images` array, each element `{media_type,
    //     data}`, preserved in attach order (the multi-image numbering the
    //     sidecar relies on for `[Image #1] … [Image #N]` derives from this order).
    // Plus a serde field-name guard pinning the snake_case wire contract.

    #[test]
    fn build_user_line_omits_images_key_when_none() {
        // INVARIANT: with no images the line is exactly the text-only shape and
        // carries NO `images` key. Falsifiability: make build_user_line always
        // insert an `images` entry (even for None) and `images.is_none()` flips
        // → this assertion goes RED.
        let v = build_user_line("hello", None);
        assert_eq!(v["type"], "user", "wire kind must be `user`");
        assert_eq!(v["text"], "hello", "text must be forwarded verbatim");
        assert!(
            v.get("images").is_none(),
            "text-only sends MUST omit the `images` key entirely (not null, not [])"
        );
    }

    #[test]
    fn build_user_line_carries_single_image() {
        // INVARIANT: one attached image → an `images` array of length 1 whose
        // element mirrors the input {media_type, data}. Falsifiability: drop the
        // images-insert branch and `images` is absent → the length assert goes RED.
        let imgs = vec![ImageInput {
            media_type: "image/png".to_string(),
            data: "AAAA".to_string(),
        }];
        let v = build_user_line("see this", Some(&imgs));
        assert_eq!(v["type"], "user");
        assert_eq!(v["text"], "see this");
        let arr = v["images"]
            .as_array()
            .expect("images must be a JSON array when present");
        assert_eq!(arr.len(), 1, "one attached image → one array element");
        assert_eq!(arr[0]["media_type"], "image/png");
        assert_eq!(arr[0]["data"], "AAAA");
    }

    #[test]
    fn build_user_line_preserves_three_images_in_order() {
        // MULTI-IMAGE INVARIANT: three attached images → an `images` array of
        // length 3 in ATTACH ORDER, each {media_type, data} intact. The sidecar's
        // `[Image #1] [Image #2] [Image #3]` numbering is positional, so order is
        // load-bearing. Falsifiability: reverse or reorder the emitted array and
        // the per-index media_type/data asserts go RED.
        let imgs = vec![
            ImageInput {
                media_type: "image/png".to_string(),
                data: "PNGDATA".to_string(),
            },
            ImageInput {
                media_type: "image/jpeg".to_string(),
                data: "JPEGDATA".to_string(),
            },
            ImageInput {
                media_type: "image/webp".to_string(),
                data: "WEBPDATA".to_string(),
            },
        ];
        let v = build_user_line("three pics", Some(&imgs));
        let arr = v["images"].as_array().expect("images array");
        assert_eq!(arr.len(), 3, "three attached images → three array elements");

        assert_eq!(arr[0]["media_type"], "image/png");
        assert_eq!(arr[0]["data"], "PNGDATA");
        assert_eq!(arr[1]["media_type"], "image/jpeg");
        assert_eq!(arr[1]["data"], "JPEGDATA");
        assert_eq!(arr[2]["media_type"], "image/webp");
        assert_eq!(arr[2]["data"], "WEBPDATA");
    }

    #[test]
    fn image_input_wire_rejects_camel_case() {
        // WIRE CONTRACT GUARD: ImageInput deserializes the BARE snake_case
        // shape the frontend sends (`{media_type, data}`) and MUST reject a
        // camelCase `mediaType` drift — otherwise a silent rename would break
        // deserialization without a compile error. Falsifiability: add
        // `#[serde(rename_all = "camelCase")]` to ImageInput and the snake_case
        // `is_ok()` flips to Err (and camelCase to Ok) → both asserts go RED.
        let ok = serde_json::from_str::<ImageInput>(r#"{"media_type":"image/png","data":"AAAA"}"#);
        let parsed = ok.expect("snake_case wire shape MUST deserialize");
        assert_eq!(parsed.media_type, "image/png");
        assert_eq!(parsed.data, "AAAA");

        let err = serde_json::from_str::<ImageInput>(r#"{"mediaType":"image/png","data":"AAAA"}"#);
        assert!(
            err.is_err(),
            "camelCase `mediaType` MUST be rejected to protect the snake_case wire contract"
        );
    }
}
