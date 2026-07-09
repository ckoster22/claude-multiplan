// Multiplan plan-tree package — LEAF: gen-2 resume rehydration, recovery classifier & scope.
//
// Three PURE projections that turn a persisted RecursiveLedger into a resume DECISION (no driver/
// Tauri/DOM): rehydrateState2 (ledger → in-memory state, nulling transients), recoveryFor (the TOTAL
// stage×phase recovery classifier), and resumeScopeForRoot (the ResumeScope adapter over recoveryFor).
// Plus EXECUTING_REWIND_HAZARD (the hazard copy whose SOLE reader is recoveryFor). Depends on `ids`,
// `model`, `nav`, `coherence`, and `select`.

import type { NodePath } from "./ids";
import type {
  TreeNode,
  RecursiveLedger,
  PlanTreeState2,
  RecoveryAction,
  ResumePlan,
  RewindTarget,
  ResumeScope,
  DecompositionArtifactExists,
} from "./model";
import { nonEmpty } from "./ids";
import { activePathOf, nodeAtPath, inAcceptanceWindow } from "./nav";
import { assertCoherent2 } from "./coherence";
import { planName2, treeIsDone, activePhaseLabel } from "./select";

// Backfill the required `execution_model` on every node of a persisted tree: a ledger written before
// the field existed carries nodes with no `execution_model`, and the required TreeNode type demands
// the key be present, so normalize a missing value to explicit `null` (the global-model fallback).
function normalizeExecutionModel(node: TreeNode): TreeNode {
  const withModel: TreeNode =
    node.execution_model === undefined ? { ...node, execution_model: null } : node;
  if (withModel.state.stage !== "split") return withModel;
  return {
    ...withModel,
    state: {
      ...withModel.state,
      children: nonEmpty(withModel.state.children.map(normalizeExecutionModel)),
    },
  };
}

// Rehydrate the in-memory PlanTreeState2 from a persisted ledger: assert coherence, carry EVERY
// serialized field, and null EVERY transient (neither pendingGate nor parsedChildren survives a
// restart — they describe a session that is gone). The driver re-mints any gate it re-presents from
// on-disk artifacts.
export function rehydrateState2(ledger: RecursiveLedger): PlanTreeState2 {
  assertCoherent2(ledger.root);
  const root = normalizeExecutionModel(ledger.root);
  return {
    schema: 2,
    tree_id: ledger.tree_id,
    created_ms: ledger.created_ms,
    updated_ms: ledger.updated_ms,
    root,
    sdk_session_id: ledger.sdk_session_id,
    // Rehydrate the working-reference record from disk so a resumed run still knows the baseline
    // was frozen (deep-copied; absent ⇒ undefined ⇒ a sketch run, unchanged).
    baseline_: ledger.baseline_ ? { ...ledger.baseline_ } : undefined,
    // Rehydrate the recorded acceptance verdict (incl. the divergence reason) from disk; absent ⇒
    // undefined ⇒ the gate was never resolved (a run paused at the acceptance window re-presents the
    // gate from the tree shape + baseline_, not from a persisted gate).
    acceptance_: ledger.acceptance_ ? { ...ledger.acceptance_ } : undefined,
    // Rehydrate the quota auto-resume budget from disk so a resumed run keeps its remaining count
    // (deep-copied; absent ⇒ undefined ⇒ the fail-closed reducer default, never auto-resumes).
    auto_resume_: ledger.auto_resume_ ? { ...ledger.auto_resume_ } : undefined,
    // Every gate is transient — a resumed run re-mints whichever gate it re-presents from on-disk
    // artifacts (the tree shape + baseline_), never from a persisted gate.
    pendingGate: null,
    parsedChildren: null,
  };
}

// The HAZARD copy for the leaf/executing audit-and-continue rewind. Names the ACTION's risk (what
// resuming will DO and how it can go wrong), not merely the state. Surfaced verbatim in the banner's
// confirm row. Exported so tests pin it rather than duplicating the literal.
export const EXECUTING_REWIND_HAZARD =
  "The assistant will inspect the working tree and continue the remaining steps; if it misjudges " +
  "what's already applied, edits could be duplicated or corrupted.";

