// Multiplan plan-tree package — LEAF: the pure type model (no logic; types only).
//
// The frozen serializable ledger (state.json schema 2) types, the in-memory transient-gate overlay,
// the read-only snapshot, the derived write-policy union, and the resume/recovery decision types.
// PURE declarations — every name here is load-bearing. Depends only on `ids` (and the external
// AskUserQuestion shapes); no logic lives in this leaf.

import type { AskUserQuestionItem } from "../types";
import type { Nn, NodePath, PlanTreeFilePath, NonEmptyArray } from "./ids";

// ---- shared frozen types (survivors of the gen-1 deletion — names are load-bearing) --------

// The sizer's verdict on how to decompose the request. EXACTLY two outcomes: "split" or a
// confident "single". `escalate` is unrepresentable — the master gate is already the human
// checkpoint, so an uncertain sizer splits (the driver coerces any unknown decision to split).
export interface SizerOutcome {
  decision: "single" | "split";
  confidence: number;
  num_plans: number;
}

// The held-AskUserQuestion clarify gate (transient, not serialized).
export interface ClarifyGate {
  readonly toolUseId: string;
  readonly questions: AskUserQuestionItem[];
}

// What a visual prototype IS: the artifact kind, the on-disk file paths backing it, an optional
// screenshot path, an optional inline preview (small artifacts render in-pane without a file
// round-trip), and the labeled variants the prototype turn produced (a prototype turn may offer
// the user several candidate directions side by side).
export interface PrototypeInfo {
  kind: "html" | "mermaid" | "ascii" | "table";
  paths: string[];
  screenshot: string | null;
  inlinePreview: string | null;
  variants: Array<{ label: string; path: string | null; inlinePreview: string | null }>;
}

// The held visual-prototype review gate (transient, not serialized — see pendingPrototype):
// PrototypeInfo plus the refinement round (0-based; PROTOTYPE_REFINED loops increment it
// driver-side) and the cwd the prototype files were written under.
export interface PrototypeGate extends PrototypeInfo {
  round: number;
  cwd: string;
}

// PHASE 5 — THE FORCED ACCEPTANCE GATE (transient, NEVER serialized — modeled on PrototypeGate).
// A tree that froze a working-reference baseline (state.baseline_) CANNOT be reported done without
// the user recording an acceptance verdict against that baseline. When the ROOT's last child
// summarizes WITH a baseline present, instead of finalizing the reducer holds the root in its
// running-children acceptance window (all children summarized — coherent; see assertCoherent2) and
// opens THIS gate. It carries everything the UI needs to surface the verdict without re-deriving:
//   - cwd: the working directory the baseline lives under (open_baseline resolves `openTarget`
//     relative to <cwd>/.plan-tree/baseline/).
//   - openTarget: the file the "Open baseline" button hands open_baseline (e.g. "index.html"),
//     relative to the baseline dir — null when there is nothing single-file to open.
//   - runCommand: a human-readable hint for how to exercise the just-built result against the
//     baseline (e.g. "npm run dev"). Display-only; the gate never runs it.
//   - round: 1-based, mirroring PrototypeGate.round (the acceptance gate is single-round today, so
//     this is always 1 — kept for a uniform held-gate shape and future divergence loops).
// The gate is DERIVED-and-held, not stored: rehydrate nulls it (a resumed run re-presents it from
// the tree shape + baseline_ — same discipline as pendingPrototype).
export interface AcceptanceGate {
  readonly cwd: string;
  readonly openTarget: string | null;
  readonly runCommand: string | null;
  readonly round: number;
}

// ---- derived write policy ---------------------------------------------------------------------

// The sidecar permission mode the session must be in for a given ledger state. Derived by
// writePolicyFor2 (root-phase-aware over the gen-2 tree) and asserted by the driver after every
// transition. "prototype" is the visual-prototyping window: the root is still clarifying intent
// (clarifying-intent / prototype-review), where throwaway prototype artifacts may be written but
// no plan exists yet.
export type WritePolicy = "plan" | "acceptEdits" | "prototype";

// ---- gen-2 node state + tree node -------------------------------------------------------------

