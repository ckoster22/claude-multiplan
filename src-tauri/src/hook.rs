// ExitPlanMode review-hook install/uninstall: write `hook.sh`, then perform a SINGLE idempotent
// additive merge into `~/.claude/settings.json` (never clobbering unrelated hooks). The pure
// `merge_install_hook`/`merge_uninstall_hook`/`hook_is_installed` cores are disk-free.

use std::path::Path;

use serde_json::Value;

use crate::paths::{plan_reader_dir, requests_dir, responses_dir};
use crate::state::persist::atomic_write;

/// The idempotency marker: any PreToolUse hook entry whose `command` string ENDS WITH this
/// suffix is treated as "our" plan-reader hook (install updates it in place; uninstall
/// removes it). Matching on the suffix — not an exact string — survives absolute-vs-`~`
/// path spellings of the same install.
const PLAN_READER_HOOK_SUFFIX: &str = "plan-reader/hook.sh";

/// The matcher key under which Claude Code fires hooks for the plan-approval gate.
const EXIT_PLAN_MODE_MATCHER: &str = "ExitPlanMode";

/// PURE settings merge: ensure the user's settings install our `ExitPlanMode` PreToolUse hook
/// pointing at `hook_command`. Takes and returns `serde_json::Value` so it is unit-testable
/// without touching disk. Behavior:
///   - coerce `settings` to an object (a non-object input becomes a fresh `{}`),
///   - ensure `hooks` is an object and `hooks.PreToolUse` is an array,
///   - find the array element whose `matcher == "ExitPlanMode"` (create + push one if absent),
///   - ensure that element's `hooks` array contains our command entry
///     `{ "type":"command", "command": hook_command, "timeout": 600 }`.
///     Idempotency key: an existing entry whose `command` ENDS WITH `plan-reader/hook.sh` is
///     "ours" — we update its `command` to `hook_command` and force `timeout` to 600 rather
///     than appending a duplicate.
/// EVERY other key and array element is preserved untouched (this is a SECURITY-critical
/// invariant — an unrelated Bash permission hook must never be clobbered).
pub(crate) fn merge_install_hook(settings: Value, hook_command: &str) -> Value {
    let mut root = match settings {
        Value::Object(map) => Value::Object(map),
        _ => Value::Object(serde_json::Map::new()),
    };
    let obj = root.as_object_mut().expect("root coerced to object");

    // hooks must be an object.
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !hooks.is_object() {
        *hooks = Value::Object(serde_json::Map::new());
    }
    let hooks = hooks.as_object_mut().expect("hooks coerced to object");

    // hooks.PreToolUse must be an array.
    let pretooluse = hooks
        .entry("PreToolUse")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !pretooluse.is_array() {
        *pretooluse = Value::Array(Vec::new());
    }
    let pretooluse = pretooluse.as_array_mut().expect("PreToolUse coerced to array");

    // Find (or create) the ExitPlanMode matcher element.
    let exit_idx = pretooluse.iter().position(|el| {
        el.get("matcher").and_then(|m| m.as_str()) == Some(EXIT_PLAN_MODE_MATCHER)
    });
    let exit_idx = match exit_idx {
        Some(i) => i,
        None => {
            let mut elem = serde_json::Map::new();
            elem.insert(
                "matcher".to_string(),
                Value::String(EXIT_PLAN_MODE_MATCHER.to_string()),
            );
            elem.insert("hooks".to_string(), Value::Array(Vec::new()));
            pretooluse.push(Value::Object(elem));
            pretooluse.len() - 1
        }
    };

    // Ensure that element's `hooks` is an array.
    let elem = pretooluse[exit_idx]
        .as_object_mut()
        .expect("ExitPlanMode element is an object");
    let elem_hooks = elem
        .entry("hooks")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !elem_hooks.is_array() {
        *elem_hooks = Value::Array(Vec::new());
    }
    let elem_hooks = elem_hooks.as_array_mut().expect("element hooks is array");

    // Look for an existing "ours" entry (command ends with the suffix).
    let ours = elem_hooks.iter_mut().find(|h| {
        h.get("command")
            .and_then(|c| c.as_str())
            .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
            .unwrap_or(false)
    });
    match ours {
        Some(entry) => {
            // Update in place — no duplicate.
            if let Some(map) = entry.as_object_mut() {
                map.insert("command".to_string(), Value::String(hook_command.to_string()));
                map.insert("timeout".to_string(), Value::from(600));
            }
        }
        None => {
            let mut new_entry = serde_json::Map::new();
            new_entry.insert("type".to_string(), Value::String("command".to_string()));
            new_entry.insert("command".to_string(), Value::String(hook_command.to_string()));
            new_entry.insert("timeout".to_string(), Value::from(600));
            elem_hooks.push(Value::Object(new_entry));
        }
    }

    root
}