// TOTAL recovery classifier: maps the GIVEN node's (stage,phase) to a RecoveryAction for EVERY case.
// The switch is exhaustive and ends in an `assertNever` guard, so a new NodeState phase fails to
// COMPILE here until classified. `path` is the active node's path; `decompositionArtifactExists` is
// the injected disk probe used ONLY by the `open/decomposing` case.
//
// Mapping policy: every resumable phase → `{kind:"resume", plan}`; every blocked phase → a
// `rewind`/`restart` action. The disk-probe-aware case is `open/decomposing` (see below).
export function recoveryFor(
  node: TreeNode,
  path: NodePath,
  ledger?: Pick<RecursiveLedger, "baseline_" | "acceptance_">,
  decompositionArtifactExists?: DecompositionArtifactExists,
): RecoveryAction {
  const resume = (plan: ResumePlan): RecoveryAction => ({ kind: "resume", plan });
  const rewind = (target: RewindTarget): RecoveryAction => ({ kind: "rewind", target });

  const state = node.state;
  switch (state.stage) {
    case "open":
      switch (state.phase) {
        case "clarifying-intent":
          // GENESIS clarify window: no durable artifact; restart the clarify turn from the root title.
          // The adapter surfaces this as a RESUMABLE `restart`.
          return { kind: "restart", from: "clarify" };
        case "prototype-review":
          // PROTOTYPE GATE window: UNLIKE clarify it has durable artifacts (the `.plan-tree/prototype/`
          // dir + INTENT.md), so it is RE-PRESENTABLE. A `resume` carrying the dedicated
          // `prototype-gate` ResumePlan (the consumer re-mints the gate — not a plan-file gate). path
          // is the root.
          return resume({ kind: "prototype-gate", path });
        case "recon":
          return resume({ kind: "resend", awaiting: "recon", path });
        case "sizing":
          return resume({ kind: "resend", awaiting: "sizer", path });
        case "decomposing": {
          // DISK-PROBE aware. A persisted `decomposing` is ambiguous: the draft was never sent, OR a
          // draft WAS produced but the transient gate event was lost on the kill. Probe disk:
          //   - artifact PRESENT (planName2(path) under `.plan-tree/`): the draft survived — re-present
          //     the decomposition gate (same as `awaiting-decomposition-approval`, do NOT re-draft).
          //   - artifact ABSENT (or no predicate — the conservative default): re-send the decompose
          //     step (`resend("decompose")`).
          const present = decompositionArtifactExists ? decompositionArtifactExists(path) : false;
          if (present) {
            return resume({
              kind: "gate",
              gateKind: "decomposition",
              path,
              planPath: planName2(path),
              plansDirPath: null,
              redraftCount: node.redraftCount,
            });
          }
          return resume({ kind: "resend", awaiting: "decompose", path });
        }
        case "awaiting-decomposition-approval":
          // DECOMPOSITION GATE: pure-disk re-presentation. planPath is planName2(path) (reconstructed
          // from disk shape); plansDirPath is unknown from the ledger (driver reconstructs it), null.
          return resume({
            kind: "gate",
            gateKind: "decomposition",
            path,
            planPath: planName2(path),
            plansDirPath: null,
            redraftCount: node.redraftCount,
          });
        case "pending":
          // Defensive: open/pending is "not active" per activePathOf, so we never reach here as the
          // active node — but the switch must be exhaustive. Nothing to re-present; rewind placeholder.
          return rewind({ toGate: "decomposition", path, hazard: "not started" });
      }
      return assertNeverRecovery(state);
    case "leaf":
      switch (state.phase) {
        case "drafting":
          return resume({ kind: "resend", awaiting: "draft", path });
        case "awaiting-approval":
          // LEAF GATE: the plan path lives ON the leaf node (recorded at NODE_DRAFTED). A null here is
          // a torn ledger — the adapter renders "missing plan artifact"; otherwise re-present.
          if (state.planPath === null) {
            // RUNTIME-DEGENERATE torn leaf gate: no durable leaf plan to re-present. NON-offerable: with
            // planPath null the orchestrator's leaf-rewind branch FATALs immediately, so an offerable
            // rewind would be a guaranteed throwing button. Render the LEGACY blocked verdict (hazard is
            // the reason), like the no-active-node case above.
            return rewind({
              toGate: "leaf-approval",
              path,
              planPath: null,
              hazard: "missing plan artifact — start a new plan",
            });
          }
          return resume({
            kind: "gate",
            gateKind: "leaf",
            path,
            planPath: state.planPath,
            plansDirPath: state.plansDirPath,
            redraftCount: node.redraftCount,
          });
        case "executing":
          // OFFERABLE-but-HAZARDOUS rewind (invariant I3). The in-flight executing turn may
          // have ALREADY PARTIALLY APPLIED edits; winding back to this leaf's approval gate and
          // re-running could DUPLICATE those writes. We OFFER the rewind (the user CAN continue) but
          // ONLY behind a confirmation (`requiresConfirm`) so the banner (P3c) forces acknowledgement of
          // the risk. `planPath` carries the leaf's own plan path; `offerable` renders it RESUMABLE.
          return rewind({
            toGate: "leaf-approval",
            path,
            planPath: state.planPath,
            // Name the ACTION's risk, not just the state, so the confirm row honestly describes what
            // resuming will do.
            hazard: EXECUTING_REWIND_HAZARD,
            offerable: true,
            requiresConfirm: true,
          });
        case "summarized":
          // Unreachable: a summarized leaf is not active. Exhaustiveness only.
          return rewind({ toGate: "leaf", path, hazard: "already complete" });
      }
      return assertNeverRecovery(state);
    case "split":
      switch (state.phase) {
        case "running-children":
          // THE ROOT ACCEPTANCE WINDOW: the run is complete except the user's verdict against
          // the frozen baseline. RESUMABLE iff the run-level facts confirm a legitimately-parked root
          // (frozen baseline AND no verdict). Otherwise (non-root roll-up, or a torn/over-resolved
          // root) → rewind placeholder.
          if (path.length === 0 && inAcceptanceWindow(node)) {
            if (ledger?.baseline_ && !ledger.acceptance_) {
              return resume({ kind: "acceptance" });
            }
            // ROOT acceptance hold without a frozen baseline (or over-resolved): NOT offerable — parked
            // on a verdict that no longer has its baseline context. Stays the legacy blocked verdict.
            return rewind({
              toGate: "leaf",
              path,
              hazard: "awaiting baseline acceptance — start a new plan",
            });
          }
          // NON-ROOT ROLL-UP WINDOW: a split running-children with EVERY child summarized, mid roll-up
          // turn. The decomposition is ALREADY APPROVED and durable — the only lost work is the un-landed
          // roll-up turn. Re-RUN it (`resend("rollup")`) rather than re-present the consumed decomposition
          // gate: the node is ALREADY split, so CHILDREN_PARSED/DECOMPOSITION_APPROVED would THROW and the
          // Resume button would wedge. reloadDriverStateFromDisk rebuilds the child summaries, the driver
          // re-sends rollupSummaryPrompt, and SUMMARY_WRITTEN{path} completes the split (OVERWRITES
          // summaryName2(path) — idempotent).
          return resume({ kind: "resend", awaiting: "rollup", path });
        case "reviewing":
          // BETWEEN-CHILDREN REVIEW: the split is reviewing before its next child. The decomposition is
          // ALREADY APPROVED and durable; the only lost work is the un-landed parent-review turn (NO
          // TOOLS — no side effects to duplicate). Re-RUN it (`resend("review")`) rather than re-present
          // the consumed gate (which would dead-end on approve, same already-split reason as roll-up).
          // reloadDriverStateFromDisk rebuilds the mandates; the driver re-sends parentReviewPrompt and
          // PARENT_REVIEW_DONE{path} advances to the next pending child.
          return resume({ kind: "resend", awaiting: "review", path });
        case "summarized":
          // Unreachable: a summarized split is not active. Exhaustiveness only.
          return rewind({ toGate: "leaf", path, hazard: "already complete" });
      }
      return assertNeverRecovery(state);
  }
}