// The discriminated per-node state. The three stages are STRUCTURALLY distinct:
//   - "open": pre-sizing (the split-decided-but-not-yet-parsed window included) — NO children, NO
//     artifact paths. `clarifying-intent` is the root-only genesis phase and `prototype-review`
//     the root-only visual-prototype gate window (depth-0 rules, both).
//   - "leaf": the node IS the plan — drafts, gates, executes, summarizes. NO children.
//   - "split": the node decomposed — `children` exists ONLY here and is non-empty by construction.
//     `executing` is NOT a split phase (the type system makes split-executing uncompilable), so
//     writePolicyFor2's existential only ever finds leaves.
// Artifact paths (planPath/summaryPath/plansDirPath) live on leaf AND split states (a split node
// writes its decomposition plan and, post-children, a roll-up summary) but NOT on open (an
// un-sized node has produced no artifacts — unrepresentable rather than null-at-rest).
// INVARIANT[node-state-stage-phase-coupling] (type-level): a node's state is a tagged union on stage (open|leaf|split), each stage permitting only its own phases and co-locating only its own fields (children only on split, artifact paths only on leaf/split).
//   prevents: impossible stage/phase combos and reading a field that doesn't exist for the current stage
export type NodeState =
  | {
      stage: "open";
      phase: "clarifying-intent" | "prototype-review" | "pending" | "recon" | "sizing" | "decomposing" | "awaiting-decomposition-approval";
    }
  | {
      stage: "leaf";
      phase: "drafting" | "awaiting-approval" | "executing" | "summarized";
      planPath: string | null;
      summaryPath: PlanTreeFilePath | null;
      plansDirPath: string | null;
    }
  | {
      stage: "split";
      phase: "running-children" | "reviewing" | "summarized";
      children: NonEmptyArray<TreeNode>;
      planPath: string | null;
      summaryPath: PlanTreeFilePath | null;
      plansDirPath: string | null;
    };

// The ONE recursive node type (root included — no separate RootNode). Identity/bookkeeping fields
// that survive stage transitions live at node level, OUTSIDE the state object: nn/title persist
// across open→leaf/split replacement, and redraftCount/lastFeedback accumulate across redrafts of
// EITHER a decomposition or a leaf plan. The ROOT's `nn` is conventional (mint parseNn(1)) and
// never read: full paths derive from CHILD segments only, so the root contributes no segment.
export interface TreeNode {
  readonly nn: Nn;
  readonly title: string;
  readonly redraftCount: number;
  readonly lastFeedback: string | null;
  readonly state: NodeState;
}

// ---- gen-2 ledger (schema 2) + projections ----------------------------------------------------

