//! Prototype/baseline staging lifecycle for `<cwd>/.plan-tree/`.
//!
//! The intent-clarifier's visual-prototype mode writes throwaway artifacts under
//! `<cwd>/.plan-tree/prototype/`; when the user marks one a "working reference" the tree is FROZEN
//! into a contained `<cwd>/.plan-tree/baseline/`. Both surfaces share the directory-canonicalization
//! containment of the reset path (via the barrel's `validated_cwd`), NOT the ledger's file-name
//! allow-list.

use std::path::{Path, PathBuf};

use super::validated_cwd;

#[cfg(test)]
use super::testutil::unique_temp_dir;

// The intent-clarifier's visual-prototype mode writes throwaway artifacts under
// `<cwd>/.plan-tree/prototype/` (the sidecar's "prototype" write policy confines the agent to
// exactly that subtree, but it cannot CREATE the dir — `ensure_prototype_dir` does, before the
// visual-mode prompt is sent). `open_prototype` opens one of those artifacts (an HTML prototype)
// in the default browser via tauri-plugin-opener. Both commands mirror `reset_plan_tree_dir`'s
// cwd guard set; the open path adds a strict file-containment guard. The validation cores are
// plain functions (no AppHandle) so the containment rules are unit-testable without ever
// launching a browser — the `#[tauri::command]`s stay thin shells.

/// Validation + creation core of `ensure_prototype_dir` (testable; no Tauri types). Creates
/// `<cwd>/.plan-tree/prototype/` (idempotent), then asserts containment: the CANONICAL created
/// dir must equal `<canonical cwd>/.plan-tree/prototype` exactly — a symlinked `.plan-tree` (or
/// `prototype`) pointing elsewhere canonicalizes to a different path and is rejected. Returns the
/// canonical (absolute) dir path.
fn ensure_prototype_dir_impl(cwd: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let dir = cwd_path.join(".plan-tree").join("prototype");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create prototype dir: {e}"))?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_dir != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("path escapes the working directory".to_string());
    }
    Ok(canon_dir)
}

/// Create `<cwd>/.plan-tree/prototype/` (idempotent) and return its absolute path. Called by the
/// orchestrator driver BEFORE the visual-mode intent prompt is sent, so the clarifier never needs
/// Bash/mkdir (the sidecar's "prototype" policy only allows writes UNDER the dir — it cannot
/// create it). Guards documented on `ensure_prototype_dir_impl`.
#[tauri::command]
pub fn ensure_prototype_dir(cwd: String) -> Result<String, String> {
    ensure_prototype_dir_impl(&cwd).map(|p| p.to_string_lossy().to_string())
}

/// Validation core of `open_prototype` (testable; no Tauri types, never launches anything).
/// `path` may be absolute or relative-to-`cwd` (the gate's `paths` are usually relative, e.g.
/// `.plan-tree/prototype/index.html`). Requirements, all enforced on CANONICAL paths so symlinks
/// cannot smuggle a target out:
///   * `cwd` passes `validated_cwd` (absolute, no `..`, existing dir);
///   * `<cwd>/.plan-tree/prototype/` exists and canonicalizes INSIDE the canonical cwd
///     (same equality assert as `ensure_prototype_dir_impl`);
///   * the resolved `path` exists, canonicalizes STRICTLY UNDER that prototype dir, and is a
///     regular file (directories and anything else are rejected).
fn validated_prototype_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let proto = cwd_path.join(".plan-tree").join("prototype");
    let canon_proto =
        std::fs::canonicalize(&proto).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_proto != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("path escapes the working directory".to_string());
    }
    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canon_cwd.join(requested)
    };
    let canon =
        std::fs::canonicalize(&joined).map_err(|e| format!("prototype file unavailable: {e}"))?;
    if !canon.starts_with(&canon_proto) || canon == canon_proto {
        return Err("path escapes the prototype directory".to_string());
    }
    let meta =
        std::fs::metadata(&canon).map_err(|e| format!("prototype file unavailable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("prototype path is not a regular file: {path:?}"));
    }
    Ok(canon)
}

/// Open a prototype artifact (validated by `validated_prototype_file` — strictly under
/// `<cwd>/.plan-tree/prototype/`) in the OS default handler (the browser, for `index.html`) via
/// tauri-plugin-opener's Rust API. Rust-side opener calls need no extra JS capability; the
/// `opener:default` capability covers the plugin's own setup.
#[tauri::command]
pub fn open_prototype(
    app: tauri::AppHandle,
    cwd: String,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = validated_prototype_file(&cwd, &path)?;
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("could not open prototype: {e}"))
}

