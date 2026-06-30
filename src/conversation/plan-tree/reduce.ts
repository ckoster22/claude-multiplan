// Multiplan plan-tree package — LEAF: the PURE gen-2 reducer (the high-level orchestrator leaf).
//
// The PURE reducer over the discriminated event union plus its private helpers (makeNode2, initial2,
// clone2, requireActive2, advanceAfterSummary). The reducer DECIDES side effects (returns Effect2[]);
// the driver EXECUTES them. NO invoke, NO listen, NO Tauri, NO DOM. This is the highest leaf — it
// delegates to every other leaf (ids/model/events/nav/coherence/select).

import { parseNn, nonEmpty, pathKey, PlanValidationError } from "./ids";
import type { Nn, NodePath } from "./ids";
import type { TreeNode, PlanTreeState2, ApprovalGate2, AcceptanceGate } from "./model";
import type { PlanTreeEvent2, Effect2 } from "./events";
import {
  cloneNode,
  replaceAt,
  nodeAtPath,
  isRootCollapseChild,
  inRollupWindow,
  inAcceptanceWindow,
  activePathOf,
} from "./nav";
import { assertCoherent2 } from "./coherence";
import { planName2, summaryName2 } from "./select";

// ---- gen-2 reducer helpers ----------------------------------------------------------------------

// A freshly-minted pending child (the gen-2 makeSub: artifact-free by CONSTRUCTION — the open
// stage has no path fields, so "no artifacts yet" is structural, not null-at-rest).
function makeNode2(nn: Nn, title: string): TreeNode {
  return { nn, title, redraftCount: 0, lastFeedback: null, state: { stage: "open", phase: "pending" } };
}

// Construct the fresh initial gen-2 state for a brand-new tree. The root's nn is conventional
// (parseNn(1), never read — paths derive from CHILD segments only); its title records the request.
function initial2(treeId: string, request: string, nowMs: number): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: treeId,
    created_ms: nowMs,
    updated_ms: nowMs,
    root: {
      nn: parseNn(1),
      title: request,
      redraftCount: 0,
      lastFeedback: null,
      // GENESIS: the run opens with the intent-clarifier (root-only phase), exactly as in gen 1.
      state: { stage: "open", phase: "clarifying-intent" },
    },
    // No SDK session yet — captured on the first system_init frame (SESSION_INITIALIZED).
    sdk_session_id: undefined,
    // No working reference yet — set iff the user picks "working reference" at the prototype gate.
    baseline_: undefined,
    // No acceptance verdict yet — set only when the forced acceptance gate resolves.
    acceptance_: undefined,
    // No quota auto-resume budget yet — set by QUOTA_BUDGET_SET (dispatched at START from the
    // composer's quota-resume choice). Absent ⇒ the fail-closed reducer default (remaining 0).
    auto_resume_: undefined,
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    pendingAcceptance: null,
    parsedChildren: null,
  };
}

// Clone gen-2 state immutably (deep tree copy) so the reducer never mutates its input.
function clone2(state: PlanTreeState2): PlanTreeState2 {
  return {
    schema: 2,
    tree_id: state.tree_id,
    created_ms: state.created_ms,
    updated_ms: state.updated_ms,
    root: cloneNode(state.root),
    sdk_session_id: state.sdk_session_id,
    baseline_: state.baseline_ ? { ...state.baseline_ } : undefined,
    acceptance_: state.acceptance_ ? { ...state.acceptance_ } : undefined,
    auto_resume_: state.auto_resume_ ? { ...state.auto_resume_ } : undefined,
    pendingApproval: state.pendingApproval,
    pendingClarify: state.pendingClarify,
    pendingPrototype: state.pendingPrototype,
    pendingAcceptance: state.pendingAcceptance,
    parsedChildren: state.parsedChildren,
  };
}

// The gen-2 requirePointer: assert the event addresses THE active node, returning it. Every
// node-targeted event must address the currently-active node (depth-first uniqueness is the
// coherence invariant), exactly as gen-1 events had to address the pointed-at sub-plan.
function requireActive2(root: TreeNode, path: NodePath, what: string): TreeNode {
  const active = activePathOf(root);
  if (active === null || pathKey(active) !== pathKey(path)) {
    throw new Error(
      `${what} targets "${pathKey(path)}" but the active node is ${active === null ? "none" : `"${pathKey(active)}"`}`,
    );
  }
  const node = nodeAtPath(root, path);
  if (!node) throw new Error(`${what}: no node at "${pathKey(path)}"`); // unreachable post-active check
  return node;
}