// The recursive JSON-serializable ledger, 1:1 with `.plan-tree/state.json` schema 2. `pointer` is
// GONE — the active path is derived (activePathOf); coherence guarantees ≤ 1 active node. No
// schema-1 migration exists (no resume-from-disk exists).
export interface RecursiveLedger {
  schema: 2;
  tree_id: string;
  created_ms: number;
  updated_ms: number;
  root: TreeNode;
  // The SDK conversation's session_id, captured off the system_init frame and self-persisted via
  // SESSION_INITIALIZED so a killed run can later be resumed (resume: sessionId). OPTIONAL and
  // additive — the schema stays 2: an old state.json written before this field existed deserializes
  // fine (absent ⇒ undefined ⇒ no resumable transcript, the expired-transcript fallback). Set once
  // on the first non-empty id of a run; a later re-init overwrites it (the live id wins).
  sdk_session_id?: string;
  // The frozen "working reference" record (Phase 3). PRESENT iff the user marked the visual
  // prototype a working reference at the prototype-approval gate — the driver froze
  // `.plan-tree/prototype/` into the contained `.plan-tree/baseline/` and recorded it here. The
  // baseline is a FLOOR on the outcome dimensions captured in INTENT.md, never a behavioral
  // match-target. OPTIONAL + additive (schema stays 2): an old/sketch state.json without it
  // deserializes fine (absent ⇒ undefined ⇒ no working reference, today's behavior). `frozen_ms`
  // stamps when the freeze happened (purely informational — the presence of the record is the
  // signal). The on-disk artifacts live under `.plan-tree/baseline/`, so no path list is stored
  // (it would only duplicate the dir's contents and could drift from them).
  baseline_?: { frozen: true; frozen_ms: number };
  // PHASE 5 — THE ACCEPTANCE VERDICT against the frozen baseline. PRESENT iff the run reached the
  // forced acceptance gate (a baseline existed when the last child summarized) AND the user resolved
  // it. Two shapes:
  //   - "approved": the built result clears the baseline floor (the default success verdict).
  //   - "diverged": the user accepted a result that does NOT meet the baseline floor and recorded
  //     WHY (`reason` — a serializable, round-tripped string the planner/handoff reads). A divergence
  //     is still a completion (the tree finalizes), but the recorded reason is the audit trail for
  //     why the floor was waived.
  // OPTIONAL + additive (schema stays 2): a tree with NO baseline never reaches the gate, so this
  // field is absent and behavior is byte-identical to today (immediate finalize). The reducer never
  // reads a clock — `decided_ms` rides the resolving event (ACCEPTANCE_APPROVED/DIVERGED).
  acceptance_?:
    | { verdict: "approved"; decided_ms: number }
    | { verdict: "diverged"; reason: string; decided_ms: number };
  // QUOTA AUTO-RESUME BUDGET (the usage-limit pause/resume feature). PRESENT iff the run was started
  // with an auto-resume budget (the composer's quota-resume choice → QUOTA_BUDGET_SET at START): a
  // FINITE count of how many times a quota pause may auto-resume itself before the run must exhaust.
  // `budget` is the original allotment (for display/audit); `remaining` is the live countdown that
  // QUOTA_RESUMED decrements. OPTIONAL + additive (schema STAYS 2): an old/legacy state.json without
  // it deserializes to undefined. THE FAIL-CLOSED DEFAULT lives in the reducer, NOT here: an ABSENT
  // field (no budget was ever set — the resume() path, a legacy ledger) is treated as remaining 0, so
  // a quota pause with no budget goes STRAIGHT to exhausted and NEVER auto-resumes. "Once" is a UI
  // default only; the unset-ledger default is always 0. Pause itself is NOT stored here — it is
  // in-memory orchestrator state (same-process scope), so a killed run never resumes from a stale
  // "paused" flag.
  auto_resume_?: { budget: number; remaining: number };
}

// THE UNIFIED APPROVAL GATE (gen 2): ONE shape for ALL held-ExitPlanMode gates — the root
// decomposition gate included. The gen-1 `nn: -1` sentinel does not exist here: a gate is
// addressed by its NodePath and discriminated by `kind` ("decomposition" = the node's split plan
// is awaiting approval; "leaf" = the node's own plan is). Transient — never serialized.
export interface ApprovalGate2 {
  readonly path: NodePath;
  readonly kind: "decomposition" | "leaf";
  readonly toolUseId: string;
  readonly planPath: string;
  readonly plansDirPath: string;
  readonly redraftCount: number;
}

// The gen-2 in-memory state: the persisted schema-2 ledger PLUS transient fields that are NEVER
// serialized (they live only while held open this session):
//   - pendingApproval: the unified gate (decomposition AND leaf — no sentinel).
//   - pendingClarify: the held AskUserQuestion gate, carried over from gen 1 as-is.
//   - parsedChildren: children parsed from a decomposition DRAFT, stashed until the gate resolves.
//     They are deliberately NOT in the tree yet: a split node's phases (running-children/reviewing/
//     summarized) all require child activity the gate window cannot have (assertCoherent2's
//     exactly-one-active rule; the plan's diagram enters RunKids only on approve), and the `open`
//     stage is structurally child-free. DECOMPOSITION_APPROVED materializes the split from this
//     stash; DECOMPOSITION_CHANGES_REQUESTED discards it (the redraft re-parses).
//   - pendingPrototype: the held visual-prototype gate. Transient like pendingClarify: it is
//     NEVER serialized into the schema-2 ledger (no resume-from-disk exists — see RecursiveLedger —
//     so a persisted gate could only describe a review the restarted session can no longer
//     resolve; the prototype turn simply re-runs).
//   - pendingAcceptance: PHASE 5's held forced-acceptance gate. Transient like pendingPrototype: it
//     is opened when the root's last child summarizes WITH a baseline present (the reducer holds the
//     root in its running-children acceptance window instead of finalizing) and cleared by
//     ACCEPTANCE_APPROVED/ACCEPTANCE_DIVERGED. NEVER serialized — a resumed run re-presents it from
//     the tree shape + baseline_, never from a persisted gate.
export interface PlanTreeState2 extends RecursiveLedger {
  pendingApproval: ApprovalGate2 | null;
  pendingClarify: ClarifyGate | null;
  pendingPrototype: PrototypeGate | null;
  pendingAcceptance: AcceptanceGate | null;
  parsedChildren: { readonly path: NodePath; readonly children: NonEmptyArray<TreeNode> } | null;
}

