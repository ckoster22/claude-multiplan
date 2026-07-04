// Agent SDK driver — process lifecycle and ownership.
//
// This is one of three modules under `agent/`: `protocol` owns the pure wire
// encode/decode, `commands` owns the 9 Tauri commands + OAuth token
// persistence, and this module owns the process side of the driver:
//   - the AgentDriver struct (CommandChild + bookkeeping) in Mutex<Option<…>>
//   - the sidecar read task (recv -> parse -> emit)
//   - the graceful teardown drain (`drain_child`/`offload_drain`/`shutdown_session`)
//
// The sidecar normalizes the SDK's message union into a small wire vocabulary;
// Rust never interprets the SDK shapes — it parses one JSON line per stdout
// event (via `protocol::parse_stream_line`) and RE-EMITS it onto the
// appropriate Tauri event, nothing more.

use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tokio::sync::oneshot;

use super::protocol::{parse_stream_line, AgentEvent};

/// Bounded interval the teardown drain waits for the sidecar (and, transitively,
/// its `claude` grandchild) to exit gracefully after the `end` line, before
/// falling back to SIGKILL. Kept short so app shutdown can never hang on a wedged
/// child, yet long enough for the SDK's `process.on("exit")` reaper to SIGTERM the
/// grandchild and for both to wind down.
pub(crate) const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// The sidecar's `externalBin` base name (tauri appends the target triple).
pub(crate) const SIDECAR_NAME: &str = "agent-driver";

/// Process-wide monotonic session id. Each `start_agent_session` stamps the
/// stored driver with the next value; the read task carries that same id so it
/// only releases the slot for the session it owns (never a successor's).
pub(crate) static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

/// Take the value out of `slot` IFF its stored id equals `my_id`; otherwise
/// leave the slot untouched and return `None`. Poison-safe (a poisoned lock is
/// treated as "nothing to take"). This is the natural-death release primitive:
/// the read task calls it on `Terminated` so a session that ended on its own
/// frees the singleton — but a newer session that already replaced it is left
/// alone (id mismatch).
fn take_if_current<T>(slot: &Mutex<Option<(u64, T)>>, my_id: u64) -> Option<T> {
    let mut guard = slot.lock().ok()?;
    match &*guard {
        Some((id, _)) if *id == my_id => guard.take().map(|(_, t)| t),
        _ => None,
    }
}

/// Store `driver` (stamped with `id`) into the singleton `slot`, then run `send` against the just-
/// stored driver. On send SUCCESS the driver stays in the slot and `Ok(())` is returned (the read
/// task is wired up by the caller afterward). On send FAILURE the driver is TAKEN BACK OUT of the
/// slot (`take_if_current`, id-matched so a racing successor is never clobbered) and returned to the
/// caller as `Err((driver, message))` so it can kill/drain the orphaned child — leaving the slot
/// `None` so the one-session-per-launch guard is NOT phantom-locked for the rest of the launch.
///
/// ROOT CAUSE this fixes: the old code stored the driver and only THEN sent the start line; a send
/// failure (`?`) returned early with the slot still `Some(dead-driver)`. With no read task ever
/// spawned, the natural-death `Terminated` handler that frees the slot could never fire, so every
/// subsequent `start_agent_session` was rejected with "already running" until an app restart.
///
/// Generic over the driver type + the send closure so the store→send→rollback ordering is unit-
/// testable with a fake driver and an injectable failing send (the real `AgentDriver::send_line`
/// needs a `CommandChild` that cannot be constructed in a test).
pub(crate) fn store_then_send<T, F>(
    slot: &Mutex<Option<(u64, T)>>,
    id: u64,
    driver: T,
    send: F,
) -> Result<(), (T, String)>
where
    F: FnOnce(&mut T) -> Result<(), String>,
{
    let mut guard = match slot.lock() {
        Ok(g) => g,
        Err(_) => return Err((driver, "driver state poisoned".to_string())),
    };
    *guard = Some((id, driver));
    // Borrow the just-stored driver and attempt the send while STILL HOLDING the lock, so no
    // concurrent start can observe a half-initialized slot — and so the rollback below can pull the
    // driver back out without ever releasing the lock (race-free).
    let stored = guard.as_mut().map(|(_, d)| d).expect("just inserted");
    if let Err(e) = send(stored) {
        // Roll back under the same lock: free the slot and hand the driver to the caller for child
        // teardown, so the slot is left `None` (not phantom-locked).
        let recovered = guard.take().map(|(_, d)| d).expect("just inserted");
        return Err((recovered, e));
    }
    Ok(())
}

