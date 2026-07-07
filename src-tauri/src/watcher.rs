// The plans-dir debounced watcher: emit `plan-changed` for any `*.md` create/modify/remove.
// notify has no Rename variant, so atomic saves surface as modify/remove/create.

use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use notify_debouncer_full::DebounceEventResult;
use tauri::Emitter;

use crate::model::PlanChanged;
use crate::paths::plans_dir;

pub(crate) fn event_kind_label(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        EventKind::Any => "any",
        EventKind::Other => "other",
    }
}

/// Create the plans dir so `start_watcher` can bind to it on a cold start. A fresh install has
/// no `~/.claude/plans/` until the first plan write — and that write happens AFTER
/// `start_watcher`, so binding to a missing dir would leave the watcher permanently blind (the
/// non-recursive watch never re-attaches when the dir later appears). Best-effort; returns
/// whether the dir exists afterward.
pub(crate) fn ensure_plans_dir(dir: Option<PathBuf>) -> bool {
    let Some(dir) = dir else { return false };
    let _ = std::fs::create_dir_all(&dir);
    dir.is_dir()
}

/// Start the debounced watcher on the plans dir (non-recursive). Emits `plan-changed`
/// for any debounced event touching a `*.md` path. Tolerates a not-yet-existing dir.
/// Returns the live debouncer so the caller can keep it alive for the app's lifetime.
pub(crate) fn start_watcher(app: tauri::AppHandle) -> Option<impl Sized> {
    let dir = plans_dir()?;

    let app_for_handler = app.clone();
    let mut debouncer = match new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errs) => {
                    for e in errs {
                        eprintln!("[watcher] debounce error: {e:?}");
                    }
                    return;
                }
            };

            for ev in events {
                // Handle create / modify / remove (plus the catch-all Any). The notify
                // crate's EventKind has NO Rename variant: atomic saves (temp-write +
                // rename) surface as Modify(Name)/Remove/Create, which we label
                // modify/remove/create — never a literal "rename". The RecommendedCache
                // file-ID tracking inside the debouncer is what makes this reliable.
                let kind = ev.kind;
                let interesting = matches!(
                    kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
                );
                if !interesting {
                    continue;
                }
                for p in ev.paths.iter() {
                    let is_md = p
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("md"))
                        .unwrap_or(false);
                    if !is_md {
                        continue;
                    }
                    let payload = PlanChanged {
                        path: p.to_string_lossy().to_string(),
                        kind: event_kind_label(&kind).to_string(),
                    };
                    let label = payload.kind.clone();
                    let p_disp = payload.path.clone();
                    if let Err(e) = app_for_handler.emit("plan-changed", payload) {
                        eprintln!("[watcher] emit failed: {e:?}");
                    } else {
                        println!("[watcher] emitted plan-changed ({label}): {p_disp}");
                    }
                }
            }
        },
    ) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[watcher] failed to create debouncer: {e:?}");
            return None;
        }
    };

    // The dir may not exist yet; watching a missing path errors. Tolerate it by logging
    // and returning the debouncer anyway (it just won't fire until the user creates
    // the dir; re-watch-on-create is a later concern).
    match debouncer.watch(&dir, RecursiveMode::NonRecursive) {
        Ok(()) => {
            println!("[watcher] watching {}", dir.display());
        }
        Err(e) => {
            eprintln!(
                "[watcher] could not watch {} (dir may not exist yet): {e:?}",
                dir.display()
            );
        }
    }

    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A fresh install has no `~/.claude/plans/`. The startup prep step must create it so the
    /// watcher binds successfully. Falsifiable: drop the `create_dir_all` in `ensure_plans_dir`
    /// and this goes red, because the dir stays absent.
    #[test]
    fn ensure_plans_dir_creates_a_missing_plans_dir() {
        let base = std::env::temp_dir().join(format!(
            "plan_reader_ensure_plans_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let plans = base.join(".claude").join("plans");
        assert!(!plans.exists(), "precondition: plans dir must not exist yet");

        let exists_after = ensure_plans_dir(Some(plans.clone()));

        assert!(exists_after, "ensure_plans_dir must report the dir exists");
        assert!(plans.is_dir(), "plans dir must exist after ensure_plans_dir");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ensure_plans_dir_is_false_when_home_is_unlocatable() {
        assert!(!ensure_plans_dir(None));
    }
}
