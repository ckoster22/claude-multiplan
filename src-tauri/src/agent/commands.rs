// The Tauri command surface for the agent driver: the 9 `#[tauri::command]`s the
// frontend invokes, plus OAuth token persistence (agent-auth.json, atomic
// temp-write+rename, mode 0600 — NEVER written into `~/.claude`).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

use super::driver::{
    offload_drain, spawn_read_task, store_then_send, AgentDriver, DrainTarget, DRAIN_TIMEOUT,
    SESSION_SEQ, SIDECAR_NAME,
};
use super::protocol::{build_user_line, set_model_command_json, start_command_json, ImageInput};

/// Token store filename under the app-data dir. NEVER written into `~/.claude`.
const AUTH_FILE: &str = "agent-auth.json";

#[derive(Serialize, serde::Deserialize, Default)]
struct AuthFile {
    token: Option<String>,
}

fn auth_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(AUTH_FILE))
}

fn load_token(app: &AppHandle) -> Option<String> {
    let path = auth_path(app)?;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<AuthFile>(&bytes).ok()?.token
}

/// Atomic temp-write + rename, then chmod 0600. Mirrors the lib.rs cwd-cache
/// pattern; degrades (returns Err) on any I/O failure — never panics.
fn store_token(app: &AppHandle, token: &str) -> Result<(), String> {
    let path = auth_path(app).ok_or("app_data_dir unavailable")?;
    let parent = path.parent().ok_or("auth path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create app_data_dir: {e}"))?;

    let body = serde_json::to_vec(&AuthFile {
        token: Some(token.to_string()),
    })
    .map_err(|e| format!("serialize auth: {e}"))?;

    let tmp = parent.join(format!(".tmp-agent-auth-{}", std::process::id()));
    std::fs::write(&tmp, &body).map_err(|e| format!("write temp auth: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename auth into place: {e}")
    })?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

type DriverState<'a> = State<'a, Mutex<Option<(u64, AgentDriver)>>>;

/// Spawn the sidecar (if needed) and begin one streaming session rooted at
/// `cwd`, in `permission_mode`. Validates `cwd` is an existing directory (an
/// unvalidated cwd later becomes the `acceptEdits` scope — a security footgun).
/// One session per launch: a second start while a session is live is REJECTED.
#[tauri::command]
pub fn start_agent_session(
    app: AppHandle,
    state: DriverState<'_>,
    cwd: String,
    permission_mode: String,
    // Header-picker selection. Tauri maps JS camelCase `model`/`effort`.
    // None when no picker value is supplied; serde emits `null` and the sidecar
    // treats null/absent as "not set".
    model: Option<String>,
    effort: Option<String>,
    // Resume an in-progress SDK conversation. Tauri maps JS camelCase
    // `resumeSessionId`. None when starting fresh; serde emits `null`, forwarded
    // as `"resume"` in the start JSON. The one-session-per-launch guard is
    // UNCHANGED — resume only adds a flag to the start command.
    resume_session_id: Option<String>,
) -> Result<(), String> {
    // One-session-per-launch: reject if already live.
    {
        let guard = state.lock().map_err(|_| "driver state poisoned")?;
        if guard.is_some() {
            return Err("a session is already running (one session per launch)".into());
        }
    }

    // Validate cwd is an existing directory.
    if !Path::new(&cwd).is_dir() {
        let _ = app.emit(
            "agent-error",
            serde_json::json!({
                "kind": "cwd",
                "message": format!("cwd is not an existing directory: {cwd}"),
                "fatal": true,
            }),
        );
        return Err(format!("cwd is not an existing directory: {cwd}"));
    }

    // No stored token -> onboarding signal (02 shows `claude setup-token`).
    let token = match load_token(&app) {
        Some(t) => t,
        None => {
            let _ = app.emit("agent-auth-required", serde_json::json!({}));
            return Err("no OAuth token stored".into());
        }
    };

    // Spawn the sidecar, injecting CLAUDE_CODE_OAUTH_TOKEN into the child env
    // (the spawned CLI inherits it). We never set ANTHROPIC_API_KEY.
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|e| format!("resolve sidecar: {e}"))?
        .env("CLAUDE_CODE_OAUTH_TOKEN", token);

    let (rx, child) = command.spawn().map_err(|e| format!("spawn sidecar: {e}"))?;

    // Stamp this session with a fresh id (the read task carries the SAME id so it
    // only releases the slot it owns). One fetch_add — never call it twice.
    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);

    // Teardown-drain seam: the read task fires `terminated_tx` when it
    // sees `CommandEvent::Terminated`; the driver keeps `terminated_rx` so the
    // graceful-drain in end_agent_session/shutdown_session can await the child's exit before any
    // SIGKILL fallback.
    let (terminated_tx, terminated_rx) = oneshot::channel::<()>();

    // Store the child, then send the `start` command — committing the driver to the slot ONLY if
    // the send succeeds. If the send fails, `store_then_send` pulls the driver back out (leaving the
    // slot `None`, so the one-session-per-launch guard is NOT phantom-locked) and hands it back so we
    // can kill the orphaned child here before propagating the error.
    let driver = AgentDriver::new(child, terminated_rx);
    let start_line =
        start_command_json(&cwd, &permission_mode, &model, &effort, &resume_session_id);
    if let Err((dead, e)) =
        store_then_send(&state, id, driver, |d| d.send_line(&start_line))
    {
        // Best-effort kill of the just-spawned child so it is not leaked. `terminated_tx` is dropped
        // here (the read task is never spawned), which is correct — there is no read task to wire it
        // to. `kill` consumes the driver (mirrors CommandChild::kill(self)).
        let _ = dead.kill();
        return Err(e);
    }

    // Start the read task AFTER the child is committed (it owns its own rx). Reached only on a
    // successful send, so the success path is identical to before: driver in the slot, read task
    // spawned with the matching id and the terminated sender.
    spawn_read_task(app, rx, id, Some(terminated_tx));
    Ok(())
}

