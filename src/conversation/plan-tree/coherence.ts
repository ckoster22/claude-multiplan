// Multiplan plan-tree package — LEAF: gen-2 coherence invariants.
//
// The runtime coherence checker (assertCoherent2) and its private passes — enforcing what the types
// CANNOT express (no-executing-under-reviewing, the per-level summarized*/active?/pending* partition,
// parent-phase↔children coupling, root-only phases, sibling-nn uniqueness). PURE; depends only on
// `ids` and `model`.

import { pathKey } from "./ids";
import type { Nn, NodePath } from "./ids";
import type { TreeNode } from "./model";

// A child's coarse status for the per-level partition. "summarized" = completed (leaf or split);
// "pending" = not started (open/pending); everything else is "active" (in flight).
type ChildStatus = "summarized" | "active" | "pending";

function statusOf(node: TreeNode): ChildStatus {
  if (node.state.stage === "open") {
    return node.state.phase === "pending" ? "pending" : "active";
  }
  return node.state.phase === "summarized" ? "summarized" : "active";
}

// Throw on any incoherent gen-2 tree. Enforces, for what the types CANNOT express:
//   (1) no leaf may be `executing` anywhere under a `reviewing` ancestor (the review turn is
//       no-tools — concurrent execution below it would race the review) — checked in a dedicated
//       first pass so its violation is reported as ITSELF, not masked by a partition error;
//   (2) per-level partition: each split's children read summarized* active? pending* left-to-right
//       (left siblings completed, AT MOST one in flight, right siblings untouched);
//   (3) parent split phase ↔ children: `running-children` iff EXACTLY one child active — EXCEPT
//       the PHASE-4 roll-up window: a NON-ROOT split may rest running-children with ZERO active
//       and ALL children summarized (awaiting its roll-up summary turn; the root may not — it
//       writes no roll-up);
//       `reviewing` only BETWEEN children (no child active, ≥1 summarized behind, ≥1 pending
//       ahead — never before the first or after the last child); `summarized` only when ALL
//       children are summarized (a parent may not complete with an incomplete child);
//   (4) root-only phases at depth 0: `clarifying-intent` and `prototype-review` are illegal below
//       the root. (`done` needs no rule — it is not a representable NodeState phase; see
//       treeIsDone.)
export function assertCoherent2(root: TreeNode): void {
  assertNoExecutingUnderReviewing(root, false);
  assertStructure(root, []);
}

// Pass 1 — rule (1): scan the whole tree carrying an "ancestor is reviewing" flag.
function assertNoExecutingUnderReviewing(node: TreeNode, underReviewing: boolean): void {
  if (underReviewing && node.state.stage === "leaf" && node.state.phase === "executing") {
    throw new Error("incoherent: a leaf is executing under a reviewing ancestor");
  }
  if (node.state.stage === "split") {
    const flag = underReviewing || node.state.phase === "reviewing";
    for (const child of node.state.children) assertNoExecutingUnderReviewing(child, flag);
  }
}

// Pass 2 — rules (2)(3)(4): recursive structural walk (path threaded for loud error messages).
function assertStructure(node: TreeNode, path: NodePath): void {
  const at = path.length === 0 ? "root" : `"${pathKey(path)}"`;

  // (4) root-only phases at depth 0 (clarifying-intent AND its prototype-review gate window).
  if (
    path.length > 0 &&
    node.state.stage === "open" &&
    (node.state.phase === "clarifying-intent" || node.state.phase === "prototype-review")
  ) {
    throw new Error(`incoherent: non-root node ${at} is ${node.state.phase} (root-only phase)`);
  }

  if (node.state.stage !== "split") return;
  const children = node.state.children;

  // (0) SIBLING-nn UNIQUENESS: a "types-cannot-express" invariant — the NonEmptyArray type proves
  // children is non-empty but cannot prove the nn segments are distinct, and the navigation
  // primitives resolve nn to the FIRST match, so a duplicate-nn pair silently aliases. The
  // CHILDREN_PARSED parse boundary already rejects this for live drafts; this is defense in depth
  // for any tree (resume rehydration, hand-built fixtures) that reaches rest with a collision.
  const seenNn = new Set<Nn>();
  for (const c of children) {
    if (seenNn.has(c.nn)) {
      throw new Error(`incoherent: ${at} has duplicate sub-plan nn "${pathKey([c.nn])}" among its children`);
    }
    seenNn.add(c.nn);
  }

  const statuses = children.map(statusOf);

  // (2) per-level partition: summarized* active? pending*. Walk left-to-right through the three
  // zones; any status that steps BACKWARD (or a second active) is incoherent.
  let zone: ChildStatus = "summarized";
  for (let i = 0; i < children.length; i++) {
    const st = statuses[i];
    const childAt = `"${pathKey([...path, children[i].nn])}"`;
    if (st === "summarized") {
      if (zone !== "summarized") {
        throw new Error(`incoherent: summarized child ${childAt} right of a non-summarized sibling`);
      }
    } else if (st === "active") {
      if (zone === "active") {
        throw new Error(`incoherent: second active child ${childAt} (at most one active sibling)`);
      }
      if (zone === "pending") {
        throw new Error(`incoherent: active child ${childAt} right of a pending sibling`);
      }
      zone = "active";
    } else {
      zone = "pending";
    }
  }

  // (3) parent phase ↔ children.
  const activeCount = statuses.filter((s) => s === "active").length;
  const summarizedCount = statuses.filter((s) => s === "summarized").length;
  const pendingCount = statuses.filter((s) => s === "pending").length;
  if (node.state.phase === "running-children" && activeCount !== 1) {
    // PHASE-4 ROLL-UP WINDOW allowance: a NON-ROOT split legally rests running-children with all
    // children summarized while its roll-up summary turn is in flight.
    // PHASE-5 ACCEPTANCE WINDOW allowance: the ROOT — previously excluded (a root resting here was a
    // missed completion) — now ALSO legally rests running-children with all children summarized: the
    // forced-acceptance hold (running-children, not summarized, so treeIsDone stays false) while the
    // user records a verdict against the frozen baseline. The shape is structurally identical to the
    // non-root roll-up window; whether THIS root is legitimately parked (a baseline exists, the gate
    // is held) or stuck is a transient-state concern (pendingAcceptance + the reducer's discipline),
    // not a tree-structure one — exactly as the roll-up window's legitimacy lives in the driver's
    // event stream, not in the tree. So the all-summarized allowance now covers the root too.
    const allSummarizedWindow = activeCount === 0 && summarizedCount === children.length;
    if (!allSummarizedWindow) {
      throw new Error(
        `incoherent: ${at} is running-children with ${activeCount} active children (exactly 1 required)`,
      );
    }
  }
  if (node.state.phase === "reviewing") {
    if (activeCount !== 0) {
      throw new Error(`incoherent: ${at} is reviewing while a child is active`);
    }
    if (summarizedCount === 0 || pendingCount === 0) {
      throw new Error(
        `incoherent: ${at} is reviewing outside the between-children window (needs >=1 summarized and >=1 pending child)`,
      );
    }
  }
  if (node.state.phase === "summarized" && summarizedCount !== children.length) {
    throw new Error(`incoherent: ${at} is summarized with an incomplete child`);
  }

  for (const child of children) assertStructure(child, [...path, child.nn]);
}
