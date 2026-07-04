// Bring the main window to the foreground when a review needs attention. Best-effort: each
// step's failure is ignored; only a missing window is an error.

use tauri::Manager;

/// Best-effort: bring the main window to the foreground (show + unminimize + focus). Each
/// step's error is ignored — surfacing a review must never fail because, e.g., the window was
/// already visible. Returns Ok unless the window can't be found at all.
#[tauri::command]
pub fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("main window not found".to_string());
    };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    Ok(())
}
