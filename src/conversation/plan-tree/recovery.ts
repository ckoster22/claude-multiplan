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
import { activePathOf, nodeAtPath, inAcceptanceWindow } from "./nav";
import { assertCoherent2 } from "./coherence";
import { planName2, treeIsDone, activePhaseLabel } from "./select";

// Rehydrate the in-memory PlanTreeState2 from a persisted ledger: assert coherence, carry EVERY
// serialized field, and null EVERY transient gate (none of pendingApproval/pendingClarify/
// pendingPrototype/parsedChildren survives a restart — they describe a session that is gone). The
// driver re-mints any gate it re-presents from on-disk artifacts (Phase 3).
export function rehydrateState2(ledger: RecursiveLedger): PlanTreeState2 {
  assertCoherent2(ledger.root);
  return {
    schema: 2,
    tree_id: ledger.tree_id,
    created_ms: ledger.created_ms,
    updated_ms: ledger.updated_ms,
    root: ledger.root,
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
    pendingApproval: null,
    pendingClarify: null,
    pendingPrototype: null,
    // The forced acceptance gate is transient — a resumed run re-mints it from the tree + baseline_.
    pendingAcceptance: null,
    parsedChildren: null,
  };
}

// DA Finding 4 — the HAZARD copy for the leaf/executing audit-and-continue rewind. Names the ACTION's
// risk (what resuming will DO and how it can go wrong), not merely the state. Surfaced verbatim in the
// banner's confirm row ("Are you sure? <hazard>"). Exported so tests pin it from the other side rather
// than duplicating the literal.
export const EXECUTING_REWIND_HAZARD =
  "The assistant will inspect the working tree and continue the remaining steps; if it misjudges " +
  "what's already applied, edits could be duplicated or corrupted.";

