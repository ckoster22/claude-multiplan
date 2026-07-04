// The plans-dir debounced watcher: emit `plan-changed` for any `*.md` create/modify/remove.
// notify has no Rename variant, so atomic saves surface as modify/remove/create.

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
