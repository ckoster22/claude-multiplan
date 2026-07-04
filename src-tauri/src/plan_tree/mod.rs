//! `.plan-tree/` persistence for a user-chosen working directory.
//!
//! The frontend WebView cannot write files, so the multiplan orchestration state that lives in
//! `<cwd>/.plan-tree/` (master plan, per-sub-plan plans + summaries, and a `state.json`) is
//! materialized through these Tauri commands. Unlike the `~/.claude/` trees the rest of the
//! app touches, this directory lives OUTSIDE `~/.claude/` — wherever the user pointed the plan at.
//! (`reset_plan_tree_dir` — the START-reconciliation sweep into `.archive/` — documents its own
//! guard set on the function.)
//!
//! Split by volatility:
//!   * `ledger`  — plan-tree file lifecycle: name validation + read/write/delete/reset.
//!   * `staging` — prototype/baseline lifecycle (visual-prototype dir + frozen baseline snapshot).
//!
//! The read/write commands are doubly defended:
//!   1. `valid_plan_tree_name` — a strict allow-list (membership + a hand-parsed `NN-(plan|summary).md`
//!      shape). The literal control files are `state.json`, `recon.md`, `master.md`, and `INTENT.md`.
//!      No regex
//!      dependency; `/`, `\`, `..`, leading-`.`, URL escapes, and absolute paths all fail the
//!      charset/shape check.
//!   2. A canonicalized-parent containment guard mirroring `lib.rs`'s `guarded_plan_path`: build
//!      `<cwd>/.plan-tree/<name>`, ensure `.plan-tree` exists, canonicalize that parent dir, and
//!      assert the target's canonical parent IS it — so even a name that slipped the allow-list could
//!      not escape `.plan-tree`.
//!
//! Writes reuse `crate::state::persist::atomic_write` (temp `.tmp-…` + rename). Reads degrade
//! gracefully: an absent file is `Ok(None)`, never an error.

use std::path::Path;

pub(crate) mod ledger;
pub(crate) mod staging;

/// Shared cwd guard mirroring `reset_plan_tree_dir`'s set: `cwd` must be absolute, contain no `..`
/// components, and be an existing directory. Used by the staging (prototype/baseline) commands;
/// `reset_plan_tree_dir` inlines an identical guard rather than calling it.
pub(crate) fn validated_cwd(cwd: &str) -> Result<&Path, String> {
    let cwd_path = Path::new(cwd);
    if !cwd_path.is_absolute() {
        return Err(format!("cwd must be an absolute path: {cwd:?}"));
    }
    if cwd_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("cwd must not contain `..` components: {cwd:?}"));
    }
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not an existing directory: {cwd:?}"));
    }
    Ok(cwd_path)
}

#[cfg(test)]
mod testutil {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Create a unique temp dir under `std::env::temp_dir()` (no `tempfile` crate dependency). Uses
    /// pid + a nanosecond clock read + a monotonic process-local counter so concurrent tests never
    /// collide on the same path.
    pub(crate) fn unique_temp_dir() -> PathBuf {
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("plan-tree-test-{pid}-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }
}
