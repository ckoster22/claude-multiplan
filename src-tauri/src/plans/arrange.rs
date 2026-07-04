// Pure sidebar-tree arrangement: turn the raw per-file rows into the final ordered
// `PlanRecord`s (flavor normalization + master/child grouping + recency ordering).

use std::collections::HashMap;

use crate::model::{Flavor, PlanRecord, RawFlavor, RawRow};
use crate::plans::frontmatter::format_nn_path;

/// THE pure, testable core of the nested-hierarchy ordering. Given the raw per-file rows and
/// the persisted collapse map, produce the final `Vec<PlanRecord>` pre-ordered for direct
/// top-level rendering by the frontend (no re-aggregation). Pure ⇒ unit-testable without
/// Tauri state or real files (same pure-function pattern as `compute_unread`).
///
/// Rules (closed flavor set with deterministic tie-breaks):
///   - No marker ⇒ standalone.
///   - `master` marker ⇒ master; `child_count` = count of PRESENT subs sharing its tree_id.
///   - duplicate masters on one tree_id ⇒ newest-mtime kept (tie: lexicographic stem);
///     the rest demoted to standalone (tree_id/nn nulled).
///   - `sub` marker WITH a surviving master of the same tree_id ⇒ sub.
///   - `sub` marker WITHOUT a master (orphan) ⇒ standalone (tree_id/nn nulled).
///   - Top level (masters + standalones) interleaved by recency DESC; a master's recency =
///     max mtime over {master file, all present children}.
///   - Each master is immediately followed by ALL its subs (the two-level grouping is kept;
///     the frontend builds visual depth from `nn_path` prefixes) in PER-SEGMENT
///     integer-vector order on the dotted nn (`1 < 1.1 < 1.2 < 2` — depth-first dotted order).
///     This order is mtime-INDEPENDENT for distinct ids; mtime/stem are tie-breaks for
///     IDENTICAL ids only. A dotted sub whose parent prefix row is absent (orphan) still
///     orders by its segments — visual orphan handling is the frontend's job.
pub(crate) fn arrange_plans(rows: Vec<RawRow>, collapse_state: &HashMap<String, bool>) -> Vec<PlanRecord> {
    // For each tree_id, collect candidate master rows; pick newest-mtime, tie lexicographic
    // stem. The surviving master's stem is recorded so the others can be demoted.
    let mut master_candidates: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(m) = &row.marker {
            if m.flavor == RawFlavor::Master {
                master_candidates
                    .entry(m.tree_id.clone())
                    .or_default()
                    .push(i);
            }
        }
    }

    // surviving_master[tree_id] = index of the winning master row.
    let mut surviving_master: HashMap<String, usize> = HashMap::new();
    for (tree_id, idxs) in &master_candidates {
        // newest-mtime first, tie → lexicographically-smallest stem.
        let winner = idxs
            .iter()
            .copied()
            .max_by(|&a, &b| {
                rows[a]
                    .mtime_ms
                    .cmp(&rows[b].mtime_ms)
                    // On an mtime tie we want the lexicographically SMALLEST stem to win, so
                    // invert the stem comparison inside the max.
                    .then_with(|| rows[b].stem.cmp(&rows[a].stem))
            })
            .expect("non-empty candidate list");
        surviving_master.insert(tree_id.clone(), winner);
    }

    // children[tree_id] = Vec of child row indices (only subs whose master survives).
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();

    #[derive(Clone)]
    struct Classified {
        flavor: Flavor,
        tree_id: Option<String>,
        // Legacy first-segment nn + the full canonical dotted id (see PlanRecord).
        nn: Option<u32>,
        nn_path: Option<String>,
    }
    let mut classified: Vec<Classified> = Vec::with_capacity(rows.len());

    for (i, row) in rows.iter().enumerate() {
        let c = match &row.marker {
            None => Classified {
                flavor: Flavor::Standalone,
                tree_id: None,
                nn: None,
                nn_path: None,
            },
            Some(m) => match m.flavor {
                RawFlavor::Master => {
                    if surviving_master.get(&m.tree_id) == Some(&i) {
                        Classified {
                            flavor: Flavor::Master,
                            tree_id: Some(m.tree_id.clone()),
                            nn: None,
                            nn_path: None,
                        }
                    } else {
                        // A duplicate (non-surviving) master ⇒ demote to standalone.
                        Classified {
                            flavor: Flavor::Standalone,
                            tree_id: None,
                            nn: None,
                            nn_path: None,
                        }
                    }
                }
                RawFlavor::Sub => {
                    if surviving_master.contains_key(&m.tree_id) {
                        children.entry(m.tree_id.clone()).or_default().push(i);
                        Classified {
                            flavor: Flavor::Sub,
                            tree_id: Some(m.tree_id.clone()),
                            // Legacy `nn` = FIRST segment; `nn_path` = full canonical dotted id.
                            nn: m.nn.as_ref().and_then(|segs| segs.first().copied()),
                            nn_path: m.nn.as_ref().map(|segs| format_nn_path(segs)),
                        }
                    } else {
                        // Orphan sub (no surviving master) ⇒ standalone, tree_id/nn nulled.
                        Classified {
                            flavor: Flavor::Standalone,
                            tree_id: None,
                            nn: None,
                            nn_path: None,
                        }
                    }
                }
            },
        };
        classified.push(c);
    }

    let build_record = |i: usize, c: &Classified, child_count: Option<u32>| -> PlanRecord {
        let collapsed = match (&c.flavor, &c.tree_id) {
            (Flavor::Master, Some(tid)) => collapse_state.get(tid).copied().unwrap_or(false),
            _ => false,
        };
        PlanRecord {
            absolute_path: rows[i].absolute_path.clone(),
            filename_stem: rows[i].stem.clone(),
            mtime_ms: rows[i].mtime_ms,
            cwd: rows[i].cwd.clone(),
            unread: rows[i].unread,
            flavor: c.flavor,
            tree_id: c.tree_id.clone(),
            nn: c.nn,
            nn_path: c.nn_path.clone(),
            child_count,
            collapsed,
            h1s: rows[i].h1s.clone(),
            execution_model: rows[i]
                .marker
                .as_ref()
                .and_then(|m| m.execution_model.clone()),
        }
    };

    // Order children per master: PER-SEGMENT integer-vector comparison on the
    // dotted nn (Vec<u32> lexicographic Ord IS depth-first dotted order: [1] < [1,1] < [1,2] <
    // [2], because a strict prefix sorts before its extensions). Explicitly mtime-INDEPENDENT
    // for distinct ids — the mtime/stem tie-breaks apply to IDENTICAL ids only (the duplicate-id
    // collision case), so re-drafting a sub never reshuffles the tree order.
    let order_children = |idxs: &[usize]| -> Vec<usize> {
        let mut v = idxs.to_vec();
        v.sort_by(|&a, &b| {
            let na = rows[a].marker.as_ref().and_then(|m| m.nn.as_deref());
            let nb = rows[b].marker.as_ref().and_then(|m| m.nn.as_deref());
            // Subs without an explicit nn sort last among children (is_none: false < true).
            na.is_none()
                .cmp(&nb.is_none())
                .then_with(|| na.cmp(&nb))
                .then_with(|| rows[a].mtime_ms.cmp(&rows[b].mtime_ms))
                .then_with(|| rows[a].stem.cmp(&rows[b].stem))
        });
        v
    };

    // A top-level entry is either a master (with its ordered children) or a standalone.
    struct TopLevel {
        recency: i64,
        // Tie-break key for deterministic ordering when recencies are equal.
        stem: String,
        master_idx: usize,
        ordered_children: Vec<usize>,
        is_master: bool,
    }

    let mut top: Vec<TopLevel> = Vec::new();
    for (i, c) in classified.iter().enumerate() {
        match c.flavor {
            Flavor::Master => {
                let tid = c.tree_id.as_ref().expect("master has tree_id");
                let kids = children.get(tid).map(|v| order_children(v)).unwrap_or_default();
                // Recency = max(master mtime, all present children mtimes).
                let recency = kids
                    .iter()
                    .map(|&k| rows[k].mtime_ms)
                    .chain(std::iter::once(rows[i].mtime_ms))
                    .max()
                    .unwrap_or(rows[i].mtime_ms);
                top.push(TopLevel {
                    recency,
                    stem: rows[i].stem.clone(),
                    master_idx: i,
                    ordered_children: kids,
                    is_master: true,
                });
            }
            Flavor::Standalone => {
                top.push(TopLevel {
                    recency: rows[i].mtime_ms,
                    stem: rows[i].stem.clone(),
                    master_idx: i,
                    ordered_children: Vec::new(),
                    is_master: false,
                });
            }
            // Subs are emitted under their master, never at the top level.
            Flavor::Sub => {}
        }
    }

    // Top level: recency DESC, then stem ASC for a stable, deterministic tie-break.
    top.sort_by(|a, b| {
        b.recency
            .cmp(&a.recency)
            .then_with(|| a.stem.cmp(&b.stem))
    });

    let mut out: Vec<PlanRecord> = Vec::with_capacity(rows.len());
    for entry in &top {
        if entry.is_master {
            let child_count = entry.ordered_children.len() as u32;
            out.push(build_record(
                entry.master_idx,
                &classified[entry.master_idx],
                Some(child_count),
            ));
            for &k in &entry.ordered_children {
                out.push(build_record(k, &classified[k], None));
            }
        } else {
            out.push(build_record(
                entry.master_idx,
                &classified[entry.master_idx],
                None,
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn by_stem(records: &[PlanRecord], stem: &str) -> PlanRecord {
        records
            .iter()
            .find(|r| r.filename_stem == stem)
            .unwrap_or_else(|| panic!("no record for stem {stem}"))
            .clone()
    }

    #[test]
    fn arrange_master_then_two_subs_in_nn_order() {
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub02", 2_000, Some(sub_marker("t", 2))),
            raw_row("sub01", 3_000, Some(sub_marker("t", 1))),
        ];
        let mut collapse = HashMap::new();
        collapse.insert("t".to_string(), true);
        let out = arrange_plans(rows, &collapse);

        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02"],
            "master first, then children in nn-ascending order (NOT mtime)"
        );
        let m = &out[0];
        assert_eq!(m.flavor, Flavor::Master);
        assert_eq!(m.child_count, Some(2), "observed child_count = 2");
        assert!(m.collapsed, "collapsed reflects the collapse map entry (true)");
        assert_eq!(out[1].flavor, Flavor::Sub);
        assert_eq!(out[1].nn, Some(1));
        assert_eq!(out[2].nn, Some(2));
        // Subs carry the join key; their child_count is null.
        assert_eq!(out[1].tree_id.as_deref(), Some("t"));
        assert_eq!(out[1].child_count, None);
    }

    #[test]
    fn arrange_orphan_sub_becomes_standalone() {
        // A sub with no surviving master of its tree_id ⇒ standalone, tree_id/nn nulled.
        let rows = vec![raw_row("orphan", 1_000, Some(sub_marker("ghost", 1)))];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Standalone);
        assert_eq!(out[0].tree_id, None, "orphan sub's tree_id must be nulled");
        assert_eq!(out[0].nn, None, "orphan sub's nn must be nulled");
    }

    #[test]
    fn arrange_master_with_zero_subs_has_child_count_zero() {
        let rows = vec![raw_row("lonely-master", 1_000, Some(master_marker("t")))];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Master);
        assert_eq!(out[0].child_count, Some(0), "a childless master reports child_count = 0");
        assert!(!out[0].collapsed, "absent collapse entry ⇒ expanded (false)");
    }

    #[test]
    fn arrange_observed_child_count_counts_only_present_subs() {
        // A master whose body would describe 3 subs but only 1 sub FILE is present ⇒
        // child_count = 1 (the OBSERVED count, which the "N sub-plans" label depends on).
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub01", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let m = by_stem(&out, "master");
        assert_eq!(m.child_count, Some(1), "observed count = present sub files, not body claims");
    }

    #[test]
    fn arrange_unmarked_file_is_standalone() {
        let rows = vec![raw_row("legacy", 1_000, None)];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].flavor, Flavor::Standalone);
        assert_eq!(out[0].tree_id, None);
        assert_eq!(out[0].child_count, None);
    }

    #[test]
    fn arrange_duplicate_masters_keeps_newest_and_demotes_rest() {
        // Two masters share tree_id "t". The NEWER-mtime one survives; the older is demoted
        // to standalone. The sub attaches to the surviving (newer) master.
        let rows = vec![
            raw_row("master-old", 1_000, Some(master_marker("t"))),
            raw_row("master-new", 5_000, Some(master_marker("t"))),
            raw_row("sub01", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());

        let new = by_stem(&out, "master-new");
        let old = by_stem(&out, "master-old");
        assert_eq!(new.flavor, Flavor::Master, "newest-mtime master survives");
        assert_eq!(new.child_count, Some(1), "the sub attaches to the survivor");
        assert_eq!(old.flavor, Flavor::Standalone, "the older duplicate master is demoted");
        assert_eq!(old.tree_id, None, "demoted master's tree_id is nulled");
        assert_eq!(old.child_count, None);

        // The survivor must be immediately followed by its child in the output.
        let survivor_pos = out.iter().position(|r| r.filename_stem == "master-new").unwrap();
        assert_eq!(
            out[survivor_pos + 1].filename_stem, "sub01",
            "the sub must follow its surviving master"
        );
    }

    #[test]
    fn arrange_duplicate_master_mtime_tie_breaks_lexicographically() {
        // Equal mtime ⇒ lexicographically-smallest stem survives ("alpha" < "beta").
        let rows = vec![
            raw_row("beta", 1_000, Some(master_marker("t"))),
            raw_row("alpha", 1_000, Some(master_marker("t"))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        assert_eq!(by_stem(&out, "alpha").flavor, Flavor::Master, "lexicographic tie-break: alpha wins");
        assert_eq!(by_stem(&out, "beta").flavor, Flavor::Standalone);
    }

    #[test]
    fn arrange_nn_collision_is_deterministic() {
        // Two subs share nn=1. Tie-break is (nn, mtime, stem) — deterministic, no dropped/
        // duplicated rows. The earlier-mtime sub comes first.
        let rows = vec![
            raw_row("master", 5_000, Some(master_marker("t"))),
            raw_row("sub-b", 3_000, Some(sub_marker("t", 1))),
            raw_row("sub-a", 2_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub-a", "sub-b"],
            "nn collision breaks by mtime asc then stem; no rows dropped"
        );
        assert_eq!(out.len(), 3, "all rows present, none duplicated");
        assert_eq!(by_stem(&out, "master").child_count, Some(2));
    }

    #[test]
    fn arrange_recency_interleave_and_children_stay_nn_ascending() {
        // A master whose NEWEST CHILD mtime (9_000) exceeds a standalone's mtime (8_000)
        // must sort ABOVE that standalone — even though the master FILE's own mtime (1_000)
        // is older. And children must emit nn-ascending even when their mtimes are out of
        // order relative to nn.
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            // sub01 (nn=1) has an EARLIER mtime than sub02 (nn=2). So nn-ascending order
            // [sub01, sub02] is the OPPOSITE of mtime-descending [sub02, sub01] — this makes
            // the children-ordering invariant genuinely falsifiable (a mtime sort goes red).
            raw_row("sub01", 4_000, Some(sub_marker("t", 1))),
            raw_row("sub02", 9_000, Some(sub_marker("t", 2))),
            raw_row("standalone-x", 8_000, None),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        // INVERT-CHECK target: children must be nn-ascending [sub01, sub02], NOT mtime-desc.
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02", "standalone-x"],
            "master (recency=9000 via child) above standalone (8000); children nn-ascending"
        );
    }

    /// Children order by PER-SEGMENT integer-vector comparison on the dotted nn: depth-first
    /// dotted order `02 < 02.01 < 02.02 < 03`, mtime-INDEPENDENT for distinct ids. FRAGILITY PIN:
    /// `02` carries the NEWEST mtime of the whole tree (a just-re-drafted parent), and the other
    /// mtimes are deliberately anti-ordered — any mtime leakage into the distinct-id comparator
    /// reshuffles the order and goes RED. The nn_path/nn fields are asserted per row (nn = FIRST
    /// segment, legacy). FALSIFY: re-add `.then_with(mtime)` BEFORE the segment comparison (or
    /// compare only the first segment) → RED.
    #[test]
    fn arrange_orders_dotted_per_segment() {
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub03", 7_000, Some(sub_marker("t", 3))),
            raw_row("sub02-01", 8_000, Some(dotted_sub_marker("t", &[2, 1]))),
            raw_row("sub02", 9_000, Some(sub_marker("t", 2))), // re-drafted: NEWEST mtime
            raw_row("sub02-02", 2_000, Some(dotted_sub_marker("t", &[2, 2]))),
            raw_row("sub01", 6_000, Some(sub_marker("t", 1))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02", "sub02-01", "sub02-02", "sub03"],
            "depth-first dotted order 01 < 02 < 02.01 < 02.02 < 03, regardless of mtimes"
        );
        // nn = FIRST segment (legacy); nn_path = the full canonical dotted id.
        let s = by_stem(&out, "sub02-01");
        assert_eq!(s.nn, Some(2), "nn stays the FIRST segment for a dotted sub");
        assert_eq!(s.nn_path.as_deref(), Some("02.01"));
        assert_eq!(by_stem(&out, "sub02").nn_path.as_deref(), Some("02"));
        assert_eq!(by_stem(&out, "sub03").nn, Some(3));
        // The two-level grouping is kept: every sub (dotted included) is under the ONE master.
        assert_eq!(by_stem(&out, "master").child_count, Some(5));
    }

    /// ORPHAN RULE (kept simple at this layer): a dotted sub whose parent prefix row is ABSENT
    /// (here 02.01 with no `02` row) still orders by its segments among its siblings — it is NOT
    /// demoted, NOT re-ordered, NOT dropped. Visual orphan handling (rendering the gap loudly) is
    /// the frontend's job, driven by nn_path prefixes. Falsifiable: an implementation
    /// that drops or demotes prefix-orphans loses the row / nulls its tree_id → RED.
    #[test]
    fn arrange_orphan_dotted_child_orders_by_segments_without_parent_row() {
        let rows = vec![
            raw_row("master", 1_000, Some(master_marker("t"))),
            raw_row("sub02-01", 9_000, Some(dotted_sub_marker("t", &[2, 1]))), // no "02" row exists
            raw_row("sub01", 2_000, Some(sub_marker("t", 1))),
            raw_row("sub03", 3_000, Some(sub_marker("t", 3))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "sub01", "sub02-01", "sub03"],
            "the prefix-orphan 02.01 still slots between 01 and 03 by segment order"
        );
        let orphan = by_stem(&out, "sub02-01");
        assert_eq!(orphan.flavor, Flavor::Sub, "a prefix-orphan stays a sub (master exists)");
        assert_eq!(orphan.nn_path.as_deref(), Some("02.01"));
    }

    /// DUPLICATE-ID COLLISION determinism: two subs sharing the IDENTICAL dotted id fall back to
    /// the (mtime, stem) tie-breaks — the ONLY place mtime participates in child ordering. No
    /// rows dropped or duplicated. Falsifiable: remove the tie-breaks and the relative order of
    /// the colliding pair becomes sort-implementation-defined → flaky RED.
    #[test]
    fn arrange_duplicate_dotted_id_collision_is_deterministic() {
        let rows = vec![
            raw_row("master", 5_000, Some(master_marker("t"))),
            raw_row("dup-b", 3_000, Some(dotted_sub_marker("t", &[2, 1]))),
            raw_row("dup-a", 2_000, Some(dotted_sub_marker("t", &[2, 1]))),
            raw_row("sub02-02", 1_000, Some(dotted_sub_marker("t", &[2, 2]))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "dup-a", "dup-b", "sub02-02"],
            "identical ids tie-break by mtime asc then stem; distinct ids stay segment-ordered"
        );
        assert_eq!(out.len(), 4, "all rows present, none dropped or duplicated");
    }

    /// Duplicate-SUB id DIRECTION pin: subs sharing one id order
    /// oldest-mtime FIRST / newest-mtime LAST. The direction is load-bearing for the FRONTEND's
    /// last-wins rule: `renderSidebar`'s prefix-stack walk (src/main.ts) pushes a new frame per
    /// sub row, so when duplicates of "02" arrive, later extension rows ("02.01", …) attach to
    /// the LAST-emitted duplicate — i.e. the NEWEST draft wins the children, and the stale
    /// duplicate renders as a plain leaf. Flipping this comparator to newest-first would silently
    /// hand every re-drafted node's children to the STALE row. Falsifiable: reverse the mtime
    /// tie-break in `order_children` → the expected order inverts → RED.
    #[test]
    fn arrange_duplicate_sub_ids_order_oldest_first_newest_last() {
        let rows = vec![
            raw_row("master", 9_000, Some(master_marker("t"))),
            // Three duplicates of id 02, deliberately supplied newest-first to prove the output
            // order comes from the comparator, not the input order.
            raw_row("dup-newest", 8_000, Some(sub_marker("t", 2))),
            raw_row("dup-middle", 5_000, Some(sub_marker("t", 2))),
            raw_row("dup-oldest", 1_000, Some(sub_marker("t", 2))),
            // An extension of 02: in the frontend it nests under the duplicate emitted LAST.
            raw_row("sub02-01", 2_000, Some(dotted_sub_marker("t", &[2, 1]))),
        ];
        let out = arrange_plans(rows, &HashMap::new());
        let order: Vec<&str> = out.iter().map(|r| r.filename_stem.as_str()).collect();
        assert_eq!(
            order,
            vec!["master", "dup-oldest", "dup-middle", "dup-newest", "sub02-01"],
            "identical sub ids must order oldest-first/newest-LAST (frontend last-wins parenting)"
        );
    }

}