// When the user marks a visual prototype a "working reference" at the prototype-approval gate, the
// throwaway `<cwd>/.plan-tree/prototype/` tree is FROZEN into a contained `<cwd>/.plan-tree/baseline/`
// so it survives the prototype dir being reset/overwritten by later runs. The baseline is a FLOOR on
// the outcome dimensions captured in INTENT.md — never a behavioral match-target — but on disk it is
// just a snapshot copy of the prototype subtree. Both ensure + freeze + open mirror the directory-
// canonicalization containment of the prototype commands above (NOT the file-name allow-list of
// `guarded_plan_tree_path`, which rejects any `/`-containing sub-path): the canonical created/target
// dir must equal `<canonical cwd>/.plan-tree/baseline` exactly, so a symlinked `.plan-tree` (or
// `baseline`) pointing elsewhere is rejected. The validation cores are plain functions (no AppHandle)
// so the containment rules are unit-testable without launching anything.

/// Validation + creation core of `ensure_baseline_dir` (testable; no Tauri types). Creates
/// `<cwd>/.plan-tree/baseline/` (idempotent), then asserts containment: the CANONICAL created dir
/// must equal `<canonical cwd>/.plan-tree/baseline` exactly. Mirrors `ensure_prototype_dir_impl`.
/// Returns the canonical (absolute) dir path.
fn ensure_baseline_dir_impl(cwd: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let dir = cwd_path.join(".plan-tree").join("baseline");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create baseline dir: {e}"))?;
    let canon_cwd = std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("baseline dir unavailable: {e}"))?;
    if canon_dir != canon_cwd.join(".plan-tree").join("baseline") {
        return Err("path escapes the working directory".to_string());
    }
    Ok(canon_dir)
}

/// Create `<cwd>/.plan-tree/baseline/` (idempotent) and return its absolute path. Guards documented
/// on `ensure_baseline_dir_impl`.
#[tauri::command]
pub fn ensure_baseline_dir(cwd: String) -> Result<String, String> {
    ensure_baseline_dir_impl(&cwd).map(|p| p.to_string_lossy().to_string())
}

/// Recursively copy `src` into `dst` (both already canonical + contained), asserting NEITHER side
/// escapes its containment root as the walk descends. `src_root`/`dst_root` are the canonical
/// `prototype`/`baseline` dirs; every directory entry's canonical path must stay STRICTLY UNDER its
/// root (a symlink inside `prototype/` pointing out, or a symlink `dst` entry redirecting the write
/// out, is rejected). Symlinks are NOT followed for copying — they would let a planted link redirect
/// a read/write outside containment, so any symlink encountered is rejected. Files are copied with
/// `std::fs::copy`; subdirectories recurse.
fn copy_tree_contained(
    src: &Path,
    dst: &Path,
    src_root: &Path,
    dst_root: &Path,
) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("could not list baseline source: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read baseline source entry: {e}"))?;
        let name = entry.file_name();
        let src_child = src.join(&name);
        let dst_child = dst.join(&name);

        // Symlink defense: never follow a link (it could redirect outside containment). Reject any.
        let meta = std::fs::symlink_metadata(&src_child)
            .map_err(|e| format!("could not stat baseline source entry: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!(
                "baseline freeze refuses to copy a symlink: {:?}",
                name.to_string_lossy()
            ));
        }

        if meta.is_dir() {
            std::fs::create_dir_all(&dst_child)
                .map_err(|e| format!("could not create baseline subdir: {e}"))?;
            // Containment re-assert on BOTH sides after creation (canonical paths now exist).
            let canon_src = std::fs::canonicalize(&src_child)
                .map_err(|e| format!("baseline source subdir unavailable: {e}"))?;
            let canon_dst = std::fs::canonicalize(&dst_child)
                .map_err(|e| format!("baseline dest subdir unavailable: {e}"))?;
            if !canon_src.starts_with(src_root) || !canon_dst.starts_with(dst_root) {
                return Err("baseline freeze path escapes containment".to_string());
            }
            copy_tree_contained(&canon_src, &canon_dst, src_root, dst_root)?;
        } else if meta.is_file() {
            let canon_src = std::fs::canonicalize(&src_child)
                .map_err(|e| format!("baseline source file unavailable: {e}"))?;
            if !canon_src.starts_with(src_root) {
                return Err("baseline freeze source escapes containment".to_string());
            }
            // The destination parent (`dst`) is already canonical + contained by construction; the
            // child join cannot escape it (a plain file name, source-side symlinks rejected above).
            if !dst.starts_with(dst_root) {
                return Err("baseline freeze destination escapes containment".to_string());
            }
            // Destination symlink defense (mirror of the source-side rejection above): `std::fs::copy`
            // FOLLOWS a symlink at the destination, so a link pre-planted at `dst_child` pointing
            // outside `.plan-tree/` would let the copy overwrite an out-of-containment target. Reject
            // any pre-existing destination entry that is a symlink before copying.
            if let Ok(dst_meta) = std::fs::symlink_metadata(&dst_child) {
                if dst_meta.file_type().is_symlink() {
                    return Err(format!(
                        "baseline freeze refuses to overwrite a symlink destination: {:?}",
                        name.to_string_lossy()
                    ));
                }
            }
            std::fs::copy(&canon_src, &dst_child)
                .map_err(|e| format!("could not copy baseline file: {e}"))?;
        }
        // Anything else (sockets, fifos, …) is silently skipped — a prototype never produces them.
    }
    Ok(())
}

