// `capture_webview_png`: rasterize the app's OWN web content (including the srcdoc-iframe
// prototype, which shares the web-content process) via `WKWebView.takeSnapshot`. This is a
// webview-native snapshot, NOT an OS/screen capture — it needs no macOS Screen-Recording (TCC)
// permission. The returned PNG is base64-wrapped as a `data:` URL, matching
// `read_image_as_data_url`'s convention so the frontend consumes both identically.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// Base64-encode raw PNG bytes. Pure and reusable — the command wraps the result in a
/// `data:image/png;base64,` URL, but the encoding itself is unit-testable without a live webview.
pub(crate) fn png_bytes_to_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn capture_webview_png(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

    // The `with_webview` closure runs SYNCHRONOUSLY on the main thread. To avoid a
    // main-thread self-deadlock it must ONLY install the completion block and return: the
    // block fires later on the main run loop and sends the bytes; the `await rx` below runs on
    // the async task (off-main), so it never parks the run loop that must fire the block.
    window
        .with_webview(move |webview| {
            use block2::RcBlock;
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
            use objc2_foundation::{MainThreadMarker, NSDictionary, NSError};
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

            let mtm = MainThreadMarker::new()
                .expect("with_webview closure runs on the main thread");

            // Tauri's documented cast: `wv.inner()` is the platform `WKWebView`.
            let wk: &WKWebView = unsafe { &*webview.inner().cast() };

            let config = unsafe { WKSnapshotConfiguration::new(mtm) };
            unsafe { config.setAfterScreenUpdates(true) };

            // `RcBlock` requires an `Fn` closure, so the one-shot `Sender` (which `send` consumes
            // by value) lives behind a `Cell` we `take` on first fire; WKWebView calls the
            // completion handler exactly once, so subsequent fires (if any) are inert.
            let sender = std::cell::Cell::new(Some(tx));
            let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(tx) = sender.take() else { return };
                let result = encode_snapshot_png(image, error);
                let _ = tx.send(result);
            });

            unsafe {
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
            }

            // `encode_snapshot_png` is only reachable through the block above; a nested fn keeps
            // its objc2 usage inside the macOS closure without leaking into the crate surface.
            fn encode_snapshot_png(
                image: *mut NSImage,
                error: *mut NSError,
            ) -> Result<Vec<u8>, String> {
                if !error.is_null() {
                    return Err("takeSnapshot reported an error".to_string());
                }
                if image.is_null() {
                    return Err("takeSnapshot returned a null image".to_string());
                }
                let image: &NSImage = unsafe { &*image };
                let tiff = image
                    .TIFFRepresentation()
                    .ok_or_else(|| "NSImage produced no TIFF representation".to_string())?;
                let rep = NSBitmapImageRep::imageRepWithData(&tiff)
                    .ok_or_else(|| "could not build a bitmap rep from the snapshot".to_string())?;
                let props = NSDictionary::new();
                let png = unsafe {
                    rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
                }
                .ok_or_else(|| "could not PNG-encode the snapshot".to_string())?;
                Ok(png.to_vec())
            }
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;

    // `takeSnapshot`'s completion handler can silently never fire (detached/zero-size webview,
    // GPU-process crash); bound the wait so the frontend `invoke` promise can't hang forever.
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "snapshot timed out".to_string())?
        .map_err(|_| "snapshot completion handler dropped without a result".to_string())??;

    Ok(format!("data:image/png;base64,{}", png_bytes_to_base64(&bytes)))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn capture_webview_png(_app: tauri::AppHandle) -> Result<String, String> {
    Err("webview snapshot capture is only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_bytes_to_base64_encodes_known_bytes() {
        // "PNG\r" — the four bytes chosen so the STANDARD-alphabet encoding is unambiguous.
        assert_eq!(png_bytes_to_base64(&[0x50, 0x4E, 0x47, 0x0D]), "UE5HDQ==");
        // Empty input encodes to the empty string (no padding for zero bytes).
        assert_eq!(png_bytes_to_base64(&[]), "");
    }
}
