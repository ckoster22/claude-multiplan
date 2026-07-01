// Multiplan plan-tree package — LEAF: gen-2 tree navigation + shared tree helpers.
//
// Path resolution (nodeAtPath), active-node derivation (activePathOf), the window predicates
// (inRollupWindow / inAcceptanceWindow), the root-collapse-child predicate, and the genuinely
// cross-leaf private tree helpers that have their SINGLE home here: `cloneNode` (imported by select
// + reduce), `replaceAt` (imported by reduce), and `someNodeExecuting` (imported by select). PURE;
// depends only on `ids` and `model`.

import { pathKey, nonEmpty } from "./ids";
import type { NodePath } from "./ids";
import type { TreeNode, NodeState } from "./model";

// Deep-clone a node recursively so projections never alias the live state's tree.
export function cloneNode(node: TreeNode): TreeNode {
  const state: NodeState =
    node.state.stage === "split"
      ? { ...node.state, children: nonEmpty(node.state.children.map(cloneNode)) }
      : { ...node.state };
  return { ...node, state };
}

// Resolve the node at `path` under `root` (root itself for []). Returns null when the path walks
// off the tree — a missing child segment, or a segment under a non-split node (only split states
// HAVE children, so descent through open/leaf is structurally impossible).
export function nodeAtPath(root: TreeNode, path: NodePath): TreeNode | null {
  let cur: TreeNode = root;
  for (const seg of path) {
    if (cur.state.stage !== "split") return null;
    const child = cur.state.children.find((c) => c.nn === seg);
    if (!child) return null;
    cur = child;
  }
  return cur;
}

// The path of the ONE active node (the node the sequencer dispatches on), or null when nothing is in
// flight (a fresh pending or done tree). PRECISE DEFINITION (depth-first):
//   - open/pending → not active; any OTHER open phase → the node itself is active.
//   - leaf → active unless summarized.
//   - split summarized → nothing active below a completed subtree.
//   - split REVIEWING → the reviewing PARENT is the active node (the review turn is the parent's;
//     coherence guarantees no child is active during it).
//   - split running-children → the single active DESCENDANT (the parent is bookkeeping); zero active
//     children under running-children is incoherent and throws LOUDLY.
// Serves sequencer dispatch ONLY — writePolicyFor2 is deliberately independent of this.
export function activePathOf(root: TreeNode): NodePath | null {
  return activeWithin(root, []);
}

function activeWithin(node: TreeNode, prefix: NodePath): NodePath | null {
  switch (node.state.stage) {
    case "open":
      return node.state.phase === "pending" ? null : prefix;
    case "leaf":
      return node.state.phase === "summarized" ? null : prefix;
    case "split": {
      if (node.state.phase === "summarized") return null;
      if (node.state.phase === "reviewing") return prefix;
      // running-children: descend depth-first to the single active descendant.
      for (const child of node.state.children) {
        const found = activeWithin(child, [...prefix, child.nn]);
        if (found !== null) return found;
      }
      // ROLL-UP WINDOW: a NON-ROOT split whose children are ALL summarized has no active
      // descendant — the split node ITSELF is the active node (its roll-up summary turn is the one
      // in flight; SUMMARY_WRITTEN{this path} completes it).
      if (prefix.length > 0 && inRollupWindow(node)) return prefix;
      // ACCEPTANCE WINDOW: the ROOT resting running-children with ALL children summarized is
      // the forced-acceptance hold — the ROOT itself is the active node (ACCEPTANCE_APPROVED/DIVERGED
      // resolves it). Without a baseline the reducer never parks here (it finalizes in the same
      // reduction); activePathOf reads the TREE alone, so the allowance is structural like the
      // roll-up window's.
      if (prefix.length === 0 && inAcceptanceWindow(node)) return prefix;
      throw new Error(
        `incoherent: split node at "${pathKey(prefix)}" is running-children with no active child`,
      );
    }
  }
}

function someNodeExecuting(node: TreeNode): boolean {
  if (node.state.stage === "leaf") return node.state.phase === "executing";
  if (node.state.stage === "split") return node.state.children.some(someNodeExecuting);
  return false;
}

// Cross-leaf private helper: imported by select.ts (writePolicyFor2). Lives here as one of nav's
// tree-walk helpers; NOT a barrel export.
export { someNodeExecuting };

// Whether `path` addresses THE root single-collapse child: the SOLE child of a root split with NO
// decomposition plan (planPath null ⇒ the split was minted by the root confident-single collapse,
// the only arc creating a planPath-less split). That child INHERITED the root sizer's `single`
// verdict, so it skips the per-node sizer (a second sizer would size one request twice) and goes
// straight to leaf/drafting (preserving the gen-1 golden depth-1 single trace).
export function isRootCollapseChild(root: TreeNode, path: NodePath): boolean {
  return (
    path.length === 1 &&
    root.state.stage === "split" &&
    root.state.planPath === null &&
    root.state.children.length === 1
  );
}

// Whether a split sits in its ROLL-UP WINDOW: running-children with EVERY child summarized. The
// (non-root — coherence forbids it at the root) state a split rests in after its last child's
// SUMMARY_WRITTEN while the DRIVER runs the roll-up turn; the node's own SUMMARY_WRITTEN{path}
// completes it to split/summarized. Deliberately re-uses `running-children` (no new phase, schema
// untouched) and is fully DERIVED from the children — a stored flag could disagree with them.
export function inRollupWindow(node: TreeNode): boolean {
  return (
    node.state.stage === "split" &&
    node.state.phase === "running-children" &&
    node.state.children.every((c) => c.state.stage !== "open" && c.state.phase === "summarized")
  );
}

// THE FORCED ACCEPTANCE WINDOW: the ROOT resting in `running-children` with EVERY child
// summarized. STRUCTURALLY identical to a non-root roll-up window, but at the ROOT it is the
// forced-acceptance hold — the root writes no roll-up, so without a baseline the reducer finalizes
// here in the SAME reduction (root → summarized). WITH a baseline it parks here while
// pendingAcceptance is held, awaiting the ACCEPTANCE_APPROVED/DIVERGED verdict. `treeIsDone` is false
// here (running-children, not summarized), so a baseline-bearing tree never reads done without a
// verdict. assertCoherent2 accepts this shape.
export function inAcceptanceWindow(root: TreeNode): boolean {
  return (
    root.state.stage === "split" &&
    root.state.phase === "running-children" &&
    root.state.children.every((c) => c.state.stage !== "open" && c.state.phase === "summarized")
  );
}

// Return a NEW tree with the node at `path` replaced by `replace(old)` — every untouched node is
// carried by reference-copy, the spine is rebuilt immutably. Throws loudly on a path that walks
// off the tree (descent through a non-split, or a missing segment).
//
// Cross-leaf private helper: imported by reduce.ts (advanceAfterSummary + reduce2). NOT a barrel export.
export function replaceAt(node: TreeNode, path: NodePath, replace: (n: TreeNode) => TreeNode): TreeNode {
  if (path.length === 0) return replace(node);
  if (node.state.stage !== "split") {
    throw new Error(`replaceAt: cannot descend "${pathKey(path)}" under a ${node.state.stage} node`);
  }
  const seg = path[0];
  if (!node.state.children.some((c) => c.nn === seg)) {
    throw new Error(`replaceAt: no child ${seg} at "${pathKey(path)}"`);
  }
  const children = nonEmpty(
    node.state.children.map((c) => (c.nn === seg ? replaceAt(c, path.slice(1), replace) : c)),
  );
  return { ...node, state: { ...node.state, children } };
}
