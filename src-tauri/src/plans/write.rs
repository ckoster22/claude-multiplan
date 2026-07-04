// write_agent_plan: materialize an agent-emitted plan as a REAL
// file under ~/.claude/plans/ so the existing path-keyed review surface + sidebar
// nesting work unchanged. Plus the tree-cwd auto-capture that keeps app-generated plans
// resolvable (`capture_tree_cwd`, called by `plan_tree::write_plan_tree_file`).
//
// This INTENTIONALLY relaxes the viewer-era "never write into plans/" rule: as a
// Claude Code replacement, the app is now a plan PRODUCER and plans/ is its
// canonical, single-rooted store. (The app still NEVER writes into projects/.)
//
// Frontmatter ⇄ nesting mapping (must match `parse_marker` / `arrange_plans`):
//   - parse_marker recognizes ONLY `tree_id` / `flavor` / `nn`; `flavor` is a CLOSED
//     set of `master` | `sub` (anything else ⇒ the marker is ignored ⇒ standalone).
//   - arrange_plans nests a `sub` UNDER a `master` of the same `tree_id`; a `sub`
//     with NO surviving master of its tree_id is demoted to standalone (no nesting).
//   Therefore, for a master + its subs (or re-plan VERSIONS) to group as a tree:
//     * The MASTER (caller passes `nn: None`) is written as `flavor: master` — the
//       top-level group row. (Masters carry no `nn`.) If the caller supplies a
//       `tree_id` it is reused; if `None`, a fresh `tree_id` is seeded.
//     * Each SUB (caller passes the SAME `tree_id` and its `nn`) is written as
//       `flavor: sub`, which nests under that master and orders by `nn` ascending.
//   FLAVOR IS KEYED ON `nn`, NOT on whether a `tree_id` was supplied: the multiplan
//   orchestrator generates the `tree_id` itself (always `Some`) and distinguishes the
//   master from its subs ONLY by `nn` (None ⇒ master, Some ⇒ sub). The legacy viewer
//   contract — `(tree_id None, nn None) ⇒ master`, `(tree_id Some, nn Some) ⇒ sub` —
//   is a strict subset of this rule.

use std::path::PathBuf;
use std::sync::Mutex;

use crate::model::{ModelOptions, RawFlavor};
use crate::paths::{plans_dir, valid_review_id};
use crate::plans::resume::tree_id_from_state_json;
use crate::state::app_state::AppState;
use crate::state::persist::{atomic_write, nanos_suffix, persist_tree_cwd_index};

/// Auto-capture core: given a `state.json` payload + the cwd it was written for, upsert
/// `index[tree_id] = cwd` and persist (best-effort). A payload without a parseable `tree_id`
/// leaves the index UNCHANGED (no write). Returns `true` iff an entry was upserted.
pub(crate) fn capture_tree_cwd(state: &Mutex<AppState>, cwd: &str, state_json: &str) -> bool {
    let Some(tree_id) = tree_id_from_state_json(state_json) else {
        return false; // no tree_id ⇒ leave the index untouched
    };
    let (snapshot, data_dir) = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.tree_cwd_index.insert(tree_id, cwd.to_string());
        (guard.tree_cwd_index.clone(), guard.data_dir.clone())
    };
    persist_tree_cwd_index(&data_dir, &snapshot);
    true
}

/// True iff `slug` is a safe single path segment usable as a plan-file stem. Same rule set as
/// `valid_review_id` (non-empty; not `.`/`..`; no leading `.`; only ASCII `[A-Za-z0-9._-]`, so
/// no `/`, `\`, or `..` traversal). Kept separate for intent — plan stems and review ids are
/// distinct concepts — but the character class is identical (no regex dependency exists).
pub(crate) fn valid_plan_slug(slug: &str) -> bool {
    valid_review_id(slug)
}