/// The live session's child handle plus bookkeeping. One per app launch.
pub struct AgentDriver {
    child: CommandChild,
    /// Fired (Ok) by the read task when it observes `CommandEvent::Terminated`,
    /// so the teardown drain can `block_on(timeout(.., terminated))` and SIGKILL
    /// only as the fallback. `Some` until the drain consumes it (it is `take`n
    /// during `drain_child`). A `None` here means the read task already saw the
    /// child exit and freed the slot — there is nothing left to drain.
    terminated: Option<oneshot::Receiver<()>>,
}

impl AgentDriver {
    /// Construct a driver around a freshly-spawned child and its teardown
    /// `Terminated` receiver. Keeps `child`/`terminated` private — the crate
    /// gets an honest constructor instead of a struct literal reaching into
    /// private fields from `commands.rs`.
    pub(crate) fn new(child: CommandChild, terminated: oneshot::Receiver<()>) -> AgentDriver {
        AgentDriver {
            child,
            terminated: Some(terminated),
        }
    }

    /// Take the teardown `Terminated` receiver out of the driver (consumed by
    /// the interactive `end_agent_session` drain). `None` if the read task
    /// already observed the exit and the receiver was consumed.
    pub(crate) fn take_terminated(&mut self) -> Option<oneshot::Receiver<()>> {
        self.terminated.take()
    }

    /// Write one JSON-line command to the child's stdin. Each command is a
    /// single line terminated by `\n` (the sidecar reads line-by-line).
    pub(crate) fn send_line(&mut self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| format!("serialize command: {e}"))?;
        line.push(b'\n');
        self.child
            .write(&line)
            .map_err(|e| format!("write to sidecar stdin: {e}"))
    }
}

// Graceful teardown drain.
//
// ROOT CAUSE this fixes: teardown used to call `CommandChild::kill()` = SIGKILL,
// which is uncatchable — so the SDK's `process.on("exit")` reaper inside the
// sidecar never ran, and its `claude` grandchild orphaned (a token-burning CLI
// process surviving app quit). The fix is: send `{"type":"end"}` (NOT a signal —
// this stdin line is the PRIMARY teardown trigger), give the child a bounded
// interval to exit on its own — the sidecar's `end`/SIGTERM/SIGINT/stdin-close
// paths all route through one awaited drain that closes the SDK query, which
// makes the SDK's reaper SIGTERM the `claude` grandchild — and SIGKILL only if
// that interval elapses.
//
// `tauri-plugin-shell::CommandChild` exposes only `write`/`kill(self)`/`pid` —
// no `try_wait`/`wait`, and `kill(self)` CONSUMES the child — so child exit is
// observable ONLY via `CommandEvent::Terminated` on the plugin's `Receiver`,
// which the read task owns. The read task fires a `oneshot` on Terminated; the
// drain awaits it. `DrainTarget` abstracts "send the end line" + "consume-by-kill"
// so the ordering is unit-testable with a fake (the real CommandChild's
// kill-by-value can't be mocked otherwise).