/// PURE inverse of `merge_install_hook`: remove our plan-reader hook (command ends with
/// `plan-reader/hook.sh`) from the `ExitPlanMode` PreToolUse element's `hooks` array. If that
/// element's `hooks` array becomes empty, the element is removed from `PreToolUse`. We do NOT
/// delete the `hooks` / `PreToolUse` keys even if `PreToolUse` becomes empty (minimal change).
/// Everything else is preserved. Idempotent — removing twice is a no-op.
pub(crate) fn merge_uninstall_hook(settings: Value) -> Value {
    let mut root = match settings {
        Value::Object(map) => Value::Object(map),
        other => return other, // nothing to uninstall from a non-object
    };
    let obj = root.as_object_mut().expect("root is object");

    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return root; // no hooks object — nothing to do
    };
    let Some(pretooluse) = hooks.get_mut("PreToolUse").and_then(|p| p.as_array_mut()) else {
        return root; // no PreToolUse array — nothing to do
    };

    if let Some(exit_idx) = pretooluse.iter().position(|el| {
        el.get("matcher").and_then(|m| m.as_str()) == Some(EXIT_PLAN_MODE_MATCHER)
    }) {
        if let Some(elem_hooks) = pretooluse[exit_idx]
            .get_mut("hooks")
            .and_then(|h| h.as_array_mut())
        {
            // Drop any entry whose command ends with our suffix.
            elem_hooks.retain(|h| {
                !h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
                    .unwrap_or(false)
            });
            // If the ExitPlanMode element's hooks went empty, remove the element entirely.
            if elem_hooks.is_empty() {
                pretooluse.remove(exit_idx);
            }
        }
    }

    root
}

/// PURE detection: is OUR plan-reader `ExitPlanMode` PreToolUse hook present in `settings`?
/// True iff `settings.hooks.PreToolUse` is an array containing an element whose
/// `matcher == "ExitPlanMode"` whose own `hooks` array contains an entry whose `command`
/// (a string) ENDS WITH `PLAN_READER_HOOK_SUFFIX` — the SAME idempotency key the merge
/// functions match on. Tolerant of odd shapes: any missing/wrong-typed level short-circuits
/// to `false` (never panics).
pub(crate) fn hook_is_installed(settings: &Value) -> bool {
    let Some(pretooluse) = settings
        .get("hooks")
        .and_then(|h| h.get("PreToolUse"))
        .and_then(|p| p.as_array())
    else {
        return false;
    };
    pretooluse.iter().any(|el| {
        if el.get("matcher").and_then(|m| m.as_str()) != Some(EXIT_PLAN_MODE_MATCHER) {
            return false;
        }
        el.get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(|c| c.ends_with(PLAN_READER_HOOK_SUFFIX))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    })
}

/// The hook script content, written verbatim to `~/.claude/plan-reader/hook.sh` by
/// `install_hook`. The `$(...)`/`set` usage is INTENTIONAL shell (this is file content, not a
/// command we run) and mirrors the existing `plan-tree-save-plan.sh`.
const HOOK_SCRIPT: &str = r#"#!/usr/bin/env bash
# Plan Reader: PreToolUse/ExitPlanMode hook. Writes a review request and blocks
# until the app responds, or falls through (exit 0, no decision) on timeout /
# app-not-running / missing jq. plan_text is passed as DATA via jq --arg.
set -uo pipefail