/// Containment-guarded path `<plans_dir>/<slug>.md`. Mirrors `guarded_path_in`: validate the
/// slug syntactically, join, then canonicalize the PARENT (which exists) and assert it equals
/// the canonicalized plans dir. The target file does not exist yet, so the PARENT — not the
/// target — is canonicalized. Rejects (Err) any slug that would escape `plans_dir()` (e.g.
/// `../evil`). Creates no file.
pub(crate) fn guarded_plan_path(dir: Option<PathBuf>, slug: &str) -> Result<PathBuf, String> {
    if !valid_plan_slug(slug) {
        return Err("invalid plan slug".to_string());
    }
    let dir = dir.ok_or_else(|| "could not locate plans directory".to_string())?;
    let joined = dir.join(format!("{slug}.md"));
    let parent = joined
        .parent()
        .ok_or_else(|| "joined path has no parent".to_string())?;
    let canon_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("plans dir unavailable: {e}"))?;
    let canon_dir =
        std::fs::canonicalize(&dir).map_err(|e| format!("plans dir unavailable: {e}"))?;
    if canon_parent != canon_dir {
        return Err("path escapes the plans directory".to_string());
    }
    Ok(joined)
}

/// Generate a fresh, unguessable tree_id from process + clock entropy (uppercase hex). No uuid
/// crate exists in Cargo.toml and one re-plan tree never needs cryptographic uniqueness, so a
/// pid+nanos hex stamp is sufficient and adds zero dependencies.
pub(crate) fn fresh_tree_id() -> String {
    let pid = std::process::id();
    let nanos = nanos_suffix();
    format!("AGENT-{pid:08X}-{nanos:032X}")
}

/// True iff `nn` is a CANONICAL dotted id for the write side: `SEG("."SEG)*` where each segment
/// is EXACTLY two ASCII digits (zero-padded) with value 1-99. Stricter than the read-side
/// `parse_nn_segments` (which tolerates the legacy unpadded `nn: 2`): the app writes only the
/// canonical form, so `"2"`, `"02."`, `"02..01"`, `".02"`, `"00"`, and `"100"` are all rejected.
pub(crate) fn valid_dotted_nn(nn: &str) -> bool {
    if nn.is_empty() {
        return false;
    }
    nn.split('.').all(|seg| {
        let b = seg.as_bytes();
        b.len() == 2
            && b[0].is_ascii_digit()
            && b[1].is_ascii_digit()
            && seg != "00" // value range 1-99 (two digits already cap at 99)
    })
}