/// The two teardown operations the drain performs on the session child, factored
/// behind a trait so the ORDER (`send_end` then, only on timeout, `kill`) is
/// testable with a recording fake. `kill` takes `self` to mirror
/// `CommandChild::kill(self)` (which consumes the child).
pub(crate) trait DrainTarget {
    /// Best-effort `{"type":"end"}` to the child's stdin (graceful end).
    fn send_end(&mut self) -> Result<(), String>;
    /// Force-kill (SIGKILL). Consumes the target — the fallback only.
    fn kill(self) -> Result<(), String>;
}

impl DrainTarget for AgentDriver {
    fn send_end(&mut self) -> Result<(), String> {
        self.send_line(&serde_json::json!({ "type": "end" }))
    }
    fn kill(self) -> Result<(), String> {
        self.child
            .kill()
            .map_err(|e| format!("kill sidecar: {e}"))
    }
}

/// Drain one session child gracefully: send `end`, await the read task's
/// `Terminated` signal for up to `timeout`, and SIGKILL ONLY if it does not
/// arrive (timeout) or the channel closed without an exit being observed.
/// Bounded by construction — a wedged child cannot hang shutdown past `timeout`.
///
/// Reused from BOTH teardown paths: the app-quit path (`shutdown_session`)
/// `block_on`s this so quit waits for the drain; the interactive path
/// (`end_agent_session`) `spawn`s it onto a background task so the UI never
/// blocks (see `offload_drain`). The drain is identical either way.
async fn drain_child<C: DrainTarget>(
    mut child: C,
    terminated: oneshot::Receiver<()>,
    timeout: Duration,
) {
    // Always attempt the graceful end FIRST (before any kill). A write failure
    // (child already gone) is non-fatal — we still wait/kill as needed.
    let _ = child.send_end();

    // Wait for the read task's Terminated signal, bounded. `Ok(Ok(()))` = the
    // child exited on its own → done, NO kill. A timeout (`Err(_)`) or a closed
    // channel (`Ok(Err(_))`, sender dropped without firing) → fall back to kill.
    match tokio::time::timeout(timeout, terminated).await {
        Ok(Ok(())) => {} // graceful exit observed — leave the (already-dead) child be.
        _ => {
            let _ = child.kill();
        }
    }
}

/// Offload a bounded `drain_child` onto a background task and return IMMEDIATELY
/// (non-blocking). The INTERACTIVE end path (`end_agent_session`, driven by the
/// UI's Stop/Cancel) uses this so a wedged child can NEVER freeze the UI for
/// `DRAIN_TIMEOUT` — the drain (and its SIGKILL fallback) runs detached on the
/// async runtime while the command returns at once. Distinct from the app-quit
/// path (`shutdown_session`), which deliberately `block_on`s the SAME drain so
/// the process does not exit before the agent tree winds down.
///
/// The caller has already `take`n the driver out of the singleton slot, so the
/// task owns it exclusively — there is no second drain and the slot is already
/// cleared. `C: Send + 'static` because the future is moved onto another thread.
pub(crate) fn offload_drain<C: DrainTarget + Send + 'static>(
    child: C,
    terminated: oneshot::Receiver<()>,
    timeout: Duration,
) {
    tauri::async_runtime::spawn(async move {
        drain_child(child, terminated, timeout).await;
    });
}

// Read task — recv -> parse -> emit ONLY. Never blocks on app state or awaits a
// permission resolution (the plugin's event channel is capacity-1, shared by
// stdout/stderr/terminate; blocking it would backpressure and hang the sidecar).
// Permission replies arrive over a SEPARATE path: resolve_tool_permission ->
// child stdin, not through this loop.

