// Tauri shell, plan list & live file-watch.
//
// The app's write surfaces under `~/.claude/`:
//   (a) `~/.claude/plans/` — its own agent-produced plans, via `write_agent_plan` (atomic
//       temp-write + rename, containment-guarded to the plans dir). So the plans watcher CAN
//       fire on our own writes.
//   (b) `~/.claude/plan-reader/**` — self-owned headless-review state (requests/, responses/,
//       app.alive heartbeat, hook.sh). Writes are atomic (temp-write + rename) and
//       containment-guarded (`guarded_path_in` canonicalizes the parent, rejecting any id that
//       would escape requests/ or responses/).
//   (c) `~/.claude/settings.json` — a SINGLE idempotent, additive merge (`merge_install_hook`
//       / `merge_uninstall_hook`) that touches only our `ExitPlanMode` PreToolUse entry and
//       preserves every other key/element untouched.
// The app still NEVER writes into `~/.claude/projects/` — that tree is read-only, used only
// for cwd resolution.

use std::sync::Mutex;

use tauri::Manager;

// Agent SDK driver — all driver logic lives in this module; the
// edits to lib.rs are additive registration only (plugin init, managed state,
// generate_handler!, teardown RunEvent).
mod agent;
mod commands;
mod control;
mod diag;
mod hook;
mod model;
mod paths;
mod plan_tree;
mod plans;
mod resolve;
mod review;
mod state;
mod watcher;
mod window;
#[cfg(test)]
mod testutil;
use agent::AgentDriver;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Agent SDK driver: the shell plugin gives us the sidecar
        // spawn/stdin-write/kill handles.
        .plugin(tauri_plugin_shell::init())
        // Native folder picker: the dialog plugin backs the New-plan
        // composer's working-directory "Choose…" button (frontend calls
        // `@tauri-apps/plugin-dialog` `open({directory:true})`).
        .plugin(tauri_plugin_dialog::init())
        // Desktop notifications: the notification plugin backs the
        // frontend `@tauri-apps/plugin-notification` wrapper (src/notify.ts),
        // which fires an OS notification on the two quota events (limit reached /
        // auto-resumed).
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Agent SDK driver: one session per launch, stored in
            // Mutex<Option<AgentDriver>>. Managed unconditionally so the State
            // extractor in the agent commands can never hit "state not managed".
            app.manage(Mutex::new(None::<(u64, AgentDriver)>));
            // manage AppState UNCONDITIONALLY (independent of watcher success)
            // so the `State` extractor in list_plans / mark_viewed / etc. can never hit
            // "state not managed". Locate + create the data dir; all persistence degrades to
            // in-memory on any failure (never panics).
            let data_dir = match app.path().app_data_dir() {
                Ok(dir) => match std::fs::create_dir_all(&dir) {
                    Ok(()) => Some(dir),
                    Err(e) => {
                        eprintln!(
                            "[state] could not create app_data_dir {} ({e}); running in-memory only",
                            dir.display()
                        );
                        None
                    }
                },
                Err(e) => {
                    eprintln!("[state] app_data_dir unavailable ({e}); running in-memory only");
                    None
                }
            };
            app.manage(Mutex::new(state::app_state::init_app_state(data_dir)));

            // Seed the `tree_id → cwd` index ONCE from existing `.plan-tree/state.json` ledgers
            // (app-generated plan-tree plans never emit a `projects/` transcript event, so the
            // scan can't resolve their cwd). Runs on a background thread — never blocks startup —
            // and merges idempotently into the managed index above.
            control::spawn_backfill(app.handle().clone());

            // Ensure the control dirs exist so the guarded path builders (which
            // canonicalize the parent) and the control-dir watcher can operate. Best-effort —
            // failures degrade (the commands re-create on demand; the watcher logs + no-ops).
            if let Some(d) = paths::requests_dir() {
                let _ = std::fs::create_dir_all(&d);
            }
            if let Some(d) = paths::responses_dir() {
                let _ = std::fs::create_dir_all(&d);
            }

            // Prune orphaned control files left by SIGKILLed/timed-out hooks ONCE at
            // startup (before any launch recovery), then again on every heartbeat tick.
            control::prune_stale_control_files();

            // Heartbeat thread — touches app.alive every 5s so the hook knows we are
            // live (a missed beat just makes the hook fall through, the safe failure mode).
            control::spawn_heartbeat();

            // Create the plans dir BEFORE binding the watcher: a fresh install has no
            // `~/.claude/plans/` until the first plan write, which happens AFTER start_watcher,
            // so binding to a missing dir would leave the (non-recursive) watcher permanently
            // blind.
            watcher::ensure_plans_dir(paths::plans_dir());

            // Keep the debouncer alive for the lifetime of the app by stashing it in
            // managed state. Dropping it would stop the watch thread.
            if let Some(debouncer) = watcher::start_watcher(app.handle().clone()) {
                app.manage(Mutex::new(debouncer));
            }

            // SECOND debouncer on the control dir (requests/). Wrapped in the
            // `ControlWatcher` newtype so it gets a distinct type key in managed state (both
            // debouncers share the same concrete type — a bare `Mutex<Debouncer>` would
            // collide with the plans watcher above). Kept alive the same way: stashed in state.
            if let Some(debouncer) = control::start_control_watcher(app.handle().clone()) {
                app.manage(Mutex::new(control::ControlWatcher(debouncer)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            plans::list::list_plans,
            plans::contents::read_plan_contents,
            plans::contents::read_image_as_data_url,
            diag::diag_log,
            commands::read_state::set_open_plan,
            commands::read_state::mark_viewed,
            resolve::commands::resolve_cwds,
            resolve::commands::read_plan_transcript,
            commands::read_state::set_tree_collapsed,
            commands::comments::get_comments,
            commands::comments::get_comment_count,
            commands::comments::set_comments,
            commands::comments::clear_comments,
            commands::snapshot::capture_webview_png,
            review::list_pending_reviews,
            review::read_review_plan,
            review::respond_to_review,
            plans::write::write_agent_plan,
            plan_tree::ledger::write_plan_tree_file,
            plan_tree::ledger::read_plan_tree_file,
            plan_tree::ledger::delete_plan_tree_file,
            plan_tree::ledger::reset_plan_tree_dir,
            plan_tree::staging::ensure_prototype_dir,
            plan_tree::staging::open_prototype,
            plan_tree::staging::read_prototype_file,
            plan_tree::staging::write_capture_png,
            plan_tree::staging::delete_capture_png,
            plan_tree::staging::ensure_baseline_dir,
            plan_tree::staging::freeze_baseline,
            plan_tree::staging::open_baseline,
            window::focus_main_window,
            hook::install_hook,
            hook::uninstall_hook,
            hook::hook_status,
            // Agent SDK driver — the nine commands.
            agent::commands::start_agent_session,
            agent::commands::send_agent_message,
            agent::commands::resolve_tool_permission,
            agent::commands::set_agent_permission_mode,
            agent::commands::set_agent_model,
            agent::commands::cancel_agent_run,
            agent::commands::end_agent_session,
            agent::commands::agent_auth_status,
            agent::commands::set_agent_oauth_token
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Agent SDK driver teardown: gracefully drain the agent
        // tree on app exit — send `end`, wait a bounded interval for the
        // sidecar (and its `claude` grandchild) to exit, SIGKILL only as the
        // fallback — so quitting leaves NO orphaned `claude` or sidecar process.
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                agent::shutdown_session(app);
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    // INVARIANT[csp-script-src-never-inline] (test-pinned): the bundled production CSP in tauri.conf.json keeps a script-src that admits neither 'unsafe-inline' nor 'unsafe-eval', and pins object-src to 'none'.
    //   prevents: a config edit from silently re-opening inline/eval script execution (an XSS foothold) or plugin/object embedding in the shipped WebView.
    //   test: csp_production_script_src_forbids_inline_and_eval
    #[test]
    fn csp_production_script_src_forbids_inline_and_eval() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("app.security.csp is a non-null string");
        assert!(!csp.trim().is_empty(), "csp must not be empty");

        let directive = |name: &str| -> Option<Vec<String>> {
            csp.split(';').map(str::trim).find_map(|d| {
                let mut parts = d.split_whitespace();
                match parts.next() {
                    Some(n) if n == name => Some(parts.map(str::to_string).collect()),
                    _ => None,
                }
            })
        };

        let script_src = directive("script-src").expect("csp declares a script-src directive");
        assert!(
            !script_src.iter().any(|s| s == "'unsafe-inline'"),
            "script-src must not allow 'unsafe-inline' (got {script_src:?})"
        );
        assert!(
            !script_src.iter().any(|s| s == "'unsafe-eval'"),
            "script-src must not allow 'unsafe-eval' (got {script_src:?})"
        );

        let object_src = directive("object-src").expect("csp declares an object-src directive");
        assert_eq!(object_src, vec!["'none'".to_string()], "object-src must be 'none'");
    }
}