// The gen-2 read-only snapshot: the ledger's tree plus DERIVED fields (active path, write policy,
// done) so consumers never re-derive them divergently, plus the transient gates (mirroring the
// gen-1 snapshot, which carried pendingApproval/pendingClarify to the UI).
export interface PlanTreeSnapshot2 {
  readonly treeId: string;
  readonly root: TreeNode;
  readonly activePath: NodePath | null;
  readonly writePolicy: WritePolicy;
  readonly done: boolean;
  readonly pendingApproval: ApprovalGate2 | null;
  readonly pendingClarify: ClarifyGate | null;
  readonly pendingPrototype: PrototypeGate | null;
  readonly pendingAcceptance: AcceptanceGate | null;
}

// ---- resume plan / scope (PURE decision types) ------------------------------------------------

// What resuming the active node REQUIRES of the driver. Three shapes (mirroring the v1 scope table):
//   - "gate": the active node is parked at a human approval checkpoint (a leaf plan gate, or a
//     decomposition/master gate). The driver re-presents it from disk — `planPath` is the file the
//     user reviews; `plansDirPath` is its plans-dir copy when known; `redraftCount` rides for the
//     gate. NO tokens are spent re-presenting.
//   - "resend": the active node is mid-turn at a re-sendable step (recon / sizer / leaf draft). The
//     driver re-arms `awaiting` and re-sends that step's existing prompt.
//   - "acceptance" (PHASE 5): the ROOT is parked in its forced-acceptance window (running-children,
//     all children summarized, a baseline frozen, no verdict yet). The build is COMPLETE — the only
//     thing missing is the human's verdict against the frozen baseline. The driver re-mints the
//     transient pendingAcceptance gate (exactly as the live notifyAcceptanceReview path does) so the
//     acceptance bar (Approve / Accept-divergence / Open baseline) re-appears. NO model turn is sent —
//     the tree is parked awaiting a human verdict, not an agent. The verdict (approveAcceptance /
//     divergeAcceptance) then drives the deferred finalize. Carries NO path/artifact fields: the gate
//     is re-derived from the tree shape + baseline_, not from disk artifacts (the gate was never
//     serialized).
//   - "restart" (PHASE 2): the active node is in the GENESIS clarify window (open/clarifying-intent).
//     No durable artifact exists; recovery means RE-RUNNING the clarify turn from the root title. The
//     `path` is the (root) node being re-clarified; `from:"clarify"` is the only restart anchor today.
//     This is a FORWARD action the banner can offer (the driver re-opens the clarifier) — distinct from
//     the legacy "genesis phase — start a new plan" dead-end it replaces.
//   - "prototype-gate" (PHASE 2): the active node is the root prototype-approval window
//     (open/prototype-review). Unlike clarify it DOES have durable artifacts on disk — the
//     `.plan-tree/prototype/` dir + INTENT.md the prototype gate reviews — so it is re-presentable as a
//     GATE-style action rather than a from-scratch restart. Modeled as a DEDICATED resumable kind (NOT a
//     reuse of the "gate" kind) because its artifact is a DIRECTORY/manifest under `.plan-tree/`, not a
//     single plan .md verified through the gate-artifact channels — the consumer (detectResumable /
//     the driver) verifies/re-mints the prototype gate, not a plan-file read. `path` is the (root) node.
//   - "rewind" (PHASE 2): fast-forward-safe resume is impossible from the active node, but the run can
//     be SALVAGED by winding back to the nearest DURABLE gate rather than discarded. `toGate` names the
//     checkpoint to wind back to and `path` the node that gate lives on; `planPath` is the durable
//     artifact's filename when the gate has one (a decomposition plan under `.plan-tree/`), else null;
//     `hazard` is the human-readable note about what made the active node unrecoverable. This is the
//     resumable counterpart of the internal RecoveryAction rewind: ONLY the rewinds recoveryFor marked
//     `offerable` (non-root roll-up, between-children review, torn leaf gate, and the runtime-degenerate
//     no-active-node case) surface as this kind; non-offerable rewinds (leaf/executing — Phase 3 — and
//     the root acceptance-window holds) still map to a BLOCKED verdict.
export type ResumePlan =
  | {
      kind: "gate";
      gateKind: "leaf" | "decomposition";
      path: NodePath;
      planPath: string;
      plansDirPath: string | null;
      redraftCount: number;
    }
  // The active node is mid-turn at a re-sendable step. "recon"/"sizer"/"draft"/"decompose" re-arm a
  // leaf/open step from the node's own state. PHASE-2 DEFECT FIX — "rollup"/"review" re-run the
  // IN-FLIGHT TURN of an ALREADY-SPLIT node whose context (child summaries / mandates) is fully
  // reconstructable from disk (reloadDriverStateFromDisk), so the lost work is ONLY the un-landed
  // turn, not the durable+approved decomposition:
  //   - "rollup": a NON-ROOT split resting in its roll-up window (running-children, all children
  //     summarized) was mid roll-up-summary turn. The driver re-sends rollupSummaryPrompt(path,
  //     direct-children summaries) and re-arms `summary`; its SUMMARY_WRITTEN{path} completes the
  //     split (the write OVERWRITES summaryName2(path) — idempotent). NOT a decomposition re-present
  //     (the node is already split — re-presenting its decomposition gate would dead-end on approve,
  //     because CHILDREN_PARSED/DECOMPOSITION_APPROVED require open/awaiting-decomposition-approval).
  //   - "review": a split in `reviewing` (between children) was mid parent-review turn. The driver
  //     re-sends parentReviewPrompt(reviewed child, its summary, remaining sibling mandates) and
  //     re-arms `parent-review`; its PARENT_REVIEW_DONE{path} advances to the next pending child. The
  //     review turn is NO-TOOLS, so re-running it has no duplicate side effects.
  | { kind: "resend"; awaiting: "recon" | "sizer" | "draft" | "decompose" | "rollup" | "review"; path: NodePath }
  | { kind: "acceptance" }
  | { kind: "restart"; from: "clarify"; path: NodePath }
  | { kind: "prototype-gate"; path: NodePath }
  | {
      kind: "rewind";
      toGate: "leaf-approval" | "decomposition" | "leaf";
      path: NodePath;
      planPath: string | null;
      hazard?: string;
      // PHASE 3: a HAZARDOUS rewind that the user may take but ONLY behind a confirmation (edits from
      // the in-flight executing turn may already be PARTIALLY APPLIED — invariant I3). `true` ⇒ the
      // banner (P3c) must gate the action behind a confirm dialog; absent/false ⇒ a one-click Phase-2
      // rewind (rollup / between-children review / torn leaf gate — no side effects to re-apply). The
      // ONLY requiresConfirm rewind today is leaf/executing.
      requiresConfirm?: boolean;
    };