pub(crate) fn spawn_read_task(
    app: AppHandle,
    mut rx: Receiver<CommandEvent>,
    my_id: u64,
    // Fired once when the child terminates so the teardown drain can stop waiting
    // and skip the SIGKILL fallback. `Option` because it is consumed on the single
    // `Terminated` event (a oneshot Sender's `send` takes `self`).
    mut terminated_tx: Option<oneshot::Sender<()>>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    match parse_stream_line(&line) {
                        Ok(None) => {} // whitespace-only artifact (e.g. "\n") — skip.
                        Ok(Some(AgentEvent::PermissionRequested(v))) => {
                            let _ = app.emit("tool-permission-requested", v);
                        }
                        Ok(Some(AgentEvent::Error(v))) => {
                            let _ = app.emit("agent-error", v);
                        }
                        Ok(Some(AgentEvent::Stream(v))) => {
                            // DIAGNOSTIC (minecraft-clone halt investigation): log every agent-stream
                            // frame kind emitted to the frontend. For `result` frames also log the
                            // subtype / is_error / parent_tool_use_id so we can see whether the recon
                            // turn (which used the scope-recon subagent) emits a turn-ending top-level
                            // `result` at all — and what shape it carries. Log-only; no behavior change.
                            let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("?");
                            if kind == "result" {
                                eprintln!(
                                    "[agent:diag] emit agent-stream kind=result subtype={:?} is_error={:?} parent_tool_use_id={:?}",
                                    v.get("subtype"),
                                    v.get("is_error"),
                                    v.get("parent_tool_use_id"),
                                );
                            } else {
                                eprintln!("[agent:diag] emit agent-stream kind={kind}");
                            }
                            let _ = app.emit("agent-stream", v);
                        }
                        Err(diag) => {
                            // Contamination diagnostic — surface, never silently drop.
                            eprintln!("[agent] {diag}");
                            let _ = app.emit(
                                "agent-error",
                                serde_json::json!({
                                    "kind": "contamination",
                                    "message": diag,
                                    "fatal": false,
                                }),
                            );
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    // The sidecar's own diagnostics + the CLI child's stderr.
                    // Forward to logs; never onto an event channel.
                    eprint!("[agent:sidecar] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app.emit("agent-exit", serde_json::json!({ "code": payload.code }));
                    // Signal the teardown drain that the child has exited,
                    // so a concurrent `block_on(timeout(.., terminated_rx))` returns
                    // immediately and skips the SIGKILL fallback. Fire-and-forget:
                    // if the receiver was already dropped (no drain in flight, the
                    // common natural-death case) the send simply returns Err.
                    if let Some(tx) = terminated_tx.take() {
                        let _ = tx.send(());
                    }
                    // Natural death: release the singleton slot so the UI's
                    // "New plan" re-enable matches a backend that no longer
                    // holds a dead driver. Only frees THIS session's slot (id
                    // match) — a successor that already replaced it is left
                    // alone. Synchronous, no `.await` held across the lock.
                    if let Some(state) = app.try_state::<Mutex<Option<(u64, AgentDriver)>>>() {
                        let _ = take_if_current(&state, my_id);
                    }
                    break;
                }
                CommandEvent::Error(e) => {
                    let _ = app.emit(
                        "agent-error",
                        serde_json::json!({ "kind": "io", "message": e, "fatal": true }),
                    );
                }
                _ => {}
            }
        }
    });
}

// Teardown — called from lib.rs on RunEvent::Exit/ExitRequested.
//
// GUARANTEED BEHAVIOR: quitting the app sends the sidecar a graceful
// `{"type":"end"}` and waits a BOUNDED `DRAIN_TIMEOUT` for it (and its `claude`
// grandchild) to exit before SIGKILLing only as a fallback. The sidecar's
// `end`-command handler routes through one awaited drain that closes the SDK
// query, whose reaper SIGTERMs the grandchild — so a normal quit leaves NO
// orphaned `claude` or sidecar process. Only a sidecar that ignores `end` AND
// outlives the bounded wait is force-killed — and even then the SIGKILL is the
// last resort, not the default. (The previous code SIGKILLed immediately, which
// is uncatchable and orphaned the grandchild because the SDK's
// `process.on("exit")` reaper never ran.) The wait is bounded so a wedged child
// can never hang shutdown.
//
// Unlike the INTERACTIVE end path (`end_agent_session`, which OFFLOADS the drain
// to a background task so the UI never blocks), app-quit deliberately `block_on`s
// the bounded drain: the process must NOT exit before the agent tree has had its
// bounded chance to wind down, otherwise a spawned/detached drain would be torn
// down with the process and orphan the grandchild anyway.