// PHASE 4 — ONE COMPLETION-ASCENT HOP. After the node at `path` (a leaf or a rolled-up split) was
// marked summarized, mutate `next`/append `effects` for the single step the tree takes next:
//   - a NEXT PENDING SIBLING exists → it activates (open/pending → open/recon);
//   - LAST child of the ROOT → the root completes (split → summarized; treeIsDone) + notifyDone
//     (the root writes no roll-up — root-only special case, gen-1 golden behavior);
//   - LAST child of a NON-ROOT split → NO tree mutation: the parent now RESTS in its roll-up
//     window (running-children + all children summarized — the assertCoherent2 allowance). The
//     DRIVER detects the window (inRollupWindow at the new active path), runs the roll-up summary
//     turn, and dispatches SUMMARY_WRITTEN{parentPath} — which re-enters this fn one level up,
//     continuing the ascent (next sibling of the parent / grandparent roll-up / root done).
function advanceAfterSummary(next: PlanTreeState2, path: NodePath, effects: Effect2[]): void {
  if (path.length === 0) {
    throw new Error("advanceAfterSummary: the root has no parent to ascend to (unreachable)");
  }
  const parentPath = path.slice(0, -1);
  const parent = nodeAtPath(next.root, parentPath);
  if (!parent || parent.state.stage !== "split") {
    throw new Error(`incoherent: summarized node "${pathKey(path)}" has no split parent`);
  }
  const siblings = parent.state.children;
  const idx = siblings.findIndex((c) => c.nn === path[path.length - 1]);
  const sibling = idx + 1 < siblings.length ? siblings[idx + 1] : null;
  if (sibling) {
    // PHASE 5 — THE PARENT-REVIEW TURN: a child summarized with right-siblings remaining, so the
    // PARENT (root included) enters `reviewing` and the next sibling STAYS pending. The driver runs
    // the no-tools review turn (child summary + remaining FROZEN mandates → ADJUST/NONE) and
    // dispatches PARENT_REVIEW_DONE, which is the ONLY arc that activates the next sibling's recon.
    // Review happens only BETWEEN siblings: the last child takes the root-completion / roll-up
    // branches below and never enters reviewing.
    if (sibling.state.stage !== "open" || sibling.state.phase !== "pending") {
      throw new Error(
        `incoherent: next sibling "${pathKey([...parentPath, sibling.nn])}" is ${sibling.state.stage}/${sibling.state.phase}, expected open/pending`,
      );
    }
    next.root = replaceAt(next.root, parentPath, (n) => {
      if (n.state.stage !== "split") {
        throw new Error("unreachable: parent-review target re-checked non-split");
      }
      return { ...n, state: { ...n.state, phase: "reviewing" } };
    });
    return;
  }
  if (parentPath.length === 0) {
    // LAST CHILD OF THE ROOT → ROOT COMPLETION (no roll-up; done is DERIVED — see treeIsDone).
    if (next.root.state.stage !== "split") {
      throw new Error("incoherent: completion ascent reached a non-split root");
    }
    // PHASE 5 — THE FORCED ACCEPTANCE GATE: a tree that froze a working-reference baseline CANNOT
    // finalize without a recorded acceptance verdict. When `next.baseline_` is present AND no verdict
    // has been recorded yet (acceptance_ undefined — defensive against a double-finalize), instead of
    // completing the root we PARK it in its acceptance window (running-children, all children
    // summarized — coherent; treeIsDone stays false) and open the transient pendingAcceptance gate.
    // The DRIVER (notifyAcceptanceReview) opens the baseline + surfaces Approve/Diverge; the original
    // finalize (root → summarized + notifyDone) is performed by ACCEPTANCE_APPROVED/DIVERGED. With NO
    // baseline this branch is byte/effect-identical to before (immediate finalize + notifyDone).
    if (next.baseline_ && !next.acceptance_) {
      // The root STAYS running-children (the acceptance window — see inAcceptanceWindow). No tree
      // mutation; the gate is the transient hold. The gate's display fields the reducer cannot know
      // (cwd/openTarget/runCommand — driver concerns) are blank; the driver augments them when it
      // surfaces the gate. round is 1 (single-round acceptance today).
      const gate: AcceptanceGate = { cwd: "", openTarget: null, runCommand: null, round: 1 };
      next.pendingAcceptance = gate;
      effects.push({ kind: "notifyAcceptanceReview", gate });
      return;
    }
    next.root = { ...next.root, state: { ...next.root.state, phase: "summarized" } };
    effects.push({ kind: "notifyDone" });
    return;
  }
  // LAST CHILD OF A NON-ROOT SPLIT → the parent's ROLL-UP WINDOW (deliberate no-op: the resting
  // state IS the window; the driver's roll-up turn completes it via SUMMARY_WRITTEN{parentPath}).
}

// ---- the gen-2 pure reducer ----------------------------------------------------------------------