// The resume verdict for a tree: either resumable (with the ResumePlan describing the continuation)
// or blocked (with a human-readable reason). `phaseLabel` is ALWAYS present (a friendly banner
// label for the active phase) so the UI can describe BOTH outcomes.
export type ResumeScope =
  | { resumable: true; plan: ResumePlan; phaseLabel: string }
  | { resumable: false; reason: string; phaseLabel: string };

// ---- TOTAL recovery model (Phase 1 of the recovery refactor) -----------------------------------
//
// `RecoveryAction` is the TOTAL replacement for the partial resumable/blocked split: EVERY active
// (stage,phase) maps to a concrete recovery, so a dead-end is UNREPRESENTABLE. Three variants, NO
// dead-end:
//   - "resume": re-present a gate / re-send a step exactly as today (the only variant Phase 1
//     exercises — `recoveryFor` maps every currently-resumable phase to this, carrying the SAME
//     ResumePlan the legacy table produced).
//   - "rewind": fast-forward-safe recovery is impossible from the active node, but the run can be
//     SALVAGED by winding back to the nearest durable gate (a leaf-approval/decomposition/leaf
//     checkpoint) rather than discarded. Defined now with a minimal shape; Phases 2-3 implement the
//     actual rewind targets (today every currently-blocked phase yields a PLACEHOLDER rewind/restart
//     that the `resumeScopeForRoot` adapter still renders as the SAME `blocked(reason)` it did
//     before — so Phase 1 changes nothing for those phases).
//   - "restart": the active node is in the GENESIS window (clarify/prototype) where no durable
//     artifact exists; recovery means restarting the clarify turn. `from: "clarify"` is the only
//     restart anchor today.
export type RewindTarget = {
  // The nearest durable gate to wind back to. `path` is the node that gate lives on; `hazard` is an
  // optional human-readable note about what made the active node unrecoverable (e.g. an in-flight
  // tool call). Phases 2-3 refine how the driver acts on this.
  toGate: "leaf-approval" | "decomposition" | "leaf";
  path: NodePath;
  hazard?: string;
  // PHASE 2: whether this rewind is OFFERABLE as a forward resume action NOW. `true` ⇒ the
  // resumeScopeForRoot adapter surfaces it as a resumable `{kind:"rewind", …}` ResumePlan the banner
  // can offer; absent/false ⇒ the adapter keeps the LEGACY blocked verdict (the hazard string is the
  // reason). NON-offerable rewinds today: leaf/executing (Phase 3 owns the duplicate-write recovery)
  // and the root acceptance-window holds (no baseline / over-resolved). Leaving this OFF for executing
  // keeps its placeholder RewindTarget byte-identical to Phase 1 (`{toGate,path,hazard}`).
  offerable?: boolean;
  // The durable artifact filename for an offerable rewind that re-presents a gate (a decomposition
  // plan under `.plan-tree/`, via planName2). Carried so the adapter can build the rewind ResumePlan's
  // `planPath` without re-deriving it. null when the rewind has no single plan artifact (a torn leaf
  // gate whose plan is gone, or a roll-up/review whose target is the split's own decomposition).
  planPath?: string | null;
  // PHASE 3: this OFFERABLE rewind is HAZARDOUS — the user may continue, but ONLY behind a confirmation,
  // because the in-flight executing turn may have ALREADY PARTIALLY APPLIED edits (invariant I3). `true`
  // ⇒ the adapter surfaces `requiresConfirm` on the resumable verdict so the banner (P3c) gates it
  // behind a confirm dialog; absent/false ⇒ the one-click Phase-2 rewinds (rollup / between-children
  // review / torn leaf gate), which have no partially-applied side effects to re-apply. The ONLY
  // requiresConfirm rewind today is leaf/executing.
  requiresConfirm?: boolean;
};

export type RecoveryAction =
  | { kind: "resume"; plan: ResumePlan }
  | { kind: "rewind"; target: RewindTarget }
  | { kind: "restart"; from: "clarify" };

// Injected disk-probe seam (kept OUT of this pure module): whether the decomposition artifact for a
// given node path exists on disk under `.plan-tree/` (the file is `planName2(path)`). `recoveryFor`
// stays pure + synchronous; the REAL disk check is wired by the caller (orchestrator / detectResumable)
// in the next task. When the predicate is OMITTED the default is "artifact ABSENT" (see the
// `open/decomposing` case) — the conservative re-draft path, never a phantom re-present.
export type DecompositionArtifactExists = (path: NodePath) => boolean;