// Compile-time exhaustiveness guard for recoveryFor's switch. An unhandled NodeState is a `never`
// here, so omitting a phase FAILS TO COMPILE; at runtime (if the types are bypassed) it throws LOUDLY.
function assertNeverRecovery(state: never): never {
  throw new Error(`recoveryFor: unclassified node state ${JSON.stringify(state)}`);
}

// PURE resume-scope decision over a tree: resolve the active node via activePathOf, then DERIVE the
// verdict from the TOTAL `recoveryFor` classifier:
//   - `{kind:"resume", plan}`  → `{resumable:true, plan, phaseLabel}` (gate / resend / acceptance, and
//     the dedicated `prototype-gate` plan from open/prototype-review);
//   - `{kind:"restart", from}` → `{resumable:true, plan:{kind:"restart", from, path}, phaseLabel}`;
//   - `{kind:"rewind", target}`: OFFERABLE → `{resumable:true, plan:{kind:"rewind", …}}` (non-root
//     roll-up, between-children review, torn leaf gate, no-active-node); NON-offerable →
//     `{resumable:false, reason: hazard}` (leaf/executing and root acceptance-window holds).
//
// DECOMPOSITION GATE PLAN PATH: an `open/awaiting-decomposition-approval` node has NO path field at
// rest (the masterPath lived only on the transient ApprovalGate2, discarded on restart), so it is
// RECONSTRUCTED from disk shape via planName2(path); the driver resolves the FILENAME against
// .plan-tree/.
//
// ACCEPTANCE-WINDOW RESUME: the root acceptance window is structurally identical to a non-root roll-up
// window, so the tree shape alone cannot distinguish a legitimately-parked baseline root from a torn
// ledger. The optional `ledger` disambiguates: a root in the window WITH a frozen baseline AND no
// verdict is resumable; without those facts (or omitted ledger) it stays blocked. The reducer never
// parks the root here without a baseline, so an absent baseline_ is an inconsistent ledger — NOT offered.
//
// `decompositionArtifactExists` is the injected disk-probe seam threaded to `recoveryFor` (PURE here;
// the real probe is wired by the caller). Omitted ⇒ "artifact absent" ⇒ `open/decomposing` resolves to
// `resend("decompose")`.
export function resumeScopeForRoot(
  root: TreeNode,
  ledger?: Pick<RecursiveLedger, "baseline_" | "acceptance_">,
  decompositionArtifactExists?: DecompositionArtifactExists,
): ResumeScope {
  const phaseLabel = activePhaseLabel(root);
  const activePath = activePathOf(root);

  if (activePath === null) {
    if (treeIsDone(root)) {
      return { resumable: false, reason: "already complete", phaseLabel };
    }
    // RUNTIME-DEGENERATE: a non-done tree with no active node (an over-resolved/torn ledger — a fresh
    // tree opens in clarifying-intent, which IS active, so this should not occur in a coherent run).
    // NON-offerable: no durable artifact to wind back to (no active node ⇒ planPath null), and the
    // orchestrator's leaf-rewind branch FATALs on a null planPath — so a Resume button is a guaranteed
    // dead-end. Report BLOCKED with the hazard as the reason, so no throwing button is surfaced.
    return { resumable: false, reason: "no active node — start a new plan", phaseLabel };
  }

  const node = nodeAtPath(root, activePath);
  if (!node) {
    // Unreachable: activePathOf only returns paths that resolve.
    return { resumable: false, reason: "no active node", phaseLabel };
  }

  const action = recoveryFor(node, activePath, ledger, decompositionArtifactExists);
  switch (action.kind) {
    case "resume":
      // resume carries a ResumePlan verbatim (gate/resend/acceptance, and the `prototype-gate` shape).
      return { resumable: true, plan: action.plan, phaseLabel };
    case "rewind": {
      const t = action.target;
      // An OFFERABLE rewind becomes a RESUMABLE `rewind` ResumePlan (wind back to the nearest
      // durable gate). Non-offerable (leaf/executing and root acceptance-window holds) keeps
      // the LEGACY blocked verdict, its hazard the reason.
      if (t.offerable) {
        return {
          resumable: true,
          plan: {
            kind: "rewind",
            toGate: t.toGate,
            path: t.path,
            planPath: t.planPath ?? null,
            ...(t.hazard !== undefined ? { hazard: t.hazard } : {}),
            // Surface the HAZARDOUS one-confirm flag (leaf/executing) so the banner (P3c) gates
            // it behind a confirm dialog. The one-click rewinds leave requiresConfirm absent.
            ...(t.requiresConfirm ? { requiresConfirm: true } : {}),
          },
          phaseLabel,
        };
      }
      return { resumable: false, reason: t.hazard ?? "not resumable", phaseLabel };
    }
    case "restart":
      // The GENESIS clarify window is a FORWARD action — a resumable `restart` (re-run the
      // clarify turn from the root title). `path` is the active (root) node.
      return {
        resumable: true,
        plan: { kind: "restart", from: action.from, path: activePath },
        phaseLabel,
      };
  }
}
