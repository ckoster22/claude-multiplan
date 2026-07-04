// Plan-text + local-image reads: the two content commands and their guard leaves.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::paths::{is_within, plans_dir};
use crate::plans::frontmatter::split_frontmatter;

/// Hard ceiling on the size of an image we will inline as a `data:` URL. Files larger than
/// this are rejected BEFORE we read their bytes, so a huge file can never blow up memory.
pub(crate) const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024; // 25 MiB

/// Read a plan's raw text. Defends against path traversal by canonicalizing BOTH the
/// requested path and the plans-root and verifying containment. Canonicalizing both sides
/// also defends against a symlinked $HOME. Never panics on bad UTF-8 — lossy-decodes.
#[tauri::command]
pub fn read_plan_contents(path: String) -> Result<String, String> {
    let root = plans_dir().ok_or_else(|| "could not locate home directory".to_string())?;

    // Canonicalize the plans root. If it doesn't exist, there's nothing to read.
    let canon_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("plans dir unavailable: {e}"))?;

    let requested = Path::new(&path);
    let canon_path = std::fs::canonicalize(requested)
        .map_err(|e| format!("cannot resolve path: {e}"))?;

    // Containment check: the resolved path must live inside the resolved plans root.
    if !is_within(&canon_root, &canon_path) {
        return Err("path is outside the plans directory".to_string());
    }

    // Only serve regular files.
    let meta = std::fs::metadata(&canon_path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }

    // Read bytes and lossy-decode so invalid UTF-8 never panics.
    let bytes = std::fs::read(&canon_path).map_err(|e| format!("read failed: {e}"))?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    // strip a leading frontmatter marker so the reading pane never renders it.
    // Uses the SAME `split_frontmatter` as `list_plans` (single source of truth — the two
    // read paths can never disagree on the boundary). Legacy plans (no frontmatter) pass
    // through byte-for-byte unchanged.
    let (_marker, body) = split_frontmatter(&content);
    Ok(body.to_string())
}

/// Map a (lower-cased) file extension to the MIME type we will embed in the `data:` URL.
/// Returns `None` for anything not in the image allow-list. Pure — the single source of
/// truth for both "is this a supported image?" and "what MIME tag does it get?".
pub(crate) fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// True iff `ext` is a supported image extension (case-insensitive). Derived from
/// `mime_for_ext` so the allow-list can never drift between the two. Part of the documented
/// helper surface and exercised by the allow-list tests; the core fn uses `mime_for_ext`
/// directly (it needs the MIME string), hence `allow(dead_code)` for the non-test build.
#[allow(dead_code)]
pub(crate) fn is_supported_image_ext(ext: &str) -> bool {
    mime_for_ext(ext).is_some()
}

/// True iff a file of `len` bytes is within the inline-image size cap. Pure boundary check,
/// extracted so the 25 MiB limit is unit-testable at the exact boundary without writing a
/// 25 MiB file. The cap is INCLUSIVE: exactly `MAX_IMAGE_BYTES` is allowed, one byte more is not.
pub(crate) fn within_size_cap(len: u64) -> bool {
    len <= MAX_IMAGE_BYTES
}

