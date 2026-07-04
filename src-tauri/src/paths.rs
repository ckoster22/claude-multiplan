// Generic path builders + path-safety guards + time leaf helpers. A dependency-free leaf module:
// nothing here imports another crate-local module, so every other module can `use crate::paths::…`
// without an inbound cycle.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Absolute path to `~/.claude/plans`. Returns None only if the home dir cannot be located.
pub(crate) fn plans_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plans"))
}

/// Absolute path to `~/.claude/plan-reader` (the headless-review state root). Twin of
/// `plans_dir()` — same home-dir resolution, same `Option<PathBuf>` return.
pub(crate) fn plan_reader_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("plan-reader"))
}

/// Absolute path to `~/.claude/plan-reader/requests` (hook-written review requests).
pub(crate) fn requests_dir() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("requests"))
}

/// Absolute path to `~/.claude/plan-reader/responses` (app-written review decisions).
pub(crate) fn responses_dir() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("responses"))
}

/// Absolute path to `~/.claude/plan-reader/app.alive` (heartbeat the hook checks before
/// blocking on a response — if the app isn't running it must not hang the model).
pub(crate) fn app_alive_path() -> Option<PathBuf> {
    plan_reader_dir().map(|d| d.join("app.alive"))
}

/// True iff `id` is a safe review-id usable as a single path segment / file stem.
/// Rules: non-empty; every char is ASCII `[A-Za-z0-9._-]`; not `.` or `..`; contains no
/// `/` or `\\`; does not start with `.` (so a request can never become a dotfile or escape
/// its directory). Hand-rolled — no regex dependency exists in Cargo.toml and the rule is a
/// fixed character class, so a full regex engine is unwarranted.
pub(crate) fn valid_review_id(id: &str) -> bool {
    if id.is_empty() || id == "." || id == ".." {
        return false;
    }
    if id.starts_with('.') {
        return false;
    }
    id.chars().all(|c| {
        // `/` and `\` are excluded by the allow-list below, but spelled out for intent.
        c != '/'
            && c != '\\'
            && (c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    })
}

/// Shared core of `response_path_for` / `request_path_for`: validate the id, join
/// `<dir>/<id>.json`, and assert the joined path's canonicalized parent equals the
/// canonicalized `dir`. Canonicalizes the PARENT (which exists), never the not-yet-created
/// target. Creates no file.
pub(crate) fn guarded_path_in(dir: Option<PathBuf>, review_id: &str) -> Result<PathBuf, String> {
    if !valid_review_id(review_id) {
        return Err("invalid review id".to_string());
    }
    let dir = dir.ok_or_else(|| "could not locate home directory".to_string())?;
    let joined = dir.join(format!("{review_id}.json"));
    let parent = joined
        .parent()
        .ok_or_else(|| "joined path has no parent".to_string())?;
    let canon_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("dir unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("dir unavailable: {e}"))?;
    if canon_parent != canon_dir {
        return Err("path escapes the target directory".to_string());
    }
    Ok(joined)
}

/// True iff `candidate` lives inside `root`. Both are expected to already be canonicalized
/// by the caller (so symlinks/`..` are resolved before this check).
pub(crate) fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Convert a filesystem mtime into millis since the UNIX epoch.
/// Never panics: pre-epoch / clock-skew timestamps map to a negative value instead of
/// unwrapping `duration_since(UNIX_EPOCH)`.
pub(crate) fn system_time_to_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        // File mtime is before the epoch (or clock skew). Represent as negative millis.
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Current wall-clock time in millis since the epoch. Never panics (clock skew before the
/// epoch maps to a negative value, consistent with `system_time_to_ms`).
pub(crate) fn now_ms() -> i64 {
    system_time_to_ms(SystemTime::now())
}

/// Stat a file and return its mtime in millis, or None on any failure.
pub(crate) fn file_mtime_ms(path: &str) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?;
    Some(system_time_to_ms(mtime))
}

/// Collapse a leading `$HOME` into `~` for display. Pure; if `home` is empty or `path`
/// doesn't start with it, returns `path` unchanged. The boundary check (next char is `/`
/// or end-of-string) prevents `/Users/bob-other` collapsing under home `/Users/bob`.
///
/// The PRODUCTION home-collapse runs in the frontend (`src/main.ts` `collapseHome`) because
/// the resolved cwd is patched into the DOM there. This Rust mirror exists as a documented,
/// unit-tested reference of the exact rule (hence `allow(dead_code)` for the non-test build).
#[allow(dead_code)]
pub(crate) fn collapse_home(path: &str, home: &str) -> String {
    if home.is_empty() || !path.starts_with(home) {
        return path.to_string();
    }
    let rest = &path[home.len()..];
    if rest.is_empty() {
        "~".to_string()
    } else if let Some(stripped) = rest.strip_prefix('/') {
        format!("~/{stripped}")
    } else {
        // home is a prefix but not at a path boundary (e.g. /Users/bob vs /Users/bobby).
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn mtime_epoch_is_zero() {
        assert_eq!(system_time_to_ms(UNIX_EPOCH), 0);
    }

    #[test]
    fn mtime_known_post_epoch_is_correct_ms() {
        // 1_700_000_000_000 ms after the epoch (a real-ish 2023 timestamp).
        let known_ms: u64 = 1_700_000_000_000;
        let t = UNIX_EPOCH + Duration::from_millis(known_ms);
        assert_eq!(system_time_to_ms(t), known_ms as i64);
    }

    #[test]
    fn mtime_pre_epoch_does_not_panic_and_is_nonpositive() {
        // 5 seconds before the epoch — duration_since(UNIX_EPOCH) returns Err.
        let t = UNIX_EPOCH - Duration::from_secs(5);
        let ms = system_time_to_ms(t); // must not panic
        assert!(ms <= 0, "pre-epoch time should map to <= 0, got {ms}");
        assert_eq!(ms, -5_000);
    }

    #[test]
    fn path_inside_root_is_accepted() {
        let dir = std::env::temp_dir().join(format!(
            "plan_reader_within_ok_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp");
        let inside = dir.join("plan.md");
        std::fs::write(&inside, b"x").expect("write");

        let canon_root = std::fs::canonicalize(&dir).expect("canon root");
        let canon_inside = std::fs::canonicalize(&inside).expect("canon inside");
        assert!(is_within(&canon_root, &canon_inside));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parent_traversal_escape_is_rejected() {
        let base = std::env::temp_dir().join(format!(
            "plan_reader_within_escape_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let root = base.join("plans");
        std::fs::create_dir_all(&root).expect("mkdir root");
        // A sibling file OUTSIDE the plans root, reached via `../secret.md`.
        let secret = base.join("secret.md");
        std::fs::write(&secret, b"secret").expect("write secret");

        let canon_root = std::fs::canonicalize(&root).expect("canon root");
        // Canonicalizing `<root>/../secret.md` resolves the `..` to the real escaped path.
        let traversal = root.join("..").join("secret.md");
        let canon_traversal = std::fs::canonicalize(&traversal).expect("canon traversal");

        assert!(
            !is_within(&canon_root, &canon_traversal),
            "a `../` escape resolving outside the root must be rejected"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(unix)]
    fn symlink_target_outside_root_is_rejected() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "plan_reader_within_symlink_{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let root = base.join("plans");
        std::fs::create_dir_all(&root).expect("mkdir root");
        let outside_target = base.join("outside.md");
        std::fs::write(&outside_target, b"out").expect("write outside");

        // A symlink INSIDE the root pointing OUTSIDE it. After canonicalization (which the
        // command performs) the resolved path is the outside target, which must be rejected.
        let link = root.join("link.md");
        symlink(&outside_target, &link).expect("symlink");

        let canon_root = std::fs::canonicalize(&root).expect("canon root");
        let canon_link = std::fs::canonicalize(&link).expect("canon link");
        assert!(
            !is_within(&canon_root, &canon_link),
            "a symlink resolving outside the root must be rejected"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn collapse_home_replaces_leading_home_with_tilde() {
        assert_eq!(
            collapse_home("/Users/bob/repos/x", "/Users/bob"),
            "~/repos/x"
        );
        // Exact home ⇒ bare tilde.
        assert_eq!(collapse_home("/Users/bob", "/Users/bob"), "~");
        // Not under home ⇒ unchanged.
        assert_eq!(collapse_home("/var/log", "/Users/bob"), "/var/log");
        // Prefix-but-not-boundary must NOT collapse (bobby is not under bob).
        assert_eq!(
            collapse_home("/Users/bobby/x", "/Users/bob"),
            "/Users/bobby/x"
        );
        // Empty home ⇒ unchanged.
        assert_eq!(collapse_home("/Users/bob/x", ""), "/Users/bob/x");
    }

    /// `valid_review_id` accepts a realistic id and REJECTS traversal / separator / dotfile /
    /// empty forms. Falsifiable: each rejected case asserts `!valid_review_id(...)`, so if the
    /// guard let one through the test goes red.
    #[test]
    fn valid_review_id_accepts_and_rejects() {
        // Realistic minted id.
        assert!(valid_review_id(
            "05ff0135-1e19-4617-b843-4c24acb5dd64-1717100000000000000-ab12"
        ));
        // Plain alphanumerics + allowed punctuation.
        assert!(valid_review_id("abc_DEF-123.json2"));

        // Rejections.
        assert!(!valid_review_id(".."), "`..` must be rejected");
        assert!(!valid_review_id("."), "`.` must be rejected");
        assert!(!valid_review_id("../escape"), "parent traversal must be rejected");
        assert!(!valid_review_id("a/b"), "forward slash must be rejected");
        assert!(!valid_review_id("a\\b"), "backslash must be rejected");
        assert!(!valid_review_id(""), "empty string must be rejected");
        assert!(!valid_review_id(".hidden"), "leading-dot (dotfile) must be rejected");
        // Out-of-class chars.
        assert!(!valid_review_id("a b"), "space must be rejected");
        assert!(!valid_review_id("a*b"), "glob char must be rejected");
    }

}