pub fn shutdown_session(app: &AppHandle) {
    let taken = app
        .try_state::<Mutex<Option<(u64, AgentDriver)>>>()
        .and_then(|state| state.lock().ok().and_then(|mut guard| guard.take()));
    if let Some((_, mut driver)) = taken {
        let terminated = driver.terminated.take().unwrap_or_else(|| {
            let (_tx, rx) = oneshot::channel::<()>(); // already-gone child → resolves Err → kill fallback.
            rx
        });
        // This MUST stay a SYNC RunEvent callback (Tauri invokes it on the main
        // thread): `block_on` panics if moved onto a tokio worker thread. Outside
        // the async runtime here, so block_on is safe.
        tauri::async_runtime::block_on(drain_child(driver, terminated, DRAIN_TIMEOUT));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_if_current_releases_only_on_matching_id() {
        // (a) matching id -> Some, slot drained to None.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(Some((5, ())));
        assert_eq!(take_if_current(&slot, 5), Some(()));
        assert!(slot.lock().unwrap().is_none(), "slot must be cleared on match");

        // (b) non-matching id -> None, slot untouched.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(Some((5, ())));
        assert_eq!(take_if_current(&slot, 4), None);
        assert_eq!(
            *slot.lock().unwrap(),
            Some((5, ())),
            "slot must be preserved on id mismatch"
        );

        // (c) empty slot -> None.
        let slot: Mutex<Option<(u64, ())>> = Mutex::new(None);
        assert_eq!(take_if_current(&slot, 5), None);
    }

    // a FAILED start-command write must NOT phantom-lock the session slot.
    //
    // `start_agent_session` used to store the driver into the singleton slot and
    // only THEN send the `start` line; a send failure returned early (`?`) with the
    // slot still `Some(dead-driver)`. With no read task spawned, the natural-death
    // `Terminated` handler that frees the slot never fired, so EVERY subsequent
    // start was rejected with "already running" until an app restart.
    //
    // The fix factors store→send→on-error-rollback into `store_then_send`, which
    // commits the driver to the slot ONLY on send success and on failure pulls it
    // back out (slot → None) and returns it for child teardown. We test that
    // invariant directly with a fake driver + injectable failing send (the real
    // `AgentDriver::send_line` needs a `CommandChild` that cannot be built in a
    // test).

    /// On send SUCCESS the driver stays committed in the slot (so the read task can
    /// be wired to it) and `Ok(())` is returned. Falsifiability complement to the
    /// failure test below: proves `store_then_send` does not spuriously evict a
    /// healthy driver.
    #[test]
    fn store_then_send_keeps_driver_on_success() {
        let slot: Mutex<Option<(u64, u32)>> = Mutex::new(None);
        // The "driver" is a plain u32 sentinel; the send closure succeeds.
        let res = store_then_send(&slot, 7, 99u32, |_d| Ok(()));
        assert!(res.is_ok(), "successful send must return Ok, got {res:?}");
        assert_eq!(
            *slot.lock().unwrap(),
            Some((7, 99)),
            "a successfully-started driver must remain committed in the slot"
        );
    }

    /// On send FAILURE the slot must be left `None` (NOT phantom-locked), and the
    /// driver must be handed back to the caller for teardown along with the error
    /// message. This is the core regression test.
    ///
    /// Falsifiable: revert `store_then_send` to the buggy shape (store the driver,
    /// run the send, and on failure leave the slot occupied — i.e. drop the
    /// `guard.take()` rollback) and the `is_none()` assertion below goes RED — a
    /// subsequent start would then be rejected as "already running". (Confirmed by
    /// temporarily removing the rollback: the slot stays `Some((9, …))`.)
    #[test]
    fn store_then_send_frees_slot_on_failure() {
        let slot: Mutex<Option<(u64, u32)>> = Mutex::new(None);
        // The send closure fails — mirroring a `send_line` write error.
        let res = store_then_send(&slot, 9, 42u32, |_d| Err("write to sidecar stdin: boom".into()));

        // (1) The error carries BOTH the recovered driver (for teardown) and the message.
        match res {
            Err((recovered, msg)) => {
                assert_eq!(recovered, 42, "the driver must be returned for child teardown");
                assert_eq!(msg, "write to sidecar stdin: boom");
            }
            Ok(()) => panic!("a failed send must return Err, not Ok"),
        }

        // (2) THE INVARIANT: the slot is empty, so the one-session-per-launch guard
        // (`if guard.is_some() { reject }`) will NOT reject the next start.
        assert!(
            slot.lock().unwrap().is_none(),
            "a failed start must leave the session slot empty, not phantom-locked"
        );

        // (3) Concretely simulate the very next start's guard check: it must pass.
        {
            let guard = slot.lock().unwrap();
            assert!(
                guard.is_none(),
                "the subsequent start's `guard.is_some()` reject must NOT fire"
            );
        }
    }

    // Graceful agent-tree teardown drain ordering.
    //
    // The teardown drain (`drain_child`) MUST send `{"type":"end"}` BEFORE any
    // SIGKILL, and MUST only SIGKILL as the timeout fallback when the child has
    // not exited on its own. We test the pure ordering with a fake child that
    // records its calls — no real CommandChild (whose `kill(self)` consumes it
    // and whose exit is only observable over the plugin channel).

    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    #[derive(Debug, PartialEq, Clone)]
    enum DrainCall {
        SendEnd,
        Kill,
    }

    /// A fake child that records the drain's calls so a test can assert their
    /// ORDER (and that `kill` fires only on the timeout path).
    #[derive(Default)]
    struct FakeChild {
        calls: Arc<StdMutex<Vec<DrainCall>>>,
    }

    impl DrainTarget for FakeChild {
        fn send_end(&mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::SendEnd);
            Ok(())
        }
        fn kill(self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::Kill);
            Ok(())
        }
    }

    #[test]
    fn drain_kills_only_when_child_does_not_exit_in_time() {
        // The child NEVER signals Terminated (rx dropped) → the bounded wait
        // times out → drain falls back to kill, but ONLY after send_end. Order
        // must be exactly [SendEnd, Kill].
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        // A receiver whose sender is dropped resolves to Err immediately — but
        // we want to exercise the TIMEOUT branch, so use a never-resolving one:
        // keep the sender alive past the call so the rx only completes on timeout.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            drain_child(child, rx, Duration::from_millis(50)).await;
        });
        drop(tx); // keep `tx` alive across the drain so rx never fired early.

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "on timeout the end line MUST precede the kill, and kill is the fallback"
        );
    }

    #[test]
    fn drain_skips_kill_when_child_exits_before_timeout() {
        // The child signals Terminated (sender fired) BEFORE the timeout → the
        // graceful path completes and `kill` is NEVER called. Order is exactly
        // [SendEnd] — proving SIGKILL is the fallback, not the default.
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            // Fire the terminated signal first, then drain — the await resolves
            // immediately, well within the (generous) timeout.
            let _ = tx.send(());
            drain_child(child, rx, Duration::from_secs(2)).await;
        });

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd],
            "a child that exits on its own MUST NOT be SIGKILLed"
        );
    }

    #[test]
    fn drain_sends_end_before_awaiting_then_kills_on_drop() {
        // Falsifiability complement: a receiver whose sender is already dropped
        // resolves to Err immediately (closed channel). The drain must still
        // have sent `end` first, and treats a closed/errored wait the same as a
        // timeout — falling back to kill. So the order is still [SendEnd, Kill].
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let child = FakeChild { calls: calls.clone() };
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx); // sender gone → rx.await == Err(RecvError) without ever signalling exit.

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async move {
            drain_child(child, rx, Duration::from_secs(2)).await;
        });

        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "a closed terminated-channel (no exit observed) must still kill, after end"
        );
    }

    // The INTERACTIVE end path must NOT block the caller.
    //
    // `end_agent_session` (UI Stop/Cancel) OFFLOADS the bounded drain to a
    // background task via `offload_drain`, so a wedged child can never freeze
    // the UI for DRAIN_TIMEOUT. We exercise `offload_drain` directly (the same
    // primitive the command calls) with a child that NEVER signals Terminated,
    // forcing the drain down the full timeout→kill path, and prove:
    //   (1) `offload_drain` RETURNS before the drain completes (non-blocking),
    //   (2) the drain still eventually runs to completion with ordering
    //       [SendEnd, Kill] (the invariant is preserved off-thread).
    // Falsifiability: revert `offload_drain` to a `block_on` and assertion (1)
    // goes RED — the call would not return until after the kill fired.

    /// A fake child that records calls AND fires a one-shot completion signal on
    /// `kill` (the terminal call of the timeout path), so a test can observe when
    /// the offloaded drain has run to completion on the background task.
    struct NotifyingFakeChild {
        calls: Arc<StdMutex<Vec<DrainCall>>>,
        // `Option` so the `Sender` can be moved out in `kill(self)`.
        done: Option<std::sync::mpsc::Sender<()>>,
    }

    impl DrainTarget for NotifyingFakeChild {
        fn send_end(&mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::SendEnd);
            Ok(())
        }
        fn kill(mut self) -> Result<(), String> {
            self.calls.lock().unwrap().push(DrainCall::Kill);
            if let Some(tx) = self.done.take() {
                let _ = tx.send(());
            }
            Ok(())
        }
    }

    #[test]
    fn offload_drain_returns_before_the_drain_completes() {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let child = NotifyingFakeChild {
            calls: calls.clone(),
            done: Some(done_tx),
        };
        // Keep `tx` alive so the terminated receiver NEVER fires — the drain is
        // forced down the timeout→kill branch. A small but non-trivial timeout so
        // there is a real window in which a blocking call would still be waiting.
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let drain_timeout = Duration::from_millis(300);

        // Call the offload primitive on the tauri async runtime (lazily spun up by
        // `tauri::async_runtime::spawn`). It MUST return at once — well before the
        // drain's timeout elapses and the kill fires.
        let before = std::time::Instant::now();
        offload_drain(child, rx, drain_timeout);
        let elapsed = before.elapsed();

        // (1) Non-blocking: the call returned far faster than the drain timeout.
        // A blocking `block_on` would not return until ~drain_timeout (after the
        // kill), so this generous bound (half the timeout) cleanly separates the
        // two behaviors.
        assert!(
            elapsed < drain_timeout / 2,
            "offload_drain must return immediately (non-blocking); took {elapsed:?}"
        );

        // (1b) Corroboration: at the instant of return the drain has NOT yet
        // killed (the timeout has not elapsed), so no completion signal is present.
        assert!(
            done_rx.try_recv().is_err(),
            "the offloaded drain must still be in-flight right after the call returns"
        );

        // (2) The offloaded drain still runs to completion on the background task,
        // and the ordering holds: SendEnd then (on timeout) Kill. Bound the
        // wait generously so a slow CI runtime does not flake.
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("offloaded drain must complete (kill fires on timeout)");
        assert_eq!(
            *calls.lock().unwrap(),
            vec![DrainCall::SendEnd, DrainCall::Kill],
            "offloaded drain must preserve the [SendEnd, Kill] ordering invariant"
        );

        drop(tx); // keep `tx` alive across the drain so the terminated rx never fired.
    }
}