# Fail OPEN if jq is missing — never turn a missing tool into a stall.
command -v jq >/dev/null 2>&1 || exit 0

PLAN_READER_DIR="$HOME/.claude/plan-reader"
REQUESTS_DIR="$PLAN_READER_DIR/requests"
RESPONSES_DIR="$PLAN_READER_DIR/responses"
ALIVE="$PLAN_READER_DIR/app.alive"

INPUT=$(cat)

PLAN=$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // empty')
[ -z "$PLAN" ] && exit 0

# Fast fallthrough: app not running (no heartbeat, or stale > 10s) → don't block.
[ -f "$ALIVE" ] || exit 0
NOW=$(date +%s)
MTIME=$(stat -f %m "$ALIVE" 2>/dev/null || echo 0)
[ $(( NOW - MTIME )) -gt 10 ] && exit 0

SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
SID=$(printf '%s' "$SID" | tr -cd 'A-Za-z0-9._-')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')
PLANFILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.planFilePath // empty')

mkdir -p "$REQUESTS_DIR" "$RESPONSES_DIR"

NANOS="${NOW}000000000"
RAND=$(jot -r 1 100000 999999 2>/dev/null || echo "$RANDOM")
REVIEW_ID="${SID}-${NANOS}-${RAND}"

REQ="$REQUESTS_DIR/${REVIEW_ID}.json"
RESP="$RESPONSES_DIR/${REVIEW_ID}.json"
TMP="$REQUESTS_DIR/.tmp-$$-${REVIEW_ID}.json"

jq -n \
  --arg review_id "$REVIEW_ID" \
  --arg session_id "$SID" \
  --arg cwd "$CWD" \
  --arg transcript_path "$TRANSCRIPT" \
  --arg plan_text "$PLAN" \
  --arg plan_file_path "$PLANFILE" \
  --argjson schema 1 \
  --argjson created_ms "${NOW}000" \
  '{schema:$schema, review_id:$review_id, session_id:$session_id, cwd:$cwd, transcript_path:$transcript_path, plan_text:$plan_text, plan_file_path:$plan_file_path, created_ms:$created_ms}' \
  > "$TMP"
mv -f "$TMP" "$REQ"

