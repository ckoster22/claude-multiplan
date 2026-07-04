// Frontend diagnostic passthrough: route a WebView `console.log`-style line to the dev terminal
// (stderr) so a run is fully diagnosable from the dev-terminal log alone.

/// Live-debug seam: surface a frontend diagnostic line in the dev terminal (stderr). The
/// frontend `console.log` only reaches the WebView devtools; routing key diagnostics through
/// this trivial command makes one run fully diagnosable from the dev-terminal log alone. Log-only.
#[tauri::command]
pub fn diag_log(msg: String) {
    eprintln!("[fe:diag] {}", msg);
}