/// PURE core of `write_agent_plan`, parameterized on the plans `base` dir so it is unit-testable
/// against a tempdir (no real `~/.claude/plans/` needed). Decides flavor/tree_id/nn, builds the
/// frontmatter + body, derives a safe slug, containment-guards the path, and atomically writes.
/// Returns the absolute path of the written file as a String. `nn` is the canonical
/// zero-padded DOTTED id string (`"02"`, `"02.01"`, …) — malformed values are rejected loudly.
pub(crate) fn write_agent_plan_in(
    base: Option<PathBuf>,
    plan: &str,
    tree_id: Option<String>,
    nn: Option<String>,
    execution_model: Option<ModelOptions>,
) -> Result<String, String> {
    // Validate BEFORE deciding anything: a malformed dotted id must fail loudly, never be
    // silently coerced (a typo'd id would otherwise mint an unparseable frontmatter marker).
    if let Some(n) = &nn {
        if !valid_dotted_nn(n) {
            return Err(format!(
                "invalid dotted nn {n:?}: expected zero-padded two-digit segments 01-99 joined by '.' (e.g. \"02\" or \"02.01\")"
            ));
        }
    }
    // Flavor is keyed on `nn`, NOT on whether a tree_id was supplied. This is load-bearing for the
    // multiplan orchestrator, which generates the tree_id ITSELF (so it is ALWAYS Some) and signals
    // master-vs-sub purely through `nn`:
    //   nn None  ⇒ MASTER ⇒ flavor master, NO nn. tree_id is reused if supplied, else freshly seeded.
    //   nn Some  ⇒ SUB    ⇒ flavor sub, that nn. tree_id is reused if supplied, else freshly seeded.
    // The legacy viewer-era contract is a strict subset of this: (tree_id None, nn None) still ⇒ a
    // fresh-tree master, and (tree_id Some, nn Some) still ⇒ a sub of that tree.
    let (resolved_tree_id, flavor, resolved_nn): (String, RawFlavor, Option<String>) = match nn {
        None => (
            tree_id.unwrap_or_else(fresh_tree_id),
            RawFlavor::Master,
            None,
        ),
        Some(n) => (tree_id.unwrap_or_else(fresh_tree_id), RawFlavor::Sub, Some(n)),
    };

    // Build a deterministic-where-possible, traversal-free slug. The tree_id is already a safe
    // token (hex / caller-supplied); we still derive entropy so re-plans never collide on a
    // filename within the same tree. `nanos_suffix` mirrors `atomic_write`'s temp-name entropy.
    // The nn part is the dotted id verbatim (`valid_plan_slug` already allows '.').
    let nn_part = resolved_nn.clone().unwrap_or_else(|| "00".to_string());
    let entropy = nanos_suffix();
    let raw_slug = format!("agent-plan-{resolved_tree_id}-{nn_part}-{entropy:032X}");
    // Sanitize to the safe character class (the tree_id could in theory contain a separator if a
    // caller hand-supplied one; replacing keeps the slug a single safe segment). The containment
    // guard below is the load-bearing backstop regardless.
    let slug: String = raw_slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    let flavor_str = match flavor {
        RawFlavor::Master => "master",
        RawFlavor::Sub => "sub",
    };

    // Frontmatter: exactly the keys `parse_marker` reads (`tree_id`, `flavor`, `nn` only for
    // subs, and `execution_model`/`execution_effort` only when a model is carried). A leading-`---`
    // block on line 1 is what `split_frontmatter` strips on read. The model id is emitted VERBATIM
    // and unquoted — `parse_marker` splits on the first `:` and trims quotes, and current model ids
    // contain no `:` or spaces, so the flat line round-trips cleanly.
    let mut frontmatter = String::new();
    frontmatter.push_str("---\n");
    frontmatter.push_str(&format!("tree_id: {resolved_tree_id}\n"));
    frontmatter.push_str(&format!("flavor: {flavor_str}\n"));
    if let Some(n) = &resolved_nn {
        frontmatter.push_str(&format!("nn: {n}\n"));
    }
    if let Some(m) = &execution_model {
        frontmatter.push_str(&format!("execution_model: {}\n", m.model));
        if let Some(effort) = &m.effort {
            frontmatter.push_str(&format!("execution_effort: {effort}\n"));
        }
    }
    frontmatter.push_str("---\n\n");

    // Containment guard: the only path this can land at is inside the plans dir.
    let path = guarded_plan_path(base, &slug)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut contents = frontmatter;
    contents.push_str(plan);
    atomic_write(&path, contents.as_bytes()).map_err(|e| format!("write failed: {e}"))?;

    Ok(path.to_string_lossy().to_string())
}