// TOTAL recovery classifier: maps the GIVEN node's (stage,phase) to a RecoveryAction for EVERY case.
// The switch is exhaustive and ends in an `assertNever`-style guard, so adding a new phase to
// NodeState fails to COMPILE here until it is classified. `path` is the active node's path (for the
// gate/rewind targets that need it); `decompositionArtifactExists` is the injected disk probe used
// ONLY by the `open/decomposing` case.
//
// Phase-1 mapping policy:
//   - every CURRENTLY-resumable phase → `{kind:"resume", plan: <the SAME ResumePlan as the legacy
//     table>}`;
//   - every CURRENTLY-blocked phase → a PLACEHOLDER `rewind`/`restart` action (Phases 2-3 refine
//     these). The `resumeScopeForRoot` adapter maps those placeholders back to the IDENTICAL
//     `blocked(reason)` strings, so no externally-observable behavior changes for blocked phases.
//   - the ONE behavioral change: `open/decomposing` (see below).
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
          // GENESIS clarify window: no durable artifact; the driver-held confirmedIntent is gone.
          // Restart the clarify turn from the root title. PHASE 2: the adapter now surfaces this as a
          // RESUMABLE `restart` ResumePlan (was the legacy "genesis phase — start a new plan" dead-end).
          return { kind: "restart", from: "clarify" };
        case "prototype-review":
          // PROTOTYPE GATE window: UNLIKE clarify this has durable artifacts on disk (the
          // `.plan-tree/prototype/` dir + INTENT.md the gate reviews), so it is RE-PRESENTABLE rather
          // than restarted from scratch. PHASE 2: classify as a `resume` carrying the dedicated
          // `prototype-gate` ResumePlan (the consumer re-mints the prototype gate from those durable
          // artifacts — it is not a plan-file gate). path is the root.
          return resume({ kind: "prototype-gate", path });
        case "recon":
          return resume({ kind: "resend", awaiting: "recon", path });
        case "sizing":
          return resume({ kind: "resend", awaiting: "sizer", path });
        case "decomposing": {
          // THE Phase-1 behavioral change — DISK-PROBE aware. A persisted `decomposing` is ambiguous:
          // either the draft was never sent, OR a draft WAS produced but the transient decomposition
          // gate event was lost on the kill. Probe disk to disambiguate:
          //   - artifact PRESENT (planName2(path) exists under `.plan-tree/`): the draft survived — yield
          //     the SAME action as `awaiting-decomposition-approval` (re-present the decomposition gate,
          //     do NOT re-draft). No tokens spent.
          //   - artifact ABSENT (or no predicate injected — the conservative default): no draft on disk
          //     → re-send the decompose step (`resend("decompose")`). The driver re-arms the decompose
          //     turn fresh.
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
          // DECOMPOSITION GATE: pure-disk re-presentation. planPath is planName2(path) under
          // `.plan-tree/` (reconstructed from disk shape — see the function note above); plansDirPath
          // is unknown from the ledger (the driver reconstructs it in Phase 3), so null here.
          return resume({
            kind: "gate",
            gateKind: "decomposition",
            path,
            planPath: planName2(path),
            plansDirPath: null,
            redraftCount: node.redraftCount,
          });
        case "pending":
          // Defensive: open/pending is "not active" per activePathOf, so we never reach here with it
          // as the active node — but the switch must be exhaustive. There is nothing to re-present;
          // rewind to the (nonexistent) decomposition gate is the placeholder for "not started".
          return rewind({ toGate: "decomposition", path, hazard: "not started" });
      }
      return assertNeverRecovery(state);
    case "leaf":
      switch (state.phase) {
        case "drafting":
          return resume({ kind: "resend", awaiting: "draft", path });
        case "awaiting-approval":
          // LEAF GATE: the plan path lives ON the leaf node (recorded at NODE_DRAFTED). A null here is
          // a torn ledger — the adapter renders that as "missing plan artifact"; otherwise re-present.
          if (state.planPath === null) {
            // RUNTIME-DEGENERATE torn leaf gate: the plan path that should live on the node is gone, so
            // there is NO durable leaf plan to re-present. DEFECT FIX (honesty): NON-offerable. With
            // planPath null the orchestrator's leaf-rewind branch has nothing to re-present and FATALs
            // immediately, so an OFFERABLE rewind here is a guaranteed throwing button. Leave it
            // non-offerable so the adapter renders the LEGACY blocked verdict (the hazard is the reason),
            // matching the no-active-node degenerate case above.
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
          // PHASE 3 — OFFERABLE-but-HAZARDOUS rewind (invariant I3). The in-flight executing turn may
          // have ALREADY PARTIALLY APPLIED edits to disk; winding back to this leaf's approval gate and
          // re-running could DUPLICATE those writes. Rather than dead-end (the Phase-1/2 non-offerable
          // blocked verdict), we OFFER the rewind — the user CAN continue — but ONLY behind a
          // confirmation (`requiresConfirm`), so the banner (P3c) forces an explicit acknowledgement of
          // the partial-apply risk before resuming. `planPath` carries the leaf's own plan path (the
          // approval gate re-presents it); `offerable` renders it RESUMABLE.
          return rewind({
            toGate: "leaf-approval",
            path,
            planPath: state.planPath,
            // DA Finding 4 — name the ACTION's risk, not just the state, so the confirm row reads as an
            // honest description of what resuming will do and how it can go wrong.
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
          // PHASE 5 — THE ROOT ACCEPTANCE WINDOW: the run is complete except the user's verdict against
          // the frozen baseline. RESUMABLE iff the run-level facts confirm a legitimately-parked
          // baseline root (a frozen baseline AND no recorded verdict). Otherwise (non-root roll-up
          // window, or a torn/over-resolved root) → rewind placeholder (adapter renders the legacy
          // blocked reason).
          if (path.length === 0 && inAcceptanceWindow(node)) {
            if (ledger?.baseline_ && !ledger.acceptance_) {
              return resume({ kind: "acceptance" });
            }
            // ROOT acceptance hold without a frozen baseline (or already over-resolved): NOT offerable —
            // the build is parked on a human verdict that no longer has its baseline context. Stays the
            // legacy blocked verdict (the acceptance scope is baseline-gated, ROOT-only).
            return rewind({
              toGate: "leaf",
              path,
              hazard: "awaiting baseline acceptance — start a new plan",
            });
          }
          // NON-ROOT ROLL-UP WINDOW: a split running-children with EVERY child summarized, mid roll-up
          // summary turn. The decomposition here is ALREADY APPROVED and durable — the only lost work is
          // the un-landed roll-up summary turn. DEFECT FIX: re-RUN that turn rather than re-present the
          // (already-consumed) decomposition gate. Re-presenting the decomposition gate would dead-end on
          // approve — the node is ALREADY split, and CHILDREN_PARSED/DECOMPOSITION_APPROVED both require
          // open/awaiting-decomposition-approval (they THROW on a split node), so the Resume button would
          // wedge at an unresolvable gate. Instead `resend("rollup")`: reloadDriverStateFromDisk rebuilds
          // the direct children's summaries, the driver re-sends rollupSummaryPrompt, and the turn's
          // SUMMARY_WRITTEN{path} completes the split (the write OVERWRITES summaryName2(path) —
          // idempotent, no duplicate side effect).
          return resume({ kind: "resend", awaiting: "rollup", path });
        case "reviewing":
          // BETWEEN-CHILDREN REVIEW: the split is reviewing before dispatching its next child. The
          // decomposition is ALREADY APPROVED and durable; the only lost work is the un-landed
          // parent-review turn (a NO-TOOLS turn — no side effects to duplicate). DEFECT FIX: re-RUN that
          // turn (`resend("review")`) rather than re-present the consumed decomposition gate (which would
          // dead-end on approve for the same already-split reason as the roll-up window above).
          // reloadDriverStateFromDisk rebuilds the mandates; the driver re-sends parentReviewPrompt and
          // PARENT_REVIEW_DONE{path} (legal from split/reviewing) advances to the next pending child.
          return resume({ kind: "resend", awaiting: "review", path });
        case "summarized":
          // Unreachable: a summarized split is not active. Exhaustiveness only.
          return rewind({ toGate: "leaf", path, hazard: "already complete" });
      }
      return assertNeverRecovery(state);
  }
}

// Compile-time exhaustiveness guard for recoveryFor's stage/phase switch. A NodeState the switch did
// not handle (only reachable if a new stage/phase is added without classifying it) is a `never` at
// this site — so omitting a phase FAILS TO COMPILE here. At runtime (only if the type system is
// bypassed) it throws LOUDLY rather than returning a silent action.
function assertNeverRecovery(state: never): never {
  throw new Error(`recoveryFor: unclassified node state ${JSON.stringify(state)}`);
}

// PURE resume-scope decision over a tree, following the v1 scope table EXACTLY. Resolves the active
// node via activePathOf, then maps its stage×phase to a verdict. The switch is EXHAUSTIVE: every
// representable stage×phase is handled and an unknown combination throws LOUDLY (so a new phase
// cannot silently slip through as "resumable" — it must be classified here deliberately).
//
// DECOMPOSITION GATE PLAN PATH (Phase-3 finding): an `open/awaiting-decomposition-approval` node
// has NO path field on its NodeState (the open stage is artifact-free at rest — the
// decomposition's masterPath lived only on the transient ApprovalGate2, which a restart discards).
// So the path here is RECONSTRUCTED from disk shape via planName2(path) ("master.md" at the root,
// "<pathKey>-plan.md" for a nested split). The driver (Phase 3) resolves this against the cwd's
// .plan-tree/ directory; here we return the FILENAME the driver will read.
//
// PHASE 5 ACCEPTANCE-WINDOW RESUME: the ROOT acceptance window (running-children, all children
// summarized) is STRUCTURALLY identical to a non-root roll-up window, so the tree shape alone cannot
// tell a legitimately-parked baseline root (resumable — re-mint the verdict gate) from a torn ledger.
// The optional `ledger` carries the run-level facts (baseline_ frozen, acceptance_ not yet recorded)
// that disambiguate it: a root in the acceptance window WITH a frozen baseline AND no verdict is the
// resumable acceptance scope; without those facts (or omitted ledger — e.g. older callers) it stays
// blocked exactly as before. The reducer NEVER parks the root here without a baseline, so an absent
// baseline_ on a root acceptance window is an inconsistent ledger and is correctly NOT offered.
// PHASE-2 ADAPTER: `resumeScopeForRoot` DERIVES its ResumeScope from the TOTAL `recoveryFor`
// classifier. The mapping (Phase 2 turns the formerly-blocked rewind/restart phases into FORWARD,
// resumable verdicts):
//   - `{kind:"resume", plan}`  → `{resumable:true, plan, phaseLabel}` (plan carried verbatim — gate /
//     resend / acceptance, AND the dedicated `prototype-gate` plan from open/prototype-review);
//   - `{kind:"restart", from}` → `{resumable:true, plan:{kind:"restart", from, path}, phaseLabel}`
//     (the genesis clarify window re-runs the clarify turn — no longer a dead-end);
//   - `{kind:"rewind", target}`:
//       · OFFERABLE target → `{resumable:true, plan:{kind:"rewind", toGate, path, planPath, hazard?}}`
//         (non-root roll-up, between-children review, torn leaf gate, runtime-degenerate no-active-node);
//       · NON-offerable target → `{resumable:false, reason: hazard, phaseLabel}` (leaf/executing, owned
//         by Phase 3; and the root acceptance-window holds) — the LEGACY blocked verdict, unchanged.
// The disk-probe `open/decomposing` behavior (resend by default, decomposition gate when the artifact
// is present) is unchanged from Phase 1.
//
// `decompositionArtifactExists` is the injected disk-probe seam threaded down to `recoveryFor`. It is
// PURE here (the function performs no IO); the real probe is wired by the caller in the next task.
// Omitted ⇒ "artifact absent" default ⇒ `open/decomposing` resolves to `resend("decompose")`.
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
    // pending tree opens in clarifying-intent, which IS active, so this should not occur in a coherent
    // run). DEFECT FIX (honesty): NON-offerable. There is NO durable artifact to wind back to (no active
    // node ⇒ no leaf plan, planPath null), and the orchestrator's leaf-rewind branch FATALs immediately
    // on a null planPath — so offering a Resume button here is a guaranteed dead-end. Report BLOCKED with
    // the hazard as the reason instead (matching the non-offerable leaf rewinds), so no throwing button
    // is ever surfaced.
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
      // resume carries a ResumePlan verbatim — today the gate/resend/acceptance shapes AND (Phase 2)
      // the dedicated `prototype-gate` shape from open/prototype-review. All are resumable as-is.
      return { resumable: true, plan: action.plan, phaseLabel };
    case "rewind": {
      const t = action.target;
      // PHASE 2: an OFFERABLE rewind becomes a RESUMABLE `rewind` ResumePlan the banner can offer
      // (wind back to the nearest durable gate). A non-offerable rewind (leaf/executing — Phase 3 —
      // and the root acceptance-window holds) keeps the LEGACY blocked verdict, its hazard the reason.
      if (t.offerable) {
        return {
          resumable: true,
          plan: {
            kind: "rewind",
            toGate: t.toGate,
            path: t.path,
            planPath: t.planPath ?? null,
            ...(t.hazard !== undefined ? { hazard: t.hazard } : {}),
            // PHASE 3: surface the HAZARDOUS one-confirm flag (leaf/executing) so detectResumable /
            // renderResumeBanner (P3c) can gate it behind a confirm dialog. The Phase-2 one-click
            // rewinds (rollup / review / torn leaf gate) leave requiresConfirm absent ⇒ stay one-click.
            ...(t.requiresConfirm ? { requiresConfirm: true } : {}),
          },
          phaseLabel,
        };
      }
      return { resumable: false, reason: t.hazard ?? "not resumable", phaseLabel };
    }
    case "restart":
      // PHASE 2: the GENESIS clarify window is now a FORWARD action — a resumable `restart` ResumePlan
      // (re-run the clarify turn from the root title), no longer the "genesis phase — start a new plan"
      // dead-end. `path` is the active (root) node being re-clarified.
      return {
        resumable: true,
        plan: { kind: "restart", from: action.from, path: activePath },
        phaseLabel,
      };
  }
}