/// Freeze `<cwd>/.plan-tree/prototype/` into `<cwd>/.plan-tree/baseline/`: ensure the baseline dir
/// (containment-guarded), then recursively copy every prototype file/subdir into it with containment
/// guards on BOTH source and destination (`copy_tree_contained`). The prototype dir MUST exist and
/// canonicalize inside the cwd (same equality assert as `ensure_prototype_dir_impl`); a missing
/// prototype dir is an error (there is nothing to freeze). Idempotent in the sense that re-freezing
/// overwrites same-named files; pre-existing baseline files not present in the prototype are left
/// untouched. Returns the canonical baseline dir path.
#[tauri::command]
pub fn freeze_baseline(cwd: String) -> Result<String, String> {
    let cwd_path = validated_cwd(&cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;

    // Source: the prototype dir must exist and be contained (mirrors validated_prototype_file's
    // dir assert).
    let proto = cwd_path.join(".plan-tree").join("prototype");
    let canon_proto =
        std::fs::canonicalize(&proto).map_err(|e| format!("prototype dir unavailable: {e}"))?;
    if canon_proto != canon_cwd.join(".plan-tree").join("prototype") {
        return Err("prototype path escapes the working directory".to_string());
    }

    // Destination: create + contain the baseline dir.
    let canon_baseline = ensure_baseline_dir_impl(&cwd)?;

    copy_tree_contained(&canon_proto, &canon_baseline, &canon_proto, &canon_baseline)?;
    Ok(canon_baseline.to_string_lossy().to_string())
}

/// Validation core of `open_baseline` (testable; no Tauri types, never launches anything). Scoped to
/// `<cwd>/.plan-tree/baseline/` exactly as `validated_prototype_file` is scoped to `prototype/` —
/// `open_prototype` is hard-scoped to `prototype/` and would 403 on a baseline path, so the gate
/// needs this baseline-scoped opener. Same canonical-path containment: the resolved `path` must
/// exist, canonicalize STRICTLY UNDER the baseline dir, and be a regular file.
fn validated_baseline_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let cwd_path = validated_cwd(cwd)?;
    let canon_cwd =
        std::fs::canonicalize(cwd_path).map_err(|e| format!("cwd unavailable: {e}"))?;
    let base = cwd_path.join(".plan-tree").join("baseline");
    let canon_base =
        std::fs::canonicalize(&base).map_err(|e| format!("baseline dir unavailable: {e}"))?;
    if canon_base != canon_cwd.join(".plan-tree").join("baseline") {
        return Err("path escapes the working directory".to_string());
    }
    let requested = Path::new(path);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        canon_cwd.join(requested)
    };
    let canon =
        std::fs::canonicalize(&joined).map_err(|e| format!("baseline file unavailable: {e}"))?;
    if !canon.starts_with(&canon_base) || canon == canon_base {
        return Err("path escapes the baseline directory".to_string());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("baseline file unavailable: {e}"))?;
    if !meta.is_file() {
        return Err(format!("baseline path is not a regular file: {path:?}"));
    }
    Ok(canon)
}