/// Materialize an agent-emitted plan as a real markdown file under `~/.claude/plans/`, tagged
/// with app frontmatter so the sidebar nests re-plan versions, and return its absolute path.
/// See the module-level comment for the frontmatter ⇄ nesting mapping. Atomic + containment-
/// guarded (the write can only land inside `plans_dir()`). This is the ONE place the prior
/// "never write into plans/" rule is relaxed; the app still never writes into `projects/`.
/// WIRE: `nn` is `Option<String>` — the canonical zero-padded dotted id. A bare JSON
/// integer (`nn: 2`) is REJECTED by serde at the invoke boundary;
/// every TS call site sends the `pathKey()` string (or null for the master).
#[tauri::command]
pub fn write_agent_plan(
    plan: String,
    tree_id: Option<String>,
    nn: Option<String>,
    execution_model: Option<ModelOptions>,
) -> Result<String, String> {
    write_agent_plan_in(plans_dir(), &plan, tree_id, nn, execution_model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use std::collections::HashMap;
    use serde::Deserialize;
    use crate::model::{Flavor, RawMarker};
    use crate::paths::is_within;
    use crate::plans::arrange::arrange_plans;
    use crate::plans::frontmatter::{parse_marker, split_frontmatter};
    use crate::state::persist::load_tree_cwd_index;

    /// Seed emission (tree_id None) ⇒ a REAL file under the plans dir, with `flavor: master`
    /// frontmatter that `parse_marker` round-trips, and the returned path is contained in base.
    #[test]
    fn write_agent_plan_seed_writes_master_under_base() {
        let base = unique_dir("wap_seed");
        let body = "# My Plan\n\nDo the thing.\n";

        let path_str = write_agent_plan_in(Some(base.clone()), body, None, None, None)
            .expect("seed write succeeds");
        let path = PathBuf::from(&path_str);

        // The returned path is a real file inside the plans dir (containment).
        assert!(path.exists(), "written plan file must exist on disk");
        let canon_base = std::fs::canonicalize(&base).expect("canon base");
        let canon_path = std::fs::canonicalize(&path).expect("canon path");
        assert!(
            is_within(&canon_base, &canon_path),
            "written path {canon_path:?} must live inside the plans dir {canon_base:?}"
        );
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("md"));

        // Frontmatter parses as a MASTER marker (the seed) — exactly the keys parse_marker reads.
        let contents = std::fs::read_to_string(&path).expect("read written plan");
        let (yaml, parsed_body) = split_frontmatter(&contents);
        let marker = parse_marker(yaml.expect("seed file has frontmatter"))
            .expect("seed frontmatter parses as a marker");
        assert_eq!(marker.flavor, RawFlavor::Master, "seed emission must be a master");
        assert!(!marker.tree_id.is_empty(), "seed must carry a fresh tree_id");
        assert_eq!(marker.nn, None, "a master carries no nn");
        // Body is preserved verbatim after the stripped marker (modulo the single conventional
        // blank line that separates the frontmatter block from the body — same shape as every
        // real plan file, e.g. the seed plan's own `---\n\n# Sub-Plan ...`).
        assert_eq!(
            parsed_body.trim_start_matches('\n'),
            body,
            "the plan body must be written verbatim"
        );
        assert!(
            parsed_body.contains("Do the thing."),
            "the original plan markdown must survive into the body"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A re-plan (same tree_id, incremented nn) is written as `flavor: sub` with that nn, and
    /// `arrange_plans` NESTS it under the seed master of the same tree_id — i.e. re-plans group
    /// as versions. This asserts the end-to-end frontmatter ⇄ nesting contract.
    #[test]
    fn write_agent_plan_replan_nests_under_seed_master() {
        let base = unique_dir("wap_replan");

        // Seed (master) then a re-plan (sub, nn=2) sharing the seed's tree_id.
        let seed_path = write_agent_plan_in(Some(base.clone()), "# v1\n", None, None, None)
            .expect("seed write");
        let seed_contents = std::fs::read_to_string(&seed_path).expect("read seed");
        let (seed_yaml, _) = split_frontmatter(&seed_contents);
        let tree_id = parse_marker(seed_yaml.expect("seed frontmatter"))
            .expect("seed marker")
            .tree_id;

        let replan_path = write_agent_plan_in(
            Some(base.clone()),
            "# v2\n",
            Some(tree_id.clone()),
            Some("02".to_string()),
            None,
        )
        .expect("re-plan write");
        let replan_contents = std::fs::read_to_string(&replan_path).expect("read re-plan");
        let (replan_yaml, _) = split_frontmatter(&replan_contents);
        let replan_marker = parse_marker(replan_yaml.expect("re-plan frontmatter"))
            .expect("re-plan marker");
        assert_eq!(replan_marker.flavor, RawFlavor::Sub, "a re-plan must be a sub");
        assert_eq!(replan_marker.tree_id, tree_id, "a re-plan reuses the seed tree_id");
        assert_eq!(replan_marker.nn, Some(vec![2]), "a re-plan carries its nn");

        // Feed both into arrange_plans: the sub must nest UNDER the master (not be demoted).
        let master_row = raw_row(
            "seed",
            100,
            Some(RawMarker {
                tree_id: tree_id.clone(),
                flavor: RawFlavor::Master,
                nn: None,
                execution_model: None,
            }),
        );
        let sub_row = raw_row(
            "replan",
            200,
            Some(RawMarker {
                tree_id: tree_id.clone(),
                flavor: RawFlavor::Sub,
                nn: Some(vec![2]),
                execution_model: None,
            }),
        );
        let out = arrange_plans(vec![master_row, sub_row], &HashMap::new());
        let master = out.iter().find(|r| r.filename_stem == "seed").expect("master present");
        let sub = out.iter().find(|r| r.filename_stem == "replan").expect("sub present");
        assert_eq!(master.flavor, Flavor::Master, "seed groups as the master");
        assert_eq!(master.child_count, Some(1), "the master owns its one re-plan version");
        assert_eq!(sub.flavor, Flavor::Sub, "the re-plan nests as a sub (a version)");
        assert_eq!(sub.tree_id.as_deref(), Some(tree_id.as_str()));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// REGRESSION (the orchestrator master-write bug): a CALLER-SUPPLIED tree_id with `nn: None`
    /// MUST be written as `flavor: master` carrying that exact tree_id and no `nn` — NOT as a sub.
    /// The multiplan orchestrator seeds its own tree_id (so it is always `Some`) and signals the
    /// master via `nn: None`. INVERT-CHECK: revert `write_agent_plan_in` to keying flavor on
    /// `tree_id.is_some()` and this test goes RED (it observes `flavor: sub, nn: Some(2)`). It also
    /// feeds the master + a real sub of the same tree into `arrange_plans` and asserts the sub NESTS
    /// under the master — the end-to-end nesting the live sidebar depends on.
    #[test]
    fn write_agent_plan_supplied_tree_id_no_nn_is_master_and_nests_subs() {
        let base = unique_dir("wap_orch_master");
        let tree_id = "tree-mq5si307-04766f19".to_string();

        // The orchestrator's MASTER write: tree_id Some, nn None.
        let master_path =
            write_agent_plan_in(Some(base.clone()), "# Master Plan\n", Some(tree_id.clone()), None, None)
                .expect("master write succeeds");
        let master_contents = std::fs::read_to_string(&master_path).expect("read master");
        let (master_yaml, _) = split_frontmatter(&master_contents);
        let master_marker = parse_marker(master_yaml.expect("master frontmatter"))
            .expect("master frontmatter parses as a marker");
        assert_eq!(
            master_marker.flavor,
            RawFlavor::Master,
            "tree_id Some + nn None MUST be a master (the orchestrator master-write contract)"
        );
        assert_eq!(
            master_marker.tree_id, tree_id,
            "the master MUST carry the caller-supplied tree_id verbatim (so subs nest under it)"
        );
        assert_eq!(master_marker.nn, None, "a master carries no nn");

        // The orchestrator's SUB write: SAME tree_id, nn Some("01").
        let sub_path = write_agent_plan_in(
            Some(base.clone()),
            "# Sub 01\n",
            Some(tree_id.clone()),
            Some("01".to_string()),
            None,
        )
        .expect("sub write succeeds");
        let sub_contents = std::fs::read_to_string(&sub_path).expect("read sub");
        let (sub_yaml, _) = split_frontmatter(&sub_contents);
        let sub_marker =
            parse_marker(sub_yaml.expect("sub frontmatter")).expect("sub frontmatter parses");
        assert_eq!(sub_marker.flavor, RawFlavor::Sub, "tree_id Some + nn Some ⇒ sub");
        assert_eq!(sub_marker.tree_id, tree_id, "the sub reuses the master's tree_id");
        assert_eq!(sub_marker.nn, Some(vec![1]), "the sub carries its nn");

        // End-to-end: the master + sub of the same tree_id NEST in arrange_plans.
        let master_row = raw_row(
            "master",
            100,
            Some(RawMarker { tree_id: tree_id.clone(), flavor: RawFlavor::Master, nn: None, execution_model: None }),
        );
        let sub_row = raw_row(
            "sub01",
            200,
            Some(RawMarker { tree_id: tree_id.clone(), flavor: RawFlavor::Sub, nn: Some(vec![1]), execution_model: None }),
        );
        let out = arrange_plans(vec![master_row, sub_row], &HashMap::new());
        let master = out.iter().find(|r| r.filename_stem == "master").expect("master present");
        let sub = out.iter().find(|r| r.filename_stem == "sub01").expect("sub present");
        assert_eq!(master.flavor, Flavor::Master, "the master groups as the master row");
        assert_eq!(master.child_count, Some(1), "the master owns its one sub");
        assert_eq!(sub.flavor, Flavor::Sub, "the sub nests under the master");
        assert_eq!(sub.tree_id.as_deref(), Some(tree_id.as_str()));

        // A DOTTED child of the same tree round-trips its dotted nn through
        // the frontmatter (`nn: 01.01`) and nests under the same master, ordered directly after
        // its `01` prefix (depth-first dotted order).
        let dotted_path = write_agent_plan_in(
            Some(base.clone()),
            "# Sub 01.01\n",
            Some(tree_id.clone()),
            Some("01.01".to_string()),
            None,
        )
        .expect("dotted sub write succeeds");
        let dotted_contents = std::fs::read_to_string(&dotted_path).expect("read dotted sub");
        let (dotted_yaml, _) = split_frontmatter(&dotted_contents);
        let dotted_marker =
            parse_marker(dotted_yaml.expect("dotted frontmatter")).expect("dotted parses");
        assert_eq!(dotted_marker.flavor, RawFlavor::Sub);
        assert_eq!(dotted_marker.nn, Some(vec![1, 1]), "the dotted nn round-trips per-segment");

        let master_row2 = raw_row(
            "master",
            100,
            Some(RawMarker { tree_id: tree_id.clone(), flavor: RawFlavor::Master, nn: None, execution_model: None }),
        );
        let sub_row2 = raw_row(
            "sub01",
            200,
            Some(RawMarker { tree_id: tree_id.clone(), flavor: RawFlavor::Sub, nn: Some(vec![1]), execution_model: None }),
        );
        let dotted_row = raw_row(
            "sub01-01",
            300,
            Some(RawMarker {
                tree_id: tree_id.clone(),
                flavor: RawFlavor::Sub,
                nn: Some(vec![1, 1]),
                execution_model: None,
            }),
        );
        let out = arrange_plans(vec![dotted_row, master_row2, sub_row2], &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub01", "sub01-01"],
            "master first, then 01 then its dotted child 01.01"
        );
        let master2 = out.iter().find(|r| r.filename_stem == "master").expect("master present");
        let dotted = out.iter().find(|r| r.filename_stem == "sub01-01").expect("dotted present");
        assert_eq!(master2.child_count, Some(2), "the master owns BOTH subs (two-level grouping)");
        assert_eq!(dotted.nn, Some(1), "dotted child's legacy nn = first segment");
        assert_eq!(dotted.nn_path.as_deref(), Some("01.01"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A DOTTED nn writes `flavor: sub` frontmatter carrying the dotted id verbatim
    /// (`nn: 02.01`) and embeds the dotted id in the slug (valid_plan_slug allows '.').
    /// Falsifiable: formatting the nn through anything but the verbatim string (e.g. first
    /// segment only) breaks the frontmatter/slug asserts.
    #[test]
    fn write_agent_plan_dotted_nn_writes_dotted_frontmatter_and_slug() {
        let base = unique_dir("wap_dotted");
        let path = write_agent_plan_in(
            Some(base.clone()),
            "# Nested\n",
            Some("tree-x".to_string()),
            Some("02.01".to_string()),
            None,
        )
        .expect("dotted write succeeds");
        let contents = std::fs::read_to_string(&path).expect("read dotted plan");
        assert!(
            contents.contains("\nnn: 02.01\n"),
            "frontmatter must carry the dotted nn verbatim, got:\n{contents}"
        );
        assert!(
            contents.contains("\nflavor: sub\n"),
            "a dotted-nn write is a sub"
        );
        let stem = PathBuf::from(&path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
            .expect("stem");
        assert!(
            stem.contains("-02.01-"),
            "the slug's nn part must be the dotted id, got {stem:?}"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A MALFORMED dotted nn is rejected LOUDLY (Err) and writes NOTHING. The write
    /// side accepts only the canonical zero-padded form — read-side leniency does not apply.
    /// Falsifiable: drop the `valid_dotted_nn` guard and "2" / "02." write files → RED.
    #[test]
    fn write_agent_plan_rejects_malformed_dotted_nn() {
        let base = unique_dir("wap_badnn");
        // Seed so the dir exists and stray writes are detectable.
        write_agent_plan_in(Some(base.clone()), "# seed\n", None, None, None).expect("seed");
        let before = std::fs::read_dir(&base).expect("list").count();

        for bad in ["2", "002", "02.", "02..01", ".02", "02.1", "00", "02.00", "", "2.1", "02-01"] {
            let res = write_agent_plan_in(
                Some(base.clone()),
                "# evil\n",
                Some("tree-x".to_string()),
                Some(bad.to_string()),
                None,
            );
            assert!(res.is_err(), "malformed nn {bad:?} must be rejected, got {res:?}");
        }
        let after = std::fs::read_dir(&base).expect("list").count();
        assert_eq!(after, before, "no rejected nn may have produced a file");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// WIRE PIN: the `nn` invoke argument is `Option<String>` — a bare JSON integer
    /// (e.g. a stale TS fake still sending `nn: 2`) must FAIL serde
    /// deserialization at the invoke boundary, never be silently stringified. The struct mirrors
    /// the tauri command's argument deserialization. Falsifiable: widen the field back to a
    /// number-tolerant type and the is_err assert goes RED.
    #[test]
    fn write_agent_plan_nn_wire_rejects_bare_integer() {
        #[derive(Deserialize)]
        struct Args {
            #[allow(dead_code)]
            nn: Option<String>,
        }
        let res = serde_json::from_str::<Args>(r#"{ "nn": 2 }"#);
        assert!(res.is_err(), "a bare JSON integer nn must be rejected by serde");
        // The two valid wire shapes still parse: a dotted string and null.
        assert!(serde_json::from_str::<Args>(r#"{ "nn": "02.01" }"#).is_ok());
        assert!(serde_json::from_str::<Args>(r#"{ "nn": null }"#).is_ok());
    }

    /// CONTAINMENT GUARD (falsifiable): a traversal-y slug cannot escape the plans dir.
    /// `guarded_plan_path` is the load-bearing backstop; here we prove a `../`-style slug is
    /// rejected with Err AND that no file is created outside the base dir. INVERT-CHECK: removing
    /// the `valid_plan_slug` + canonicalized-parent check in `guarded_plan_path` would let the
    /// joined path resolve into the parent of `base`, and this test would then see an escaped
    /// file (or an Ok), turning it RED.
    #[test]
    fn guarded_plan_path_rejects_traversal_slug() {
        let base = unique_dir("wap_guard");
        // A sibling marker file we will assert is never created by an escape attempt.
        let escape_target = base
            .parent()
            .expect("base has a parent")
            .join("evil.md");
        let _ = std::fs::remove_file(&escape_target); // ensure a clean slate

        let result = guarded_plan_path(Some(base.clone()), "../evil");
        assert!(
            result.is_err(),
            "a traversal slug must be rejected, got {result:?}"
        );
        assert!(
            !escape_target.exists(),
            "the guard must not allow any file to be written outside the plans dir"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Write→read round-trip: `write_agent_plan_in` emits the model id VERBATIM and unquoted, and
    /// `parse_marker` reads it back into the same `ModelOptions`. Falsifiable: quoting the emitted
    /// id (`execution_model: "claude-opus-4-8"`) survives parse_marker's quote-trim, but dropping
    /// the writer's frontmatter lines makes the read-back None ⇒ RED.
    #[test]
    fn write_agent_plan_in_round_trips_execution_model() {
        let base = unique_dir("wap_model");
        let path = write_agent_plan_in(
            Some(base.clone()),
            "# Plan\n",
            Some("tree-m".to_string()),
            Some("01".to_string()),
            Some(ModelOptions {
                model: "claude-opus-4-8".to_string(),
                effort: Some("high".to_string()),
            }),
        )
        .expect("model write succeeds");
        let contents = std::fs::read_to_string(&path).expect("read written plan");
        assert!(
            contents.contains("\nexecution_model: claude-opus-4-8\n"),
            "model id must be written verbatim + unquoted, got:\n{contents}"
        );
        assert!(
            contents.contains("\nexecution_effort: high\n"),
            "effort must be written when present, got:\n{contents}"
        );
        let (yaml, _) = split_frontmatter(&contents);
        let marker = parse_marker(yaml.expect("frontmatter")).expect("parses");
        assert_eq!(
            marker.execution_model,
            Some(ModelOptions {
                model: "claude-opus-4-8".to_string(),
                effort: Some("high".to_string()),
            }),
            "the written model must round-trip back through parse_marker"
        );

        // Effort omitted ⇒ no execution_effort line; reads back as effort None.
        let path2 = write_agent_plan_in(
            Some(base.clone()),
            "# Plan2\n",
            Some("tree-m".to_string()),
            Some("02".to_string()),
            Some(ModelOptions {
                model: "claude-sonnet-5".to_string(),
                effort: None,
            }),
        )
        .expect("model-only write succeeds");
        let contents2 = std::fs::read_to_string(&path2).expect("read plan2");
        assert!(
            !contents2.contains("execution_effort:"),
            "no execution_effort line when effort is None, got:\n{contents2}"
        );
        let (yaml2, _) = split_frontmatter(&contents2);
        let marker2 = parse_marker(yaml2.expect("frontmatter2")).expect("parses2");
        assert_eq!(
            marker2.execution_model,
            Some(ModelOptions {
                model: "claude-sonnet-5".to_string(),
                effort: None,
            }),
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// AUTO-CAPTURE: a `state.json` payload carrying a `tree_id` upserts `index[tree_id] = cwd` and
    /// persists it. FALSIFIABLE: a payload WITHOUT a `tree_id` leaves the index (and file) untouched.
    #[test]
    fn capture_tree_cwd_upserts_with_tree_id_and_skips_without() {
        let dir = unique_dir("treeCapture");
        let state = app_state_in(&dir);

        // With a tree_id ⇒ upsert + persist.
        let captured = capture_tree_cwd(
            &state,
            "/abs/project",
            r#"{"tree_id":"tree-abc123","phase":"executing"}"#,
        );
        assert!(captured, "a state.json with a tree_id must be captured");
        let loaded = load_tree_cwd_index(&dir);
        assert_eq!(
            loaded.get("tree-abc123").map(String::as_str),
            Some("/abs/project"),
            "the index file must contain the tree_id → cwd mapping"
        );

        // Without a tree_id ⇒ no change. Falsifiable: if capture upserted, the index would grow.
        let captured = capture_tree_cwd(&state, "/other/cwd", r#"{"phase":"executing"}"#);
        assert!(!captured, "a state.json without a tree_id must NOT be captured");
        let reloaded = load_tree_cwd_index(&dir);
        assert_eq!(
            reloaded.len(),
            1,
            "a tree_id-less state.json must leave the index unchanged; got {reloaded:?}"
        );
        assert!(
            !reloaded.values().any(|v| v == "/other/cwd"),
            "the tree_id-less cwd must never appear in the index"
        );

        // Unparseable JSON ⇒ also no change (best-effort, never errors).
        assert!(!capture_tree_cwd(&state, "/x", "not json at all"));
        assert_eq!(load_tree_cwd_index(&dir).len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

}
