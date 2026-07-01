// Multiplan plan-tree package — LEAF: pure projections + derived selectors.
//
// toLedger2 / toSnapshot2 (deep-copied projections), treeIsDone (derived completion), writePolicyFor2
// (derived write policy), summaryName2 / planName2 (on-disk filenames), and activePhaseLabel (the
// friendly banner label). PURE; depends on `ids`, `model`, and `nav`.

import { pathKey } from "./ids";
import type { NodePath } from "./ids";
import type { TreeNode, WritePolicy, PlanTreeState2, RecursiveLedger, PlanTreeSnapshot2 } from "./model";
import { cloneNode, activePathOf, someNodeExecuting, nodeAtPath, inAcceptanceWindow } from "./nav";

// Derive the schema-2 serializable ledger (deep-copied; excludes any future transient gates) —
// what the driver will persist to state.json.
export function toLedger2(state: PlanTreeState2): RecursiveLedger {
  return {
    schema: 2,
    tree_id: state.tree_id,
    created_ms: state.created_ms,
    updated_ms: state.updated_ms,
    root: cloneNode(state.root),
    sdk_session_id: state.sdk_session_id,
    // Carry the frozen working-reference record through persistence (deep-copied so the ledger
    // never aliases live state). Absent ⇒ omitted (sketch — today's behavior unchanged).
    baseline_: state.baseline_ ? { ...state.baseline_ } : undefined,
    // Carry the acceptance verdict (incl. the divergence reason) through persistence so a
    // resumed ledger keeps the audit trail. Deep-copied; absent ⇒ omitted (the no-baseline path never
    // sets it — byte-identical to today).
    acceptance_: state.acceptance_ ? { ...state.acceptance_ } : undefined,
    // Carry the quota auto-resume budget through persistence (deep-copied so the ledger never aliases
    // live state). Absent ⇒ omitted (no budget was set — byte-identical to today's no-quota behavior).
    auto_resume_: state.auto_resume_ ? { ...state.auto_resume_ } : undefined,
  };
}

// Derive the gen-2 read-only snapshot (ledger tree + derived fields + transient gates).
export function toSnapshot2(state: PlanTreeState2): PlanTreeSnapshot2 {
  return {
    treeId: state.tree_id,
    root: cloneNode(state.root),
    activePath: activePathOf(state.root),
    writePolicy: writePolicyFor2(state.root),
    done: treeIsDone(state.root),
    pendingApproval: state.pendingApproval,
    pendingClarify: state.pendingClarify,
    pendingPrototype: state.pendingPrototype,
    pendingAcceptance: state.pendingAcceptance,
  };
}

// Run completion is DERIVED, never stored: the tree is done iff the ROOT has summarized (leaf or
// split). "done" is deliberately NOT a NodeState phase — a non-root "done" is unrepresentable.
// the forced acceptance gate keeps `treeIsDone` FALSE while it is open: the root rests in
// its `running-children` acceptance window (NOT `summarized`) until ACCEPTANCE_APPROVED/DIVERGED
// finalizes it, so a baseline-bearing tree can never read done without a recorded verdict.
export function treeIsDone(root: TreeNode): boolean {
  return root.state.stage !== "open" && root.state.phase === "summarized";
}

//   - the ROOT in its intent-clarification window (open clarifying-intent OR prototype-review) →
//     "prototype": throwaway visual-prototype artifacts may be written, but no plan exists yet.
//     GENESIS therefore derives "prototype"; recon onward falls through to the existential below.
//   - otherwise writable ("acceptEdits") iff SOME node anywhere is a leaf in `executing` — at ANY
//     depth — else "plan". Defined INDEPENDENTLY of activePathOf so the policy holds even if dispatch
//     derivation drifted. The type system guarantees the witness is a LEAF (`executing` is not a
//     split phase).
// INVARIANT[write-policy-is-derived-not-stored] (convention): write policy is one of plan|acceptEdits|prototype, computed purely from the tree by this projection and never persisted as a mutable ledger flag (RunState.assertedPolicy is only a re-derivable cache).
//   prevents: a write policy disagreeing with the tree's actual phase
export function writePolicyFor2(root: TreeNode): WritePolicy {
  if (
    root.state.stage === "open" &&
    (root.state.phase === "clarifying-intent" || root.state.phase === "prototype-review")
  ) {
    return "prototype";
  }
  return someNodeExecuting(root) ? "acceptEdits" : "plan";
}

// The on-disk summary filename for a node: the dotted pathKey + "-summary.md". A single segment
// degenerates to the legacy flat shape ("01-summary.md" — byte-identical to gen-1 summaryName), so
// depth-1 filenames are unchanged on disk. The ROOT writes no roll-up summary (run
// completion is DERIVED — see treeIsDone), so the empty path throws loudly.
export function summaryName2(path: NodePath): string {
  if (path.length === 0) {
    throw new Error("summaryName2: the root writes no summary file (completion is derived, not summarized)");
  }
  return `${pathKey(path)}-summary.md`;
}

// The on-disk DECOMPOSITION-plan filename for a split node: the root keeps its legacy
// "master.md" (root-only artifact special case); a non-root split writes the dotted
// `<pathKey>-plan.md` (summaryName2-style naming) — e.g. "02-plan.md", "02.01-plan.md".
export function planName2(path: NodePath): string {
  if (path.length === 0) return "master.md";
  return `${pathKey(path)}-plan.md`;
}

// Friendly banner label for the ACTIVE node's phase (used for BOTH resumable and blocked verdicts).
// A small pure switch over the active node's stage×phase; a done/empty tree reads "Complete".
export function activePhaseLabel(root: TreeNode): string {
  const activePath = activePathOf(root);
  if (activePath === null) {
    return treeIsDone(root) ? "Complete" : "Idle";
  }
  const node = nodeAtPath(root, activePath);
  if (!node) return "Idle"; // unreachable
  const state = node.state;
  switch (state.stage) {
    case "open":
      switch (state.phase) {
        case "clarifying-intent":
          return "Clarifying intent";
        case "prototype-review":
          return "Reviewing prototype";
        case "pending":
          return "Pending";
        case "recon":
          return "Reconnaissance";
        case "sizing":
          return "Sizing";
        case "decomposing":
          return "Decomposing";
        case "awaiting-decomposition-approval":
          return "Awaiting decomposition approval";
      }
      return "Working";
    case "leaf":
      switch (state.phase) {
        case "drafting":
          return "Drafting the plan";
        case "awaiting-approval":
          return "Awaiting your approval of the plan";
        case "executing":
          return "Executing";
        case "summarized":
          return "Complete";
      }
      return "Working";
    case "split":
      switch (state.phase) {
        case "running-children":
          // the ROOT resting running-children with all children summarized is the
          // forced-acceptance hold (the run is built; the user must record a verdict); every other
          // running-children resting node is a roll-up window.
          return activePath.length === 0 && inAcceptanceWindow(node)
            ? "Awaiting baseline acceptance"
            : "Rolling up";
        case "reviewing":
          return "Reviewing before the next sub-plan";
        case "summarized":
          return "Complete";
      }
      return "Working";
  }
}