cleanup() { rm -f "$REQ" "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

DEADLINE=$(( NOW + 570 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if [ -f "$RESP" ]; then
    DECISION=$(jq -r '.decision // empty' "$RESP" 2>/dev/null || echo "")
    REASON=$(jq -r '.reason // empty' "$RESP" 2>/dev/null || echo "")
    rm -f "$RESP" 2>/dev/null || true
    if [ "$DECISION" = "allow" ] || [ "$DECISION" = "deny" ]; then
      jq -n --arg d "$DECISION" --arg r "$REASON" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
      exit 0
    fi
  fi
  # Re-check the heartbeat INSIDE the loop: if the app quit mid-review, app.alive stops
  # being touched (or is removed → stat fails → MTIME=0 → huge age), so fall through within
  # ~10s rather than blocking up to the full deadline.
  MTIME=$(stat -f %m "$ALIVE" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - MTIME )) -gt 10 ] && exit 0
  sleep 1
done
exit 0
"#;

/// Install the headless-review hook: write `hook.sh` (mode 0755) and merge the `ExitPlanMode`
/// PreToolUse entry into `~/.claude/settings.json` (idempotent additive merge — never clobbers
/// an unrelated hook). The hook's absolute path is what gets written into settings.
#[tauri::command]
pub fn install_hook(app: tauri::AppHandle) -> Result<(), String> {
    // We don't need `app` directly here, but the command takes it for symmetry / future use.
    let _ = app;

    // 1. Ensure the plan-reader dir tree exists.
    let base = plan_reader_dir().ok_or_else(|| "could not locate home directory".to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| format!("mkdir failed: {e}"))?;
    if let Some(d) = requests_dir() {
        std::fs::create_dir_all(&d).map_err(|e| format!("mkdir requests failed: {e}"))?;
    }
    if let Some(d) = responses_dir() {
        std::fs::create_dir_all(&d).map_err(|e| format!("mkdir responses failed: {e}"))?;
    }

    // 2. Write hook.sh, then chmod 0755.
    let hook_path = base.join("hook.sh");
    std::fs::write(&hook_path, HOOK_SCRIPT).map_err(|e| format!("write hook.sh failed: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(&hook_path, perms)
            .map_err(|e| format!("chmod hook.sh failed: {e}"))?;
    }

    // 3. Resolve the absolute hook path string we just wrote.
    let abs_hook = hook_path.to_string_lossy().to_string();

    // 4. Merge into ~/.claude/settings.json (default to {} when missing).
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let current = read_settings_value(&settings_path)?;
    let merged = merge_install_hook(current, &abs_hook);
    let bytes =
        serde_json::to_vec_pretty(&merged).map_err(|e| format!("serialize settings failed: {e}"))?;
    // Back up the existing (parseable) settings before overwriting, for a recovery path.
    backup_settings(&settings_path);
    atomic_write(&settings_path, &bytes).map_err(|e| format!("write settings failed: {e}"))?;
    Ok(())
}

/// Uninstall the headless-review hook from `~/.claude/settings.json` (idempotent removal). The
/// `hook.sh` file is intentionally LEFT on disk — harmless and avoids racing a running hook.
#[tauri::command]
pub fn uninstall_hook() -> Result<(), String> {
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let current = read_settings_value(&settings_path)?;
    let merged = merge_uninstall_hook(current);
    let bytes =
        serde_json::to_vec_pretty(&merged).map_err(|e| format!("serialize settings failed: {e}"))?;
    // Back up the existing (parseable) settings before overwriting, for a recovery path.
    backup_settings(&settings_path);
    atomic_write(&settings_path, &bytes).map_err(|e| format!("write settings failed: {e}"))?;
    Ok(())
}

/// Auto-detect whether OUR `ExitPlanMode` PreToolUse hook is currently installed in
/// `~/.claude/settings.json`. Drives the single-click Install XOR Remove button UX (no
/// two-click confirm). Failure policy: file ABSENT ⇒ `Ok(false)` (nothing installed); file
/// present but UNPARSEABLE ⇒ `Ok(false)` (we can't confirm our entry — `install_hook` still
/// guards a corrupt config separately and refuses to overwrite it); else
/// `Ok(hook_is_installed(&value))`. Never returns Err except for an unlocatable home dir.
#[tauri::command]
pub fn hook_status() -> Result<bool, String> {
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "could not locate home directory".to_string())?
        .join(".claude")
        .join("settings.json");
    let bytes = match std::fs::read(&settings_path) {
        Ok(b) => b,
        Err(_) => return Ok(false), // absent ⇒ not installed
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => Ok(hook_is_installed(&value)),
        Err(_) => Ok(false), // unparseable ⇒ can't confirm our entry
    }
}

/// Read `settings.json` into a `serde_json::Value`, distinguishing the two failure modes so a
/// momentarily-corrupt file can NEVER be clobbered:
///   - file ABSENT ⇒ `Ok({})` (a fresh, empty settings object — nothing to preserve);
///   - file present + reads but FAILS to parse ⇒ `Err(...)` so install/uninstall refuse to write
///     (mirrors the non-destructive degrade of `load_cwd_cache`/`load_read_state`, which never
///     rewrite a corrupt file);
///   - file parses ⇒ `Ok(value)`.
pub(crate) fn read_settings_value(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        // INVARIANT[settings-refuse-on-unparseable] (runtime-guard): `read_settings_value` returns Err on a present-but-unparseable settings file (leaving it byte-for-byte untouched) and Ok({}) when absent; install/uninstall then refuse to write by propagating that Err via `?`. The guard is test-pinned; the `?` propagation at the two call sites (install_hook, uninstall_hook) is relied upon, not unit-exercised, because both are Tauri-command-bound to the real home dir.
        //   prevents: install/uninstall merging over — clobbering — a momentarily-corrupt user ~/.claude/settings.json.
        //   test: read_settings_value_refuses_unparseable_and_defaults_absent
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "~/.claude/settings.json is not valid JSON — refusing to modify it to avoid \
             clobbering your config"
                .to_string()
        }),
        Err(_) => Ok(Value::Object(serde_json::Map::new())), // absent ⇒ fresh object
    }
}