/// Core, Tauri-free implementation: take an already-resolved `&Path`, run the image guards,
/// and produce a `data:<mime>;base64,<encoded>` URL. Kept separate from the
/// `#[tauri::command]` wrapper so every guard is unit-testable with a plain path.
///
/// Guards, in order:
///   1. must be a regular file,
///   2. extension (case-insensitive) must be in the image allow-list,
///   3. on-disk size must be within `MAX_IMAGE_BYTES` (checked BEFORE reading bytes),
///   4. read + base64-encode.
///
/// NOTE: unlike `read_plan_contents`, this intentionally does NOT contain the path to the
/// plans dir — images legitimately live in project dirs, /tmp, etc. The extension + size +
/// is_file guards are the intended bound.
pub(crate) fn read_image_as_data_url_core(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mime = mime_for_ext(ext).ok_or_else(|| "unsupported image type".to_string())?;

    // Size cap BEFORE reading bytes — never load a huge file into memory just to reject it.
    if !within_size_cap(meta.len()) {
        return Err("image too large".to_string());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("read failed: {e}"))?;
    let encoded = BASE64.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// Load a LOCAL image file and return it as a `data:` URL the WebView can render directly
/// (the WebView cannot fetch `file://`). Mirrors `read_plan_contents`' error-string idiom.
/// Canonicalizes the path first so symlinks / `..` are resolved before the guards run.
#[tauri::command]
pub fn read_image_as_data_url(path: String) -> Result<String, String> {
    let requested = Path::new(&path);
    let canon_path = std::fs::canonicalize(requested)
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    read_image_as_data_url_core(&canon_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plans::resume::resume_sentinel_path;
    use std::time::{SystemTime, UNIX_EPOCH};

    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR length + type
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, // bit depth/color/.. + CRC
        0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, // IDAT length + type
        0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, // zlib data ..
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, // .. + CRC
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, // IEND length + type + CRC..
        0x42, 0x60, 0x82,
    ];

    #[test]
    fn allow_list_accepts_supported_extensions() {
        // Lowercase, mixed-case, and the multi-mapped jpeg/svg cases.
        assert_eq!(mime_for_ext("png"), Some("image/png"));
        assert_eq!(mime_for_ext("PNG"), Some("image/png")); // case-insensitive
        assert_eq!(mime_for_ext("jpeg"), Some("image/jpeg"));
        assert_eq!(mime_for_ext("jpg"), Some("image/jpeg"));
        assert_eq!(mime_for_ext("svg"), Some("image/svg+xml"));
        assert_eq!(mime_for_ext("gif"), Some("image/gif"));
        assert_eq!(mime_for_ext("webp"), Some("image/webp"));
        assert_eq!(mime_for_ext("bmp"), Some("image/bmp"));
        assert_eq!(mime_for_ext("avif"), Some("image/avif"));

        assert!(is_supported_image_ext("png"));
        assert!(is_supported_image_ext("PNG"));
        assert!(is_supported_image_ext("jpeg"));
        assert!(is_supported_image_ext("svg"));
    }

    #[test]
    fn allow_list_rejects_unsupported_extensions() {
        assert_eq!(mime_for_ext("txt"), None);
        assert_eq!(mime_for_ext("exe"), None);
        assert_eq!(mime_for_ext(""), None); // missing extension
        assert!(!is_supported_image_ext("txt"));
        assert!(!is_supported_image_ext("exe"));
        assert!(!is_supported_image_ext(""));
    }

    #[test]
    fn size_cap_boundary_is_inclusive() {
        // Exactly at the cap is allowed; one byte over is not. Tested via the pure fn so
        // we never materialize a 25 MiB file.
        assert_eq!(MAX_IMAGE_BYTES, 25 * 1024 * 1024);
        assert!(within_size_cap(0));
        assert!(within_size_cap(MAX_IMAGE_BYTES - 1));
        assert!(within_size_cap(MAX_IMAGE_BYTES)); // exactly 25 MiB: allowed
        assert!(!within_size_cap(MAX_IMAGE_BYTES + 1)); // 25 MiB + 1: rejected
    }

    #[test]
    fn directory_path_is_rejected() {
        // A directory is not a regular file → Err, even though it "exists".
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_dir_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");

        let result = read_image_as_data_url_core(&dir);
        assert!(
            matches!(result, Err(ref m) if m == "not a regular file"),
            "a directory must be rejected as not a regular file, got {result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsupported_extension_file_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_badext_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"hello").expect("write txt");

        let result = read_image_as_data_url_core(&txt);
        assert!(
            matches!(result, Err(ref m) if m == "unsupported image type"),
            "a .txt file must be rejected as unsupported, got {result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tiny_png_round_trips_to_data_url() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_img_png_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let png = dir.join("pixel.png");
        std::fs::write(&png, TINY_PNG).expect("write png");

        let url = read_image_as_data_url_core(&png).expect("core should succeed for a real png");

        // Correct MIME prefix.
        assert!(
            url.starts_with("data:image/png;base64,"),
            "expected a png data-url prefix, got: {}",
            &url[..url.len().min(40)]
        );

        // The base64 payload decodes back to the EXACT original bytes (true round-trip).
        let b64 = url
            .strip_prefix("data:image/png;base64,")
            .expect("prefix present");
        let decoded = BASE64.decode(b64).expect("payload must be valid base64");
        assert_eq!(
            decoded, TINY_PNG,
            "decoded bytes must equal the original image bytes"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_sentinel_path_is_read_plan_contents_safe() {
        // The sentinel can never be mistaken for a real plan file: read_plan_contents rejects it
        // (canonicalize fails on the scheme string), returning Err rather than reading anything.
        let sentinel = resume_sentinel_path("tree-X");
        assert_eq!(sentinel, "plan-tree-resume://tree-X");
        let res = read_plan_contents(sentinel);
        assert!(res.is_err(), "a sentinel path must never resolve to a readable plan file");
    }

}