/// Push a user turn into the streaming-input queue.
///
/// `images` is OPTIONAL and additive: the frontend invokes
/// `invoke("send_agent_message", { text, images })` where `images` is `[{media_type, data}, …]`
/// or omitted. When omitted, the wire line carries no `images` key (see `build_user_line`).
#[tauri::command]
pub fn send_agent_message(
    state: DriverState<'_>,
    text: String,
    images: Option<Vec<ImageInput>>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    // DIAGNOSTIC (minecraft-clone halt investigation): log every send_agent_message so a real run
    // reveals whether the sizer prompt (turn #2) is ever sent — i.e. whether RECON_DONE advanced the
    // orchestrator. The recon prompt is send #1; if no send #2 appears the run halted at recon.
    let preview: String = text.chars().take(60).collect();
    eprintln!(
        "[agent:diag] send_agent_message ({} chars, {} images) first60={preview:?}",
        text.len(),
        images.as_ref().map(|v| v.len()).unwrap_or(0)
    );
    driver.send_line(&build_user_line(&text, images.as_deref()))
}

/// Answer a pending `tool-permission-requested` (the canUseTool seam).
///
/// `updated_input` is optional and used by the interactive tools that return data on allow —
/// notably `AskUserQuestion`, where the host resolves with `{ questions, answers }`. When `None`
/// the field is OMITTED from the JSON line (the sidecar then echoes the stored tool input, the
/// existing ExitPlanMode behavior). Backward-compatible: callers that pass only `id`/`allow`/
/// `message` are unchanged.
#[tauri::command]
pub fn resolve_tool_permission(
    state: DriverState<'_>,
    id: String,
    allow: bool,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    let mut line = serde_json::json!({
        "type": "resolve-tool-permission",
        "id": id,
        "allow": allow,
        "message": message,
    });
    // Only attach updatedInput when provided — keep the wire shape backward-compatible (None → omit).
    if let Some(updated) = updated_input {
        if let Value::Object(map) = &mut line {
            map.insert("updatedInput".to_string(), updated);
        }
    }
    driver.send_line(&line)
}

/// Mid-session `q.setPermissionMode(mode)`.
#[tauri::command]
pub fn set_agent_permission_mode(state: DriverState<'_>, mode: String) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    driver.send_line(&serde_json::json!({ "type": "set-permission-mode", "mode": mode }))
}

/// Mid-session `q.setModel(model)` — the sibling of `set_agent_permission_mode`.
#[tauri::command]
pub fn set_agent_model(state: DriverState<'_>, model: String) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    driver.send_line(&set_model_command_json(&model))
}

/// Graceful `q.interrupt()` of the current turn.
#[tauri::command]
pub fn cancel_agent_run(state: DriverState<'_>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
    let driver = guard.as_mut().map(|(_, d)| d).ok_or("no active session")?;
    driver.send_line(&serde_json::json!({ "type": "interrupt" }))
}

/// End the session for this launch, draining the agent tree gracefully:
/// send `{"type":"end"}`, wait a bounded interval for the child to exit on its
/// own (the sidecar's `end`-command handler closes the SDK query, whose reaper
/// SIGTERMs the `claude` grandchild — never orphaning it), and SIGKILL only as
/// the timeout fallback.
///
/// This is the INTERACTIVE path (the UI's Stop/Cancel/end-session). It clears the
/// singleton slot synchronously, then OFFLOADS the bounded drain to a background
/// task and returns AT ONCE — so a wedged child can never freeze the UI for
/// `DRAIN_TIMEOUT`. (App-quit takes the opposite trade-off: `shutdown_session`
/// `block_on`s the same drain so the process does not exit before the agent tree
/// winds down.)
#[tauri::command]
pub fn end_agent_session(state: DriverState<'_>) -> Result<(), String> {
    // Take the driver out under the lock so the slot is cleared immediately and
    // the spawned drain owns the child exclusively (no second drain, no lock held
    // across the wait).
    let taken = {
        let mut guard = state.lock().map_err(|_| "driver state poisoned")?;
        guard.take()
    };
    if let Some((_, mut driver)) = taken {
        // If the read task already saw Terminated it freed the receiver — the
        // child is gone; a closed channel makes the drain fall straight through
        // (send_end no-ops, kill is harmless).
        let terminated = driver.take_terminated().unwrap_or_else(|| {
            let (_tx, rx) = oneshot::channel::<()>(); // tx dropped → rx resolves Err.
            rx
        });
        // Non-blocking: the bounded drain (+ SIGKILL fallback) runs detached on
        // the async runtime; this command returns without waiting for it, so the
        // UI never stalls up to DRAIN_TIMEOUT on a wedged child.
        offload_drain(driver, terminated, DRAIN_TIMEOUT);
    }
    Ok(())
}

/// Report whether an OAuth token is stored (drives onboarding in 02).
#[tauri::command]
pub fn agent_auth_status(app: AppHandle) -> Result<Value, String> {
    Ok(serde_json::json!({ "hasToken": load_token(&app).is_some() }))
}

/// Persist the CLAUDE_CODE_OAUTH_TOKEN (injected into the sidecar env on next start).
#[tauri::command]
pub fn set_agent_oauth_token(app: AppHandle, token: String) -> Result<(), String> {
    store_token(&app, &token)
}