// The PURE gen-2 reducer. Returns a NEW state plus the effects the driver must execute. Never
// mutates the input; assertCoherent2 runs at the end of EVERY arc so any illegal transition throws.
// Effect kinds/ordering mirror the gen-1 reducer one-for-one at depth 1 (see the Effect2 notes for
// the two documented driver-write-boundary deltas), so the driver cutover preserves the golden
// depth-1 trace.
export function reduce2(
  state: PlanTreeState2,
  event: PlanTreeEvent2,
): { state: PlanTreeState2; effects: Effect2[] } {
  const next = clone2(state);
  const effects: Effect2[] = [];

  switch (event.type) {
    case "START": {
      // Bootstrap a fresh tree (ignores prior state — START is the genesis event). The on-disk
      // .plan-tree/ is reset FIRST, THEN the genesis ledger is persisted into it (gen-1 order).
      const fresh = initial2(event.treeId, event.request, event.nowMs);
      effects.push({ kind: "resetPlanTreeDir" }, { kind: "persist" });
      assertCoherent2(fresh.root);
      return { state: fresh, effects };
    }

    case "INTENT_CLARIFIED": {
      // ROOT-ONLY GENESIS ARC: clarifying-intent → recon, writing INTENT.md (the one artifact
      // whose text still rides the event — the reducer write mirrors gen 1 byte-for-byte).
      // Stricter than gen 1: a stray INTENT_CLARIFIED mid-run throws instead of rewinding.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "clarifying-intent") {
        throw new Error(
          `INTENT_CLARIFIED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/clarifying-intent`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "recon" } };
      effects.push(
        { kind: "writePlanTreeFile", name: "INTENT.md", contents: event.intent },
        { kind: "persist" },
      );
      break;
    }

    case "PROTOTYPE_READY": {
      // ROOT-ONLY GATE-OPEN ARC: clarifying-intent → prototype-review, holding the gate
      // transiently (pendingPrototype — never serialized). Legal ONLY from the genesis window:
      // a prototype arriving mid-run (recon onward, or a non-root active node) throws.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "clarifying-intent") {
        throw new Error(
          `PROTOTYPE_READY illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/clarifying-intent`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "prototype-review" } };
      next.pendingPrototype = event.gate;
      effects.push({ kind: "notifyPrototypeReview", gate: event.gate }, { kind: "persist" });
      break;
    }

    case "PROTOTYPE_APPROVED": {
      // ROOT-ONLY GATE-RESOLVE ARC: prototype-review → recon, writing INTENT.md (mirrors
      // INTENT_CLARIFIED's shape — the prototype path and the no-prototype fallback converge on
      // the identical recon entry). Clears the held gate.
      if (next.root.state.stage !== "open" || next.root.state.phase !== "prototype-review") {
        throw new Error(
          `PROTOTYPE_APPROVED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/prototype-review`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "recon" } };
      next.pendingPrototype = null;
      // WORKING-REFERENCE classification (Phase 3): on `asWorkingReference`, record the frozen
      // baseline (the DRIVER already copied .plan-tree/prototype/ → .plan-tree/baseline/ before
      // dispatching). The default (false — "just a sketch") leaves baseline_ untouched, so the
      // recon entry is byte-identical to today's no-working-reference behavior.
      if (event.asWorkingReference) {
        next.baseline_ = { frozen: true, frozen_ms: event.frozenMs };
      }
      effects.push(
        { kind: "writePlanTreeFile", name: "INTENT.md", contents: event.intentContents },
        { kind: "persist" },
      );
      break;
    }

    case "PROTOTYPE_REFINED": {
      // ROOT-ONLY GATE-LOOP ARC: prototype-review → BACK to clarifying-intent for another
      // prototype round. The feedback rides the event for the DRIVER's next prompt only — the
      // reducer never stores it. Clears the held gate (the next round mints a fresh one).
      if (next.root.state.stage !== "open" || next.root.state.phase !== "prototype-review") {
        throw new Error(
          `PROTOTYPE_REFINED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, expected open/prototype-review`,
        );
      }
      next.root = { ...next.root, state: { stage: "open", phase: "clarifying-intent" } };
      next.pendingPrototype = null;
      effects.push({ kind: "persist" });
      break;
    }

    case "NODE_RECON_DONE": {
      const node = requireActive2(next.root, event.path, "NODE_RECON_DONE");
      if (node.state.stage !== "open" || node.state.phase !== "recon") {
        throw new Error(
          `NODE_RECON_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/recon`,
        );
      }
      if (isRootCollapseChild(next.root, event.path)) {
        // ROOT-COLLAPSE CHILD (root-only special case, PHASE 4): the sole child of the root
        // single-collapse inherited the ROOT sizer's `single` verdict, so it skips the per-node
        // sizer — recon → leaf/drafting directly (the open→leaf node replacement), preserving the
        // gen-1 golden depth-1 single trace byte-for-byte.
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "leaf", phase: "drafting", planPath: null, summaryPath: null, plansDirPath: null },
        }));
      } else {
        // PHASE 4 — EVERY OTHER NODE (root AND non-root alike): recon → sizing (the per-node
        // sizer turn follows; the SIZER_DONE verdict decides leaf vs split). recon.md is
        // DRIVER-written at the root (cutover seam on PlanTreeEvent2 — the event carries no text).
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "open", phase: "sizing" },
        }));
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "SIZER_DONE": {
      const node = requireActive2(next.root, event.path, "SIZER_DONE");
      if (node.state.stage !== "open" || node.state.phase !== "sizing") {
        throw new Error(
          `SIZER_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/sizing`,
        );
      }
      // TWO-OUTCOME SIZER, gen-1 thresholds preserved AT EVERY DEPTH: a CONFIDENT single makes the
      // node a leaf; a split OR a low-confidence single (< 0.6, per the sizer skill's rule)
      // decomposes. (The outcome itself is not stored: schema 2 has no sizer field — the verdict
      // is fully encoded in the arc.)
      if (event.outcome.decision === "single" && event.outcome.confidence >= 0.6) {
        if (event.path.length === 0) {
          // ROOT SINGLE-COLLAPSE (root-only special case, preserving gen-1 golden behavior): the
          // decomposition gate is COLLAPSED — the root becomes a split with EXACTLY ONE child 01
          // ("Plan"), materialized immediately (no CHILDREN_PARSED, no gate), child active in recon.
          // The child's OWN leaf gate is the only plan gate in the whole run.
          const only: TreeNode = { ...makeNode2(parseNn(1), "Plan"), state: { stage: "open", phase: "recon" } };
          next.root = {
            ...next.root,
            state: {
              stage: "split",
              phase: "running-children",
              children: nonEmpty([only]),
              planPath: null,
              summaryPath: null,
              plansDirPath: null,
            },
          };
        } else {
          // PHASE 4 — NON-ROOT SINGLE: the node ITSELF becomes the leaf (open→leaf node
          // replacement; NO collapse child is minted — the collapse exists only at the root, where
          // a gate must still follow). Its leaf gate is this node's human checkpoint.
          next.root = replaceAt(next.root, event.path, (n) => ({
            ...n,
            state: { stage: "leaf", phase: "drafting", planPath: null, summaryPath: null, plansDirPath: null },
          }));
        }
      } else {
        // SPLIT (or low-confidence single treated as one) → the decomposition draft turn, at ANY
        // depth (PHASE 4: non-root splits draft their own decompositions).
        next.root = replaceAt(next.root, event.path, (n) => ({
          ...n,
          state: { stage: "open", phase: "decomposing" },
        }));
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_DRAFTED": {
      // PHASE 4: legal at ANY depth — a non-root split drafts its own decomposition
      // (".plan-tree/<dotted>-plan.md", driver-written) and gets the same unified gate.
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_DRAFTED");
      if (node.state.stage !== "open" || node.state.phase !== "decomposing") {
        throw new Error(
          `DECOMPOSITION_DRAFTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: { stage: "open", phase: "awaiting-decomposition-approval" },
      }));
      // THE UNIFIED GATE: the root decomposition gate lives in pendingApproval like every other
      // gate (the gen-1 nn:-1 sentinel + driver-side master gate are gone). master.md and the
      // plans-dir copy are DRIVER-written before this event (cutover seam) — the event carries
      // their real paths into the gate.
      const gate: ApprovalGate2 = {
        path: event.path,
        kind: "decomposition",
        toolUseId: event.toolUseId,
        planPath: event.planPath,
        plansDirPath: event.plansDirPath,
        redraftCount: node.redraftCount,
      };
      next.pendingApproval = gate;
      effects.push({ kind: "persist" }, { kind: "notifyAwaitingApproval", gate });
      break;
    }

    case "GATE_RE_PRESENTED": {
      // INV-3 — PHASE-ONLY RE-ARM (resume). Advance ONLY the node phase open/decomposing →
      // open/awaiting-decomposition-approval so a subsequent DECOMPOSITION_APPROVED finds the phase
      // its guard requires (the resumed-gate Approve path dead-ended at FATAL otherwise). The DRIVER
      // already set pendingApproval + fired onAwaitingApproval directly on resume, so this emits NO
      // effects (no persist, no notify) — re-running DECOMPOSITION_DRAFTED here would double-present
      // the gate. Legal ONLY from open/decomposing (the resumed decomposition-gate shape).
      const node = requireActive2(next.root, event.path, "GATE_RE_PRESENTED");
      if (node.state.stage !== "open" || node.state.phase !== "decomposing") {
        throw new Error(
          `GATE_RE_PRESENTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: { stage: "open", phase: "awaiting-decomposition-approval" },
      }));
      // NO effects: the gate is already surfaced (driver-side, on resume). This is a pure phase fix.
      break;
    }

    case "CHILDREN_PARSED": {
      // PHASE 4: legal at ANY depth (children carry per-level Nn segments; full paths derive from
      // nesting at DECOMPOSITION_APPROVED).
      const node = requireActive2(next.root, event.path, "CHILDREN_PARSED");
      // Legal in the gen-1 SUBPLANS_PARSED window: while decomposing OR while the draft's gate is
      // held (the parse derives from the draft, whichever order the driver lands them in).
      if (
        node.state.stage !== "open" ||
        (node.state.phase !== "decomposing" && node.state.phase !== "awaiting-decomposition-approval")
      ) {
        throw new Error(
          `CHILDREN_PARSED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/decomposing|awaiting-decomposition-approval`,
        );
      }
      // SIBLING-nn UNIQUENESS (INV-2 recoverable): two headers parsing to the SAME nn (e.g.
      // "Sub-Plan 1" and "Sub-Plan 01") would mint duplicate-nn siblings — and every navigation
      // primitive (nodeAtPath/replaceAt/advanceAfterSummary) resolves nn to the FIRST match, so the
      // run executes one twin and later events alias back to the other, wedging mid-run. REJECT it
      // HERE with a PlanValidationError — the SAME typed class as the empty/out-of-range cases — so
      // the orchestrator's `instanceof PlanValidationError` catch denies the held ExitPlanMode for a
      // redraft (run stays active) instead of FATALing. (assertStructure carries a defense-in-depth
      // Set check for any tree that somehow reaches rest with collisions.)
      const seenNn = new Set<Nn>();
      for (const c of event.children) {
        if (seenNn.has(c.nn)) {
          throw new PlanValidationError(
            `decomposition validation failed: sub-plan nn "${pathKey([c.nn])}" appears more than once — ` +
              "sibling sub-plan numbers must be unique; redraft the decomposition with distinct `### Sub-Plan NN:` headers",
          );
        }
        seenNn.add(c.nn);
      }
      // STASHED, NOT YET IN THE TREE: minted via nonEmpty (an empty decomposition throws here),
      // all open/pending, held transiently until the gate resolves. The node deliberately STAYS
      // open: every split phase requires child activity the held-gate window cannot have
      // (assertCoherent2's exactly-one-active rule; the plan diagram enters RunKids on approve),
      // so the open→split node replacement happens at DECOMPOSITION_APPROVED, not here.
      next.parsedChildren = {
        path: event.path,
        children: nonEmpty(event.children.map((c) => makeNode2(c.nn, c.title))),
      };
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_APPROVED": {
      // PHASE 4: legal at ANY depth — the open→split node replacement happens wherever the gated
      // node lives; ANCESTORS are untouched (they stay running-children: the spine copy in
      // replaceAt preserves their state, and the newly-active first grandchild keeps each level's
      // exactly-one-active partition satisfied).
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_APPROVED");
      if (node.state.stage !== "open" || node.state.phase !== "awaiting-decomposition-approval") {
        throw new Error(
          `DECOMPOSITION_APPROVED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/awaiting-decomposition-approval`,
        );
      }
      const stash = next.parsedChildren;
      if (!stash || pathKey(stash.path) !== pathKey(event.path)) {
        // The gen-1 "MASTER_APPROVED before SUBPLANS_PARSED" guard, path-addressed.
        throw new Error("DECOMPOSITION_APPROVED before CHILDREN_PARSED — no children to run");
      }
      const gate = next.pendingApproval;
      // The instantaneous `approved` tick (gen-1 semantics preserved): the open node is REPLACED
      // by the populated split (sizer-driven arc #2), already running its first child — a resting
      // "approved-but-idle" state is unrepresentable. The decomposition plan's artifact paths move
      // from the gate onto the split node (artifacts live on leaf/split states, never open).
      const children = nonEmpty(
        stash.children.map((c, i): TreeNode => (i === 0 ? { ...c, state: { stage: "open", phase: "recon" } } : c)),
      );
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: {
          stage: "split",
          phase: "running-children",
          children,
          planPath: gate ? gate.planPath : null,
          summaryPath: null,
          plansDirPath: gate ? gate.plansDirPath : null,
        },
      }));
      next.parsedChildren = null;
      next.pendingApproval = null;
      // Gen-1 APPROVE effect shape, unified onto the decomposition gate: resolve-allow + persist.
      // (The driver-side interrupt/arm-resuming hardening stays DRIVER policy at cutover — the
      // reducer only resolves the held permission, exactly as it does for a leaf APPROVE.)
      if (gate) effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: true });
      effects.push({ kind: "persist" });
      break;
    }

    case "DECOMPOSITION_CHANGES_REQUESTED": {
      // PHASE 4: legal at ANY depth — the nested redraft happens IN PLACE exactly like the root's.
      const node = requireActive2(next.root, event.path, "DECOMPOSITION_CHANGES_REQUESTED");
      if (node.state.stage !== "open" || node.state.phase !== "awaiting-decomposition-approval") {
        throw new Error(
          `DECOMPOSITION_CHANGES_REQUESTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected open/awaiting-decomposition-approval`,
        );
      }
      const gate = next.pendingApproval;
      // STAYS DECOMPOSING-SIDE: back to open/decomposing for the same-turn redraft; redraftCount
      // accumulates on the NODE (it survives the open→split replacement later); the stale parse
      // is discarded (the redraft re-parses); the gate clears with a deny carrying the feedback.
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        redraftCount: n.redraftCount + 1,
        lastFeedback: event.feedback,
        state: { stage: "open", phase: "decomposing" },
      }));
      next.parsedChildren = null;
      next.pendingApproval = null;
      if (gate) {
        effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: false, message: event.feedback });
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "NODE_DRAFTED": {
      const node = requireActive2(next.root, event.path, "NODE_DRAFTED");
      if (node.state.stage !== "leaf" || node.state.phase !== "drafting") {
        throw new Error(
          `NODE_DRAFTED illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/drafting`,
        );
      }
      // leaf drafting → awaiting-approval, recording the DRIVER-written plan's paths (the plan
      // text never rides the event — see the driver-write boundary note on PlanTreeEvent2; the
      // gen-1 writeAgentPlan effect, which the driver already no-oped, is gone).
      next.root = replaceAt(next.root, event.path, (n) => ({
        ...n,
        state: {
          stage: "leaf",
          phase: "awaiting-approval",
          planPath: event.planPath,
          summaryPath: null,
          plansDirPath: event.plansDirPath,
        },
      }));
      const gate: ApprovalGate2 = {
        path: event.path,
        kind: "leaf",
        toolUseId: event.toolUseId,
        planPath: event.planPath,
        plansDirPath: event.plansDirPath,
        redraftCount: node.redraftCount,
      };
      next.pendingApproval = gate;
      effects.push({ kind: "persist" }, { kind: "notifyAwaitingApproval", gate });
      break;
    }

    case "APPROVE": {
      const node = requireActive2(next.root, event.path, "APPROVE");
      // Legal ONLY from leaf/awaiting-approval (the gen-1 lifecycle guard, stage-aware).
      if (node.state.stage !== "leaf" || node.state.phase !== "awaiting-approval") {
        throw new Error(
          `APPROVE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/awaiting-approval`,
        );
      }
      const gate = next.pendingApproval;
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "leaf") throw new Error("unreachable: APPROVE target re-checked non-leaf");
        return { ...n, state: { ...n.state, phase: "executing" } };
      });
      next.pendingApproval = null;
      if (gate) effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: true });
      // NO setMode effect (gen-1 invariant preserved): the writable mode is DERIVED from the tree
      // (writePolicyFor2's existential flips on the `executing` leaf set above).
      effects.push({ kind: "persist" });
      break;
    }

    case "REQUEST_CHANGES": {
      const node = requireActive2(next.root, event.path, "REQUEST_CHANGES");
      if (node.state.stage !== "leaf" || node.state.phase !== "awaiting-approval") {
        throw new Error(
          `REQUEST_CHANGES illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/awaiting-approval`,
        );
      }
      const gate = next.pendingApproval;
      // Re-draft IN PLACE: the active path MUST NOT move; siblings MUST NOT be touched (replaceAt
      // copies only the spine). The drafted paths stay recorded on the leaf (gen-1 behavior).
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "leaf") throw new Error("unreachable: REQUEST_CHANGES target re-checked non-leaf");
        return {
          ...n,
          redraftCount: n.redraftCount + 1,
          lastFeedback: event.feedback,
          state: { ...n.state, phase: "drafting" },
        };
      });
      next.pendingApproval = null;
      if (gate) {
        effects.push({ kind: "resolvePermission", id: gate.toolUseId, allow: false, message: event.feedback });
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "EXEC_DONE": {
      const node = requireActive2(next.root, event.path, "EXEC_DONE");
      // The leaf finished executing; it STAYS `executing` until its summary lands (gen-1 shape —
      // the summary turn still needs the writable window's bookkeeping to be unambiguous).
      if (node.state.stage !== "leaf" || node.state.phase !== "executing") {
        throw new Error(
          `EXEC_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/executing`,
        );
      }
      effects.push({ kind: "persist" });
      break;
    }

    case "SUMMARY_WRITTEN": {
      // PHASE 4 — TWO shapes at ANY depth, both addressing THE active node:
      //   LEAF summary: a leaf/executing node summarizes (the gen-1 arc, path-generic), OR
      //   ROLL-UP summary: a NON-ROOT split resting in its roll-up window (running-children, all
      //   children summarized — see inRollupWindow) records its own roll-up and completes.
      // Either way the summary FILE was already written by the driver — the event carries the
      // write's real returned path; the reducer only RECORDS it (no write effect; gen-1 invariant).
      const node = requireActive2(next.root, event.path, "SUMMARY_WRITTEN");
      if (node.state.stage === "leaf") {
        if (node.state.phase !== "executing") {
          throw new Error(
            `SUMMARY_WRITTEN illegal: leaf "${pathKey(event.path)}" is ${node.state.phase}, expected executing`,
          );
        }
        next.root = replaceAt(next.root, event.path, (n) => {
          if (n.state.stage !== "leaf") throw new Error("unreachable: SUMMARY_WRITTEN target re-checked non-leaf");
          return { ...n, state: { ...n.state, phase: "summarized", summaryPath: event.summaryPath } };
        });
      } else if (node.state.stage === "split") {
        // The ROOT writes no roll-up summary — completion is DERIVED (treeIsDone). Defensive: the
        // active-node check above already rejects a resting root split.
        if (event.path.length === 0) {
          throw new Error("SUMMARY_WRITTEN illegal: the root writes no roll-up summary (completion is derived)");
        }
        if (!inRollupWindow(node)) {
          throw new Error(
            `SUMMARY_WRITTEN illegal: split "${pathKey(event.path)}" is ${node.state.phase} outside the roll-up window (all children must be summarized)`,
          );
        }
        next.root = replaceAt(next.root, event.path, (n) => {
          if (n.state.stage !== "split") throw new Error("unreachable: SUMMARY_WRITTEN target re-checked non-split");
          return { ...n, state: { ...n.state, phase: "summarized", summaryPath: event.summaryPath } };
        });
      } else {
        throw new Error(
          `SUMMARY_WRITTEN illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected leaf/executing or a roll-up-window split`,
        );
      }
      effects.push({ kind: "notifySummaryWritten", path: event.path, summaryPath: event.summaryPath });
      // COMPLETION ASCENT (internal — no public advance event), generalized to any depth: activate
      // the next pending sibling, or complete/park the parent. Exactly ONE ascent hop per event —
      // a non-root parent's own completion arrives as its OWN roll-up SUMMARY_WRITTEN (a separate
      // driver turn), so the recursion across levels lives in the EVENT STREAM, not in one reduce.
      advanceAfterSummary(next, event.path, effects);
      effects.push({ kind: "persist" });
      break;
    }

    case "PARENT_REVIEW_DONE": {
      // PHASE 5 — the ONLY exit from `reviewing`: back to running-children, activating the next
      // pending child's recon. Legal ONLY while the addressed node is a split in `reviewing` (any
      // other state throws — reviewing → anything-else has no arc). The reviewed-child summary and
      // the ADJUST note are driver concerns; the reducer only moves the partition forward.
      const node = requireActive2(next.root, event.path, "PARENT_REVIEW_DONE");
      if (node.state.stage !== "split" || node.state.phase !== "reviewing") {
        throw new Error(
          `PARENT_REVIEW_DONE illegal: node "${pathKey(event.path)}" is ${node.state.stage}/${node.state.phase}, expected split/reviewing`,
        );
      }
      const pending = node.state.children.find(
        (c) => c.state.stage === "open" && c.state.phase === "pending",
      );
      if (!pending) {
        // Unreachable: assertCoherent2 forbids reviewing without a pending child (kept loud).
        throw new Error(
          `PARENT_REVIEW_DONE incoherent: reviewing node "${pathKey(event.path)}" has no pending child`,
        );
      }
      next.root = replaceAt(next.root, event.path, (n) => {
        if (n.state.stage !== "split") throw new Error("unreachable: PARENT_REVIEW_DONE target re-checked non-split");
        return { ...n, state: { ...n.state, phase: "running-children" } };
      });
      next.root = replaceAt(next.root, [...event.path, pending.nn], (n) => ({
        ...n,
        state: { stage: "open", phase: "recon" },
      }));
      effects.push({ kind: "persist" });
      break;
    }

    case "ACCEPTANCE_APPROVED":
    case "ACCEPTANCE_DIVERGED": {
      // PHASE 5 — RESOLVE THE FORCED ACCEPTANCE GATE: perform the ORIGINAL finalize the
      // advanceAfterSummary completion ascent deferred (root acceptance window → summarized +
      // notifyDone) and clear the held gate. Legal ONLY while the gate is open: the root MUST be
      // resting in its acceptance window (running-children, all children summarized) AND
      // pendingAcceptance held. Any other shape throws LOUDLY (a verdict with no gate to resolve).
      if (!next.pendingAcceptance) {
        throw new Error(`${event.type} illegal: no acceptance gate is open`);
      }
      if (!inAcceptanceWindow(next.root)) {
        throw new Error(
          `${event.type} illegal: root is ${next.root.state.stage}/${next.root.state.phase}, not in the acceptance window (running-children, all children summarized)`,
        );
      }
      if (next.root.state.stage !== "split") {
        throw new Error("unreachable: acceptance window re-checked non-split root");
      }
      // RECORD THE VERDICT (serializable; round-tripped through toLedger2/rehydrate). DIVERGED also
      // records the reason — the audit trail for why the baseline floor was waived.
      next.acceptance_ =
        event.type === "ACCEPTANCE_APPROVED"
          ? { verdict: "approved", decided_ms: event.decidedMs }
          : { verdict: "diverged", reason: event.reason, decided_ms: event.decidedMs };
      // THE DEFERRED FINALIZE: root → summarized (treeIsDone now true) + notifyDone. Identical shape
      // to the no-baseline immediate-finalize branch in advanceAfterSummary — just deferred behind
      // the verdict.
      next.root = { ...next.root, state: { ...next.root.state, phase: "summarized" } };
      next.pendingAcceptance = null;
      effects.push({ kind: "persist" }, { kind: "notifyDone" });
      break;
    }

    case "ACCEPTANCE_REFINED": {
      // PHASE 6 — RE-PLAN A SUB-PLAN FROM THE FORCED ACCEPTANCE GATE. A first-class third action: reset
      // the target node AND its right-siblings to a fresh re-execution shape so they re-run and
      // overwrite their summaries; on the tree's re-completion (baseline still present, no verdict yet)
      // the Phase-5 gate re-arms automatically. NO "stale summary" flag exists — the reset IS the
      // mechanism, and the resulting tree shape is one the per-level partition already permits.
      //
      // Legal ONLY while the acceptance gate is open: pendingAcceptance held AND the root resting in
      // its acceptance window (running-children, all children summarized). Any other shape throws
      // LOUDLY (a refine with no gate to refine from).
      if (!next.pendingAcceptance) {
        throw new Error("ACCEPTANCE_REFINED illegal: no acceptance gate is open");
      }
      if (!inAcceptanceWindow(next.root)) {
        throw new Error(
          `ACCEPTANCE_REFINED illegal: root is ${next.root.state.stage}/${next.root.state.phase}, not in the acceptance window (running-children, all children summarized)`,
        );
      }
      const target = event.target;
      if (target.length === 0) {
        // The root writes no plan/summary and re-planning the whole tree is "start a new plan", not a
        // refine — so a root target is meaningless here.
        throw new Error("ACCEPTANCE_REFINED illegal: target is the root (re-plan a sub-plan, not the whole tree)");
      }
      // SCOPE: only the root's DIRECT children (the top-level sub-plans the acceptance gate surfaces)
      // are refine targets today. A deeper target would have to un-summarize every ancestor back to the
      // root (the root acceptance window requires ALL root children summarized), which the per-level
      // reset below does not do — so reject it loudly rather than corrupt an ancestor's partition. The
      // realistic gate workflow re-plans a whole top-level sub-plan and re-runs it (and its
      // right-siblings) from scratch.
      if (target.length !== 1) {
        throw new Error(
          `ACCEPTANCE_REFINED illegal: target "${pathKey(target)}" is not a direct root child (only top-level sub-plans are refine targets)`,
        );
      }
      const targetNode = nodeAtPath(next.root, target);
      if (!targetNode) {
        throw new Error(`ACCEPTANCE_REFINED illegal: no node at "${pathKey(target)}"`);
      }
      const parentPath = target.slice(0, -1);
      const parent = nodeAtPath(next.root, parentPath);
      if (!parent || parent.state.stage !== "split") {
        throw new Error(`ACCEPTANCE_REFINED illegal: "${pathKey(target)}" has no split parent`);
      }
      const targetSeg = target[target.length - 1];
      const idx = parent.state.children.findIndex((c) => c.nn === targetSeg);
      if (idx < 0) {
        throw new Error(`ACCEPTANCE_REFINED illegal: "${pathKey(target)}" is not a child of "${pathKey(parentPath)}"`);
      }
      // Collect the reset set: the target plus every right-sibling at the target's level. Each must be
      // currently summarized (the acceptance window guarantees every root child is summarized; a deeper
      // target's right-siblings are likewise summarized when the window holds, but assert it loudly so
      // a refine that would step a non-summarized sibling backward never silently corrupts the
      // partition). For each, emit deletes of its on-disk NN-plan.md / NN-summary.md so the re-run
      // overwrites a clean slate (the driver's delete is a graceful no-op when a file never existed).
      //
      // A reset node may itself be a SPLIT node (a re-planned top-level sub-plan that decomposed into
      // depth-2 children, e.g. 01.01/01.02 + a roll-up under "01"). makeNode2 below discards that live
      // subtree, so BEFORE it does we walk each reset node's CURRENT subtree and emit deletes for every
      // descendant's NN.NN…-plan.md / NN.NN…-summary.md too — otherwise stale descendant summaries leak
      // on disk and the re-decomposition (which may reuse the same child NNs) would render them as
      // phantom prior siblings. Effects only (the reducer stays pure); the driver's delete is
      // containment-guarded and a graceful no-op for a never-written file.
      const emitDescendantDeletes = (node: TreeNode, nodePath: NodePath): void => {
        if (node.state.stage !== "split") return;
        for (const child of node.state.children) {
          const childPath: NodePath = [...nodePath, child.nn];
          effects.push({ kind: "deletePlanTreeFile", name: planName2(childPath) });
          effects.push({ kind: "deletePlanTreeFile", name: summaryName2(childPath) });
          emitDescendantDeletes(child, childPath);
        }
      };
      const resetSegs: Nn[] = [];
      for (let i = idx; i < parent.state.children.length; i++) {
        const sib = parent.state.children[i];
        if (sib.state.stage === "open" || sib.state.phase !== "summarized") {
          throw new Error(
            `ACCEPTANCE_REFINED incoherent: sibling "${pathKey([...parentPath, sib.nn])}" is not summarized (cannot reset a non-summarized node)`,
          );
        }
        resetSegs.push(sib.nn);
        const sibPath: NodePath = [...parentPath, sib.nn];
        effects.push({ kind: "deletePlanTreeFile", name: planName2(sibPath) });
        effects.push({ kind: "deletePlanTreeFile", name: summaryName2(sibPath) });
        emitDescendantDeletes(sib, sibPath);
      }
      // RESET in place: the FIRST reset node (the target) becomes ACTIVE (open/recon) so re-execution
      // starts immediately; every right-sibling resets to fresh open/pending. Left-siblings are
      // untouched (still summarized). The result — summarized* (recon) pending* at the target's level
      // — is a coherent `summarized* active pending*` partition, and the parent stays running-children
      // with EXACTLY ONE active child (assertCoherent2 accepts it). Mirrors DECOMPOSITION_APPROVED's
      // "first child → recon, rest pending" shaping.
      next.root = replaceAt(next.root, parentPath, (n) => {
        if (n.state.stage !== "split") throw new Error("unreachable: ACCEPTANCE_REFINED target parent re-checked non-split");
        const children = nonEmpty(
          n.state.children.map((c): TreeNode => {
            if (!resetSegs.includes(c.nn)) return c;
            const fresh = makeNode2(c.nn, c.title);
            return c.nn === targetSeg
              ? { ...fresh, state: { stage: "open", phase: "recon" } }
              : fresh;
          }),
        );
        return { ...n, state: { ...n.state, children } };
      });
      // BACK TO EXECUTING: clear the held gate (no verdict recorded — acceptance_ stays absent). The
      // re-executed nodes will eventually re-arm the gate at root re-completion (Phase-5 logic).
      next.pendingAcceptance = null;
      effects.push({ kind: "persist" });
      break;
    }

    case "CLARIFY_REQUESTED": {
      // A held AskUserQuestion — transient gate only; does NOT change any node (gen-1 carry-over).
      next.pendingClarify = { toolUseId: event.toolUseId, questions: event.questions };
      break;
    }

    case "CLARIFY_ANSWERED": {
      const gate = next.pendingClarify;
      next.pendingClarify = null;
      // Resolve the held AskUserQuestion with the user's selections (gate id wins; event id is the
      // no-gate fallback — gen-1 carry-over).
      const message = JSON.stringify({ answers: event.answers });
      const id = gate ? gate.toolUseId : event.toolUseId;
      effects.push({ kind: "resolvePermission", id, allow: true, message });
      break;
    }

    case "SESSION_INITIALIZED": {
      // Stamp the run-level SDK session_id and SELF-PERSIST (resume support). NOT a node transition:
      // no node state changes, so the tree (and activePathOf / pendingApproval / every gate) is
      // untouched. IDEMPOTENT: an empty id, or a re-dispatched id equal to the one already stored,
      // is a no-op — no field change AND no persist effect (so re-init on a reconnect doesn't churn
      // state.json). Only a NEW non-empty id sets the field and emits a single persist.
      if (event.sessionId && event.sessionId !== next.sdk_session_id) {
        next.sdk_session_id = event.sessionId;
        effects.push({ kind: "persist" });
      }
      break;
    }

    case "QUOTA_BUDGET_SET": {
      // Set the run's auto-resume budget (dispatched at START from the composer's quota-resume
      // choice). budget == remaining at the start of the run; QUOTA_RESUMED decrements remaining as
      // auto-resumes are spent. NOT a node transition — the tree is untouched. Persist so a killed
      // run resumes with its budget intact.
      next.auto_resume_ = { budget: event.budget, remaining: event.budget };
      effects.push({ kind: "persist" });
      break;
    }

    case "QUOTA_PAUSED": {
      // A quota pause arrived. THE DECISION — fully driven by `remaining`, with the FAIL-CLOSED
      // default: an ABSENT auto_resume_ (no QUOTA_BUDGET_SET was ever dispatched — the resume() path,
      // a legacy ledger) is treated as remaining 0, so the pause goes STRAIGHT to exhausted and NEVER
      // auto-resumes. Only a set budget with remaining > 0 yields an auto-resuming pause. The reducer
      // does NOT decrement here (the decrement rides QUOTA_RESUMED when the resume actually happens) —
      // and stores NO "paused" flag (pause is in-memory orchestrator state, same-process scope). No
      // ledger field changes, so no persist effect.
      // DEGRADED-RESET GUARD: a non-finite or <= 0 resetAt (the sentinel a result-carrier quota emits
      // when the reset time is undeterminable) MUST force the exhausted path REGARDLESS of budget — a
      // resume timer to epoch 0 fires immediately, back into the wall = a new loop. Only a usable
      // (finite, > 0) reset may consult the budget.
      const usableReset = Number.isFinite(event.resetAt) && event.resetAt > 0;
      const remaining = usableReset && next.auto_resume_ ? next.auto_resume_.remaining : 0;
      if (remaining > 0) {
        effects.push({
          kind: "notifyQuotaPaused",
          resetAt: event.resetAt,
          remaining,
          source: event.source,
        });
      } else {
        effects.push({ kind: "notifyQuotaExhausted", resetAt: event.resetAt, source: event.source });
      }
      break;
    }

    case "QUOTA_RESUMED": {
      // An auto-resume (or manual resume) happened — spend one from the budget. Clamp at the floor 0
      // (a resume with no budget left is a defensive no-op on the count). Persist the decremented
      // budget so a kill mid-window leaves the spent count on disk. `nowMs` rides the event (no clock
      // read) for the driver's bookkeeping; the reducer does not store it.
      if (next.auto_resume_ && next.auto_resume_.remaining > 0) {
        next.auto_resume_ = {
          budget: next.auto_resume_.budget,
          remaining: next.auto_resume_.remaining - 1,
        };
        effects.push({ kind: "persist" });
      }
      break;
    }

    case "QUOTA_EXHAUSTED": {
      // A terminal exhaust signal: the run cannot auto-resume further. Surface it; the budget is left
      // as-is (already 0 in the auto-resume flow — no ledger change, so no persist). NOT a node
      // transition.
      effects.push({ kind: "notifyQuotaExhausted", resetAt: event.resetAt, source: event.source });
      break;
    }

    case "FATAL": {
      effects.push({ kind: "notifyFatal", message: event.message });
      // FATAL does not mutate the ledger — it surfaces the error; the driver decides teardown.
      assertCoherent2(next.root);
      return { state: next, effects };
    }
  }

  // NOTE: the reducer does NOT stamp updated_ms (gen-1 invariant): the driver stamps a fresh
  // injected-now() timestamp at its single persist path.
  assertCoherent2(next.root);
  return { state: next, effects };
}