/// Open a baseline artifact (validated by `validated_baseline_file` — strictly under
/// `<cwd>/.plan-tree/baseline/`) in the OS default handler via tauri-plugin-opener's Rust API.
/// Mirrors `open_prototype` but scoped to `baseline/` (the gate opens the frozen baseline).
#[tauri::command]
pub fn open_baseline(app: tauri::AppHandle, cwd: String, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let file = validated_baseline_file(&cwd, &path)?;
    app.opener()
        .open_path(file.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("could not open baseline: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ensure_prototype_dir` creates `<cwd>/.plan-tree/prototype/` when absent and is IDEMPOTENT
    /// (a second call on the now-existing dir succeeds and returns the same path). The returned
    /// path is absolute and ends with `.plan-tree/prototype`. Falsifiable: skip the create_dir_all
    /// and the canonicalize fails (no dir to canonicalize) → the expect panics.
    #[test]
    fn ensure_prototype_dir_creates_idempotently_and_returns_absolute() {
        let cwd = unique_temp_dir();
        let first = ensure_prototype_dir(cwd.to_string_lossy().to_string())
            .expect("first ensure should create the dir");
        assert!(Path::new(&first).is_absolute(), "returned path must be absolute: {first}");
        assert!(
            first.ends_with("/.plan-tree/prototype"),
            "returned path must be the prototype dir: {first}"
        );
        assert!(Path::new(&first).is_dir(), "the prototype dir must exist on disk");

        let second = ensure_prototype_dir(cwd.to_string_lossy().to_string())
            .expect("second ensure must be an idempotent success");
        assert_eq!(first, second, "idempotent re-ensure must return the same path");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `ensure_prototype_dir` mirrors `reset_plan_tree_dir`'s cwd guards: relative cwd, a cwd with
    /// `..` components, and a missing cwd are all rejected (and nothing is created). Falsifiable:
    /// drop the guards and the `..` form resolves to a real directory and succeeds.
    #[test]
    fn ensure_prototype_dir_rejects_bad_cwd() {
        let cwd = unique_temp_dir();

        let res = ensure_prototype_dir("relative/dir".to_string());
        assert!(res.is_err(), "relative cwd must be rejected, got {res:?}");

        let traversing = format!("{}/..", cwd.to_string_lossy());
        let res = ensure_prototype_dir(traversing);
        assert!(res.is_err(), "cwd with `..` must be rejected, got {res:?}");

        let missing = cwd.join("does-not-exist");
        let res = ensure_prototype_dir(missing.to_string_lossy().to_string());
        assert!(res.is_err(), "missing cwd must be rejected, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// A `.plan-tree` that is a SYMLINK out of the cwd must be rejected by the prototype-dir
    /// containment assert (the canonical dir no longer equals `<canon cwd>/.plan-tree/prototype`).
    /// Falsifiable: drop the equality check and the ensure succeeds, planting `prototype/` inside
    /// the symlink's target.
    #[cfg(unix)]
    #[test]
    fn ensure_prototype_dir_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // elsewhere under temp, NOT inside cwd
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let res = ensure_prototype_dir(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "symlinked .plan-tree must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// `validated_prototype_file` containment: traversal out of the prototype dir, an absolute
    /// path outside the cwd, a file at the `.plan-tree` ROOT (inside cwd but NOT under
    /// `prototype/`), and a DIRECTORY inside `prototype/` are ALL rejected; a real file under
    /// `prototype/` is accepted whether addressed relative-to-cwd or absolutely, and the returned
    /// path is absolute (canonical). Falsifiable: drop the `starts_with` containment check and the
    /// `.plan-tree`-root case (an existing regular file) validates.
    #[test]
    fn validated_prototype_file_containment() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        std::fs::write(proto.join("index.html"), "<html></html>").expect("seed index.html");
        std::fs::create_dir_all(proto.join("assets")).expect("seed subdir");
        std::fs::write(cwd.join(".plan-tree").join("master.md"), "not a prototype")
            .expect("seed plan-tree-root file");
        // An out-of-cwd victim a traversal would otherwise reach.
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");

        let cwd_s = cwd.to_string_lossy().to_string();

        // Accept: relative-to-cwd addressing (the gate's usual form).
        let ok = validated_prototype_file(&cwd_s, ".plan-tree/prototype/index.html")
            .expect("relative in-dir file must validate");
        assert!(ok.is_absolute(), "validated path must be absolute: {ok:?}");
        assert!(ok.ends_with(".plan-tree/prototype/index.html"), "got {ok:?}");

        // Accept: absolute addressing of the same file.
        let abs = proto.join("index.html").to_string_lossy().to_string();
        validated_prototype_file(&cwd_s, &abs).expect("absolute in-dir file must validate");

        // Reject: traversal escaping prototype/ (resolves to the out-of-cwd victim).
        let depth = outside.components().count();
        let ups = "../".repeat(depth + 4);
        let traversal = format!(
            ".plan-tree/prototype/{ups}{}/victim.html",
            outside.to_string_lossy().trim_start_matches('/')
        );
        let res = validated_prototype_file(&cwd_s, &traversal);
        assert!(res.is_err(), "traversal must be rejected, got {res:?}");

        // Reject: absolute path outside the cwd entirely.
        let res = validated_prototype_file(
            &cwd_s,
            &outside.join("victim.html").to_string_lossy().to_string(),
        );
        assert!(res.is_err(), "outside-cwd absolute path must be rejected, got {res:?}");

        // Reject: a real file inside .plan-tree but NOT under prototype/.
        let res = validated_prototype_file(&cwd_s, ".plan-tree/master.md");
        assert!(res.is_err(), ".plan-tree-root file must be rejected, got {res:?}");

        // Reject: a directory inside prototype/ (not a regular file).
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype/assets");
        assert!(res.is_err(), "directory must be rejected, got {res:?}");

        // Reject: the prototype dir itself.
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype");
        assert!(res.is_err(), "the prototype dir itself must be rejected, got {res:?}");

        // Reject: a missing file (nothing to open).
        let res = validated_prototype_file(&cwd_s, ".plan-tree/prototype/ghost.html");
        assert!(res.is_err(), "missing file must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// A SYMLINK inside `prototype/` pointing OUT of it must be rejected: validation operates on
    /// the canonical (resolved) path, which lands outside the canonical prototype dir.
    /// Falsifiable: validate the un-canonicalized join instead and the symlink passes.
    #[cfg(unix)]
    #[test]
    fn validated_prototype_file_rejects_outward_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), proto.join("link.html"))
            .expect("plant symlink");

        let res = validated_prototype_file(
            &cwd.to_string_lossy(),
            ".plan-tree/prototype/link.html",
        );
        assert!(res.is_err(), "outward symlink must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// `ensure_baseline_dir` creates `<cwd>/.plan-tree/baseline/` when absent and is IDEMPOTENT.
    /// The returned path is absolute and ends with `.plan-tree/baseline`. Falsifiable: skip the
    /// create_dir_all and the canonicalize fails → the expect panics.
    #[test]
    fn ensure_baseline_dir_creates_idempotently_and_returns_absolute() {
        let cwd = unique_temp_dir();
        let first = ensure_baseline_dir(cwd.to_string_lossy().to_string())
            .expect("first ensure should create the dir");
        assert!(Path::new(&first).is_absolute(), "returned path must be absolute: {first}");
        assert!(
            first.ends_with("/.plan-tree/baseline"),
            "returned path must be the baseline dir: {first}"
        );
        assert!(Path::new(&first).is_dir(), "the baseline dir must exist on disk");

        let second = ensure_baseline_dir(cwd.to_string_lossy().to_string())
            .expect("second ensure must be an idempotent success");
        assert_eq!(first, second, "idempotent re-ensure must return the same path");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `ensure_baseline_dir` mirrors the cwd guards: relative cwd, a cwd with `..` components, and a
    /// missing cwd are all rejected (and nothing is created). Falsifiable: drop the guards and the
    /// `..` form resolves to a real directory and succeeds.
    #[test]
    fn ensure_baseline_dir_rejects_bad_cwd() {
        let cwd = unique_temp_dir();

        let res = ensure_baseline_dir("relative/dir".to_string());
        assert!(res.is_err(), "relative cwd must be rejected, got {res:?}");

        let traversing = format!("{}/..", cwd.to_string_lossy());
        let res = ensure_baseline_dir(traversing);
        assert!(res.is_err(), "cwd with `..` must be rejected, got {res:?}");

        let missing = cwd.join("does-not-exist");
        let res = ensure_baseline_dir(missing.to_string_lossy().to_string());
        assert!(res.is_err(), "missing cwd must be rejected, got {res:?}");
        assert!(!missing.exists(), "missing cwd must not be created");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// A `.plan-tree` that is a SYMLINK out of the cwd must be rejected by the baseline-dir
    /// containment assert. Falsifiable: drop the equality check and the ensure succeeds, planting
    /// `baseline/` inside the symlink's target.
    #[cfg(unix)]
    #[test]
    fn ensure_baseline_dir_rejects_symlinked_plan_tree() {
        let cwd = unique_temp_dir();
        let target = unique_temp_dir(); // elsewhere under temp, NOT inside cwd
        std::os::unix::fs::symlink(&target, cwd.join(".plan-tree")).expect("plant symlink");

        let res = ensure_baseline_dir(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "symlinked .plan-tree must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&target).ok();
    }

    /// FREEZE ROUND-TRIP: `freeze_baseline` recursively copies `<cwd>/.plan-tree/prototype/` into
    /// `<cwd>/.plan-tree/baseline/`, files AND nested subdirs preserved byte-for-byte. Falsifiable:
    /// skip the recursion and the nested-file read panics.
    #[test]
    fn freeze_baseline_copies_files_and_subdirs() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(proto.join("assets")).expect("seed prototype dir + subdir");
        std::fs::write(proto.join("index.html"), "<html>proto</html>").expect("seed index");
        std::fs::write(proto.join("assets/app.js"), "console.log('hi')").expect("seed nested file");

        let returned =
            freeze_baseline(cwd.to_string_lossy().to_string()).expect("freeze should succeed");
        assert!(
            returned.ends_with("/.plan-tree/baseline"),
            "returned path must be the baseline dir: {returned}"
        );

        let base = cwd.join(".plan-tree").join("baseline");
        assert_eq!(
            std::fs::read_to_string(base.join("index.html")).expect("frozen index"),
            "<html>proto</html>"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("assets/app.js")).expect("frozen nested file"),
            "console.log('hi')"
        );

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// `freeze_baseline` with NO prototype dir errors (nothing to freeze) and creates no baseline.
    /// Falsifiable: if freeze ignored the missing source, it would create an empty baseline and
    /// succeed.
    #[test]
    fn freeze_baseline_errors_without_prototype() {
        let cwd = unique_temp_dir();
        std::fs::create_dir_all(cwd.join(".plan-tree")).expect("seed .plan-tree (no prototype)");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "freeze without a prototype dir must error, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
    }

    /// FREEZE SYMLINK DEFENSE: a symlink INSIDE `prototype/` pointing OUT of it must be rejected
    /// (the freeze never follows a link to copy outside content), and the link's target left
    /// untouched (no copy planted). Falsifiable: follow the symlink instead of rejecting and the
    /// out-of-tree victim is copied into baseline.
    #[cfg(unix)]
    #[test]
    fn freeze_baseline_rejects_inward_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), proto.join("link.html"))
            .expect("plant symlink");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(res.is_err(), "freeze must reject a symlink entry, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// FREEZE DESTINATION SYMLINK DEFENSE: a symlink pre-planted at the DESTINATION (inside
    /// `baseline/`, same name as a prototype file) pointing OUT of `.plan-tree/` must be rejected —
    /// `std::fs::copy` would otherwise FOLLOW the link and overwrite the out-of-tree target with the
    /// prototype's bytes. The freeze must error and leave the victim untouched. Falsifiable: remove
    /// the destination `symlink_metadata` guard in `copy_tree_contained`'s file branch and the victim
    /// is overwritten with the prototype content (the assertion goes RED).
    #[cfg(unix)]
    #[test]
    fn freeze_baseline_rejects_destination_symlink() {
        let cwd = unique_temp_dir();
        let proto = cwd.join(".plan-tree").join("prototype");
        std::fs::create_dir_all(&proto).expect("seed prototype dir");
        std::fs::write(proto.join("index.html"), "PROTO").expect("seed prototype file");

        // An out-of-containment victim the planted destination symlink points at.
        let outside = unique_temp_dir();
        let victim = outside.join("victim.html");
        std::fs::write(&victim, "ORIGINAL").expect("seed victim");

        // Pre-plant the baseline dir with a symlink whose name collides with the prototype file, so
        // the copy resolves dst_child to it.
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        std::os::unix::fs::symlink(&victim, base.join("index.html")).expect("plant dst symlink");

        let res = freeze_baseline(cwd.to_string_lossy().to_string());
        assert!(
            res.is_err(),
            "freeze must reject a symlink at the destination, got {res:?}"
        );
        // The out-of-tree victim must be untouched (the copy never followed the link).
        assert_eq!(
            std::fs::read_to_string(&victim).expect("victim still readable"),
            "ORIGINAL",
            "destination symlink must NOT be followed to overwrite the out-of-tree victim"
        );

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// `validated_baseline_file` containment: traversal out of baseline/, an absolute path outside
    /// the cwd, a file at the `.plan-tree` ROOT (inside cwd but NOT under baseline/), a DIRECTORY
    /// inside baseline/, and the baseline dir itself are ALL rejected; a real file under baseline/
    /// is accepted relative-to-cwd and absolutely, returning an absolute path. Falsifiable: drop the
    /// `starts_with` containment check and the `.plan-tree`-root case validates.
    #[test]
    fn validated_baseline_file_containment() {
        let cwd = unique_temp_dir();
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        std::fs::write(base.join("index.html"), "<html></html>").expect("seed index.html");
        std::fs::create_dir_all(base.join("assets")).expect("seed subdir");
        std::fs::write(cwd.join(".plan-tree").join("master.md"), "not a baseline")
            .expect("seed plan-tree-root file");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");

        let cwd_s = cwd.to_string_lossy().to_string();

        // Accept: relative-to-cwd addressing.
        let ok = validated_baseline_file(&cwd_s, ".plan-tree/baseline/index.html")
            .expect("relative in-dir file must validate");
        assert!(ok.is_absolute(), "validated path must be absolute: {ok:?}");
        assert!(ok.ends_with(".plan-tree/baseline/index.html"), "got {ok:?}");

        // Accept: absolute addressing of the same file.
        let abs = base.join("index.html").to_string_lossy().to_string();
        validated_baseline_file(&cwd_s, &abs).expect("absolute in-dir file must validate");

        // Reject: traversal escaping baseline/ (resolves to the out-of-cwd victim).
        let depth = outside.components().count();
        let ups = "../".repeat(depth + 4);
        let traversal = format!(
            ".plan-tree/baseline/{ups}{}/victim.html",
            outside.to_string_lossy().trim_start_matches('/')
        );
        let res = validated_baseline_file(&cwd_s, &traversal);
        assert!(res.is_err(), "traversal must be rejected, got {res:?}");

        // Reject: absolute path outside the cwd entirely.
        let res = validated_baseline_file(
            &cwd_s,
            &outside.join("victim.html").to_string_lossy().to_string(),
        );
        assert!(res.is_err(), "outside-cwd absolute path must be rejected, got {res:?}");

        // Reject: a real file inside .plan-tree but NOT under baseline/.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/master.md");
        assert!(res.is_err(), ".plan-tree-root file must be rejected, got {res:?}");

        // Reject: a directory inside baseline/.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline/assets");
        assert!(res.is_err(), "directory must be rejected, got {res:?}");

        // Reject: the baseline dir itself.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline");
        assert!(res.is_err(), "the baseline dir itself must be rejected, got {res:?}");

        // Reject: a missing file.
        let res = validated_baseline_file(&cwd_s, ".plan-tree/baseline/ghost.html");
        assert!(res.is_err(), "missing file must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }

    /// A SYMLINK inside `baseline/` pointing OUT of it must be rejected: validation operates on the
    /// canonical (resolved) path, which lands outside the canonical baseline dir. Falsifiable:
    /// validate the un-canonicalized join instead and the symlink passes.
    #[cfg(unix)]
    #[test]
    fn validated_baseline_file_rejects_outward_symlink() {
        let cwd = unique_temp_dir();
        let base = cwd.join(".plan-tree").join("baseline");
        std::fs::create_dir_all(&base).expect("seed baseline dir");
        let outside = unique_temp_dir();
        std::fs::write(outside.join("victim.html"), "outside").expect("seed victim");
        std::os::unix::fs::symlink(outside.join("victim.html"), base.join("link.html"))
            .expect("plant symlink");

        let res = validated_baseline_file(&cwd.to_string_lossy(), ".plan-tree/baseline/link.html");
        assert!(res.is_err(), "outward symlink must be rejected, got {res:?}");

        std::fs::remove_dir_all(&cwd).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