/// Best-effort backup of an existing, parseable settings file to
/// `~/.claude/settings.json.plan-reader.bak` before we rewrite it. A backup-write failure is
/// logged and ignored — it must never abort the install/uninstall (the merge itself is the
/// safety-critical step). No-op when the source file does not exist.
fn backup_settings(settings_path: &Path) {
    if !settings_path.exists() {
        return;
    }
    let backup_path = settings_path.with_file_name("settings.json.plan-reader.bak");
    if let Err(e) = std::fs::copy(settings_path, &backup_path) {
        eprintln!("[settings] backup to {} failed: {e}", backup_path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::unique_dir;

    const TEST_HOOK_CMD: &str = "/Users/me/.claude/plan-reader/hook.sh";

    #[test]
    fn read_settings_value_refuses_unparseable_and_defaults_absent() {
        let dir = unique_dir("persSettings");

        // Present but unparseable ⇒ Err, so install/uninstall refuse to write over it.
        let corrupt = dir.join("settings.json");
        let garbage: &[u8] = b"{ not : valid json @@@ ";
        std::fs::write(&corrupt, garbage).expect("write garbage");
        assert!(
            read_settings_value(&corrupt).is_err(),
            "a present-but-corrupt settings file must yield Err (refuse to clobber)"
        );
        // The guard is read-only: the corrupt file is left byte-for-byte untouched. This is the
        // clobber pin at the guard tier; the refuse-to-write at the install/uninstall call sites
        // is carried by `?` propagation (see settings-refuse-on-unparseable), not exercised here.
        let after = std::fs::read(&corrupt).expect("corrupt file still present");
        assert_eq!(after, garbage, "read_settings_value must not rewrite the corrupt file");

        // Absent ⇒ Ok(empty object): nothing to preserve, a fresh merge target.
        let absent = dir.join("does-not-exist.json");
        let value = read_settings_value(&absent).expect("absent settings ⇒ Ok");
        assert_eq!(
            value,
            Value::Object(serde_json::Map::new()),
            "absent settings file must default to an empty object"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The user's real settings shape — the merge fixture. Kept as a fn so each test gets a
    /// fresh, unmutated copy.
    fn settings_fixture() -> Value {
        serde_json::json!({
            "permissions": { "defaultMode": "auto" },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 /Users/me/.claude/hooks/claude_permission_hook.py", "timeout": 5000 } ] }
                ],
                "PostToolUse": [
                    { "matcher": "ExitPlanMode", "hooks": [ { "type": "command", "command": "~/.claude/scripts/plan-tree-save-plan.sh", "timeout": 5000 } ] }
                ]
            },
            "worktree": { "bgIsolation": "none" },
            "statusLine": { "type": "command", "command": "echo hi" },
            "effortLevel": "medium",
            "promptSuggestionEnabled": false,
            "voice": { "enabled": true, "mode": "hold" },
            "theme": "dark-daltonized",
            "skipAutoPermissionPrompt": true,
            "voiceEnabled": true
        })
    }

    /// Locate the ExitPlanMode element within hooks.PreToolUse, if present.
    fn find_exit_plan_mode(settings: &Value) -> Option<&Value> {
        settings["hooks"]["PreToolUse"]
            .as_array()?
            .iter()
            .find(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("ExitPlanMode"))
    }

    /// merge_install_hook must (a) preserve the Bash security hook, (b) preserve the
    /// PostToolUse/ExitPlanMode entry, (c) leave every unrelated top-level key byte-equal, and
    /// (d) add a new ExitPlanMode PreToolUse entry with our command + timeout 600.
    #[test]
    fn merge_install_preserves_everything_and_adds_our_hook() {
        let input = settings_fixture();
        let merged = merge_install_hook(input.clone(), TEST_HOOK_CMD);

        // (a) The Bash PreToolUse entry is still present and UNCHANGED.
        let bash = merged["hooks"]["PreToolUse"]
            .as_array()
            .expect("PreToolUse array")
            .iter()
            .find(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("Bash"))
            .expect("Bash matcher must survive the merge (security hook)");
        assert_eq!(
            bash, &input["hooks"]["PreToolUse"][0],
            "the Bash security hook must be byte-equal after merge"
        );

        // (b) PostToolUse/ExitPlanMode is unchanged.
        assert_eq!(
            merged["hooks"]["PostToolUse"], input["hooks"]["PostToolUse"],
            "PostToolUse must be untouched by a PreToolUse merge"
        );

        // (c) Every unrelated top-level key is byte-equal to the input.
        for key in [
            "worktree",
            "statusLine",
            "effortLevel",
            "promptSuggestionEnabled",
            "voice",
            "theme",
            "skipAutoPermissionPrompt",
            "voiceEnabled",
            "permissions",
        ] {
            assert_eq!(
                merged[key], input[key],
                "top-level key {key:?} must be preserved byte-equal"
            );
        }

        // (d) A new ExitPlanMode entry under PreToolUse with our command + timeout 600.
        let exit = find_exit_plan_mode(&merged).expect("ExitPlanMode now in PreToolUse");
        let our_entry = exit["hooks"]
            .as_array()
            .expect("ExitPlanMode hooks array")
            .iter()
            .find(|h| h.get("command").and_then(|c| c.as_str()) == Some(TEST_HOOK_CMD))
            .expect("our command must be present");
        assert_eq!(our_entry["type"], Value::from("command"));
        assert_eq!(our_entry["command"], Value::from(TEST_HOOK_CMD));
        assert_eq!(our_entry["timeout"], Value::from(600), "timeout must be 600");
    }

    /// Applying merge_install_hook twice equals applying it once — no duplicate entry.
    #[test]
    fn merge_install_is_idempotent() {
        let once = merge_install_hook(settings_fixture(), TEST_HOOK_CMD);
        let twice = merge_install_hook(once.clone(), TEST_HOOK_CMD);
        assert_eq!(once, twice, "install must be idempotent");

        // And there is exactly ONE ExitPlanMode entry with our command.
        let exit = find_exit_plan_mode(&twice).expect("ExitPlanMode present");
        let count = exit["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|h| h.get("command").and_then(|c| c.as_str()) == Some(TEST_HOOK_CMD))
            .count();
        assert_eq!(count, 1, "no duplicate plan-reader hook entry");
    }

    /// When PreToolUse ALREADY has an ExitPlanMode matcher (with a different command), install
    /// APPENDS our entry to that matcher's hooks and preserves the existing command.
    #[test]
    fn merge_install_appends_to_existing_exit_plan_mode_matcher() {
        let mut fixture = settings_fixture();
        // Add an ExitPlanMode matcher to PreToolUse with some OTHER command.
        let other = serde_json::json!({
            "matcher": "ExitPlanMode",
            "hooks": [ { "type": "command", "command": "/some/other/exit-hook.sh", "timeout": 30 } ]
        });
        fixture["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(other);

        let merged = merge_install_hook(fixture, TEST_HOOK_CMD);
        let exit = find_exit_plan_mode(&merged).expect("ExitPlanMode present");
        let cmds: Vec<&str> = exit["hooks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
            .collect();
        assert!(
            cmds.contains(&"/some/other/exit-hook.sh"),
            "the pre-existing ExitPlanMode command must be preserved"
        );
        assert!(
            cmds.contains(&TEST_HOOK_CMD),
            "our command must be appended to the existing matcher"
        );
        // There must be exactly ONE ExitPlanMode matcher element (appended, not duplicated).
        let exit_count = merged["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|el| el.get("matcher").and_then(|m| m.as_str()) == Some("ExitPlanMode"))
            .count();
        assert_eq!(exit_count, 1, "must append into the existing matcher, not add a second");
    }

    /// uninstall after install restores the hooks for our concern: our entry gone, Bash +
    /// PostToolUse intact. Since install ADDED a brand-new ExitPlanMode element whose only
    /// entry was ours, uninstall removes that element entirely — yielding the original hooks.
    #[test]
    fn uninstall_after_install_restores_original_hooks() {
        let original = settings_fixture();
        let installed = merge_install_hook(original.clone(), TEST_HOOK_CMD);
        let uninstalled = merge_uninstall_hook(installed);

        // Our entry is gone (no ExitPlanMode element under PreToolUse anymore).
        assert!(
            find_exit_plan_mode(&uninstalled).is_none(),
            "the installed ExitPlanMode PreToolUse element must be removed on uninstall"
        );

        // Bash + the whole hooks block match the original for our concern.
        assert_eq!(
            uninstalled["hooks"]["PreToolUse"], original["hooks"]["PreToolUse"],
            "PreToolUse must return to its original state (Bash intact, our element gone)"
        );
        assert_eq!(
            uninstalled["hooks"]["PostToolUse"], original["hooks"]["PostToolUse"],
            "PostToolUse must be untouched"
        );
        // Whole document equals the original.
        assert_eq!(uninstalled, original, "uninstall must fully restore the original settings");
    }

    /// Uninstall is idempotent — applying it a second time is a no-op.
    #[test]
    fn merge_uninstall_is_idempotent() {
        let installed = merge_install_hook(settings_fixture(), TEST_HOOK_CMD);
        let once = merge_uninstall_hook(installed);
        let twice = merge_uninstall_hook(once.clone());
        assert_eq!(once, twice, "uninstall must be idempotent (removing twice = no-op)");
    }

    /// `hook_is_installed` must be FALSE for the user's real settings (which has a Bash PreToolUse
    /// hook + a PostToolUse/ExitPlanMode hook, but NO plan-reader entry), and TRUE after
    /// `merge_install_hook` adds our entry. Falsifiability proven by inverting the assertion:
    /// the fixture passes only because no command ends with the suffix, and the
    /// merged value passes only because our command does — flipping either `assert!`/`assert!(!…)`
    /// turns the test red.
    #[test]
    fn hook_is_installed_detects_only_our_entry() {
        let fixture = settings_fixture();
        assert!(
            !hook_is_installed(&fixture),
            "the real-settings fixture (Bash PreToolUse + PostToolUse/ExitPlanMode, NO plan-reader \
             hook) must NOT be detected as installed"
        );

        let installed = merge_install_hook(fixture, TEST_HOOK_CMD);
        assert!(
            hook_is_installed(&installed),
            "after merge_install_hook adds our plan-reader/hook.sh command, it MUST be detected"
        );
    }

    /// `hook_is_installed` must not panic and must return `false` on odd / non-object shapes, and
    /// must reject an ExitPlanMode matcher whose only command does NOT end with our suffix.
    #[test]
    fn hook_is_installed_false_on_odd_shapes() {
        assert!(!hook_is_installed(&Value::Null));
        assert!(!hook_is_installed(&serde_json::json!([1, 2, 3])));
        assert!(!hook_is_installed(&serde_json::json!({ "hooks": "not-an-object" })));
        assert!(!hook_is_installed(&serde_json::json!({ "hooks": { "PreToolUse": {} } })));
        // ExitPlanMode matcher present, but the command is someone ELSE's hook → not ours.
        let foreign = serde_json::json!({
            "hooks": { "PreToolUse": [
                { "matcher": "ExitPlanMode", "hooks": [
                    { "type": "command", "command": "/some/other/exit-hook.sh", "timeout": 30 }
                ] }
            ] }
        });
        assert!(
            !hook_is_installed(&foreign),
            "an ExitPlanMode matcher whose command is not ours must NOT count as installed"
        );
        // Our suffix under a NON-ExitPlanMode matcher must also not count.
        let wrong_matcher = serde_json::json!({
            "hooks": { "PreToolUse": [
                { "matcher": "Bash", "hooks": [
                    { "type": "command", "command": "/x/plan-reader/hook.sh" }
                ] }
            ] }
        });
        assert!(
            !hook_is_installed(&wrong_matcher),
            "our suffix under a non-ExitPlanMode matcher must NOT count as installed"
        );
    }

}
