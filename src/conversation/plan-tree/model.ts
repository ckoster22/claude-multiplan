// Multiplan plan-tree package — LEAF: the pure type model (no logic; types only).
//
// The frozen serializable ledger (state.json schema 2) types, the in-memory transient-gate overlay,
// the read-only snapshot, the derived write-policy union, and the resume/recovery decision types.
// PURE declarations — every name here is load-bearing. Depends only on `ids`, the external
// AskUserQuestion shapes, and the `ModelOptions` LLM-selection type (type-only, erased — no
// runtime/DOM coupling; `model-picker` imports nothing from plan-tree, so no cycle); no logic
// lives in this leaf.

import type { AskUserQuestionItem } from "../types";
import type { ModelOptions } from "../../model-picker";
import type { Nn, NodePath, PlanTreeFilePath, NonEmptyArray } from "./ids";

// The sizer's verdict on how to decompose the request. EXACTLY two outcomes: "split" or a
// confident "single". `escalate` is unrepresentable — the master gate is already the human
// checkpoint, so an uncertain sizer splits (the driver coerces any unknown decision to split).
export interface SizerOutcome {
  decision: "single" | "split";
  confidence: number;
  num_plans: number;
  // The coding-scope tier for a `single` verdict (drives the leaf's scale-tiered coding model at
  // sizing: standard→Sonnet, large→Opus, huge→Fable). Only consulted for a single (a split is always
  // decomposition → Opus). Absent/unparseable sizer lines default to "standard" (parseSizerDecision).
  scale: "standard" | "large" | "huge";
}

// The held-AskUserQuestion clarify gate (transient, not serialized).
export interface ClarifyGate {
  readonly toolUseId: string;
  readonly questions: AskUserQuestionItem[];
}

// What a visual prototype IS: the artifact kind, the on-disk file paths, an optional screenshot, an
// optional inline preview (small artifacts render in-pane without a file round-trip), and the labeled
// variants the prototype turn produced (several candidate directions side by side).
export interface PrototypeInfo {
  kind: "html" | "mermaid" | "ascii" | "table";
  paths: string[];
  screenshot: string | null;
  inlinePreview: string | null;
  variants: Array<{ label: string; path: string | null; inlinePreview: string | null }>;
}

// The held visual-prototype review gate (transient, not serialized — see the prototype arm of pendingGate):
// PrototypeInfo plus the refinement round (0-based; PROTOTYPE_REFINED loops increment it
// driver-side) and the cwd the prototype files were written under.
export interface PrototypeGate extends PrototypeInfo {
  round: number;
  cwd: string;
}

// THE FORCED ACCEPTANCE GATE (transient, NEVER serialized — modeled on PrototypeGate).
// A tree that froze a working-reference baseline (state.baseline_) CANNOT be reported done without
// the user recording a verdict against it. When the ROOT's last child summarizes WITH a baseline
// present, instead of finalizing the reducer holds the root in its running-children acceptance window
// (all children summarized — coherent; see assertCoherent2) and opens this gate. It carries what the
// UI needs to surface the verdict:
//   - cwd: where the baseline lives (open_baseline resolves `openTarget` relative to
//     <cwd>/.plan-tree/baseline/).
//   - openTarget: the file "Open baseline" hands open_baseline (e.g. "index.html"), relative to the
//     baseline dir — null when there is nothing single-file to open.
//   - runCommand: a display-only hint for exercising the result against the baseline (e.g. "npm run
//     dev"); the gate never runs it.
//   - round: 1-based (single-round today, so always 1 — kept for a uniform held-gate shape).
// DERIVED-and-held, not stored: rehydrate nulls it (a resumed run re-presents it from the tree shape
// + baseline_ — same discipline as the prototype arm of pendingGate).
export interface AcceptanceGate {
  readonly cwd: string;
  readonly openTarget: string | null;
  readonly runCommand: string | null;
  readonly round: number;
}

// The sidecar permission mode the session must be in for a given ledger state. Derived by
// writePolicyFor2 (root-phase-aware) and asserted by the driver after every transition. "prototype"
// is the visual-prototyping window (root still clarifying-intent / prototype-review): throwaway
// prototype artifacts may be written but no plan exists yet.
export type WritePolicy = "plan" | "acceptEdits" | "prototype";

// The discriminated per-node state. The three stages are STRUCTURALLY distinct:
//   - "open": pre-sizing (incl. the split-decided-but-not-yet-parsed window) — NO children, NO
//     artifact paths. `clarifying-intent`/`prototype-review` are the root-only genesis phases.
//   - "leaf": the node IS the plan — drafts, gates, executes, summarizes. NO children.
//   - "split": the node decomposed — `children` exists ONLY here, non-empty by construction.
//     `executing` is NOT a split phase (split-executing is uncompilable), so writePolicyFor2's
//     existential only ever finds leaves.
// Artifact paths (planPath/summaryPath/plansDirPath) live on leaf AND split (a split writes its
// decomposition plan and a roll-up summary) but NOT on open (an un-sized node has no artifacts —
// unrepresentable rather than null-at-rest).
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
// that survive stage transitions live OUTSIDE the state object: nn/title persist across
// open→leaf/split replacement, redraftCount/lastFeedback accumulate across redrafts of EITHER a
// decomposition or a leaf plan. The ROOT's `nn` is conventional (parseNn(1)) and never read — full
// paths derive from CHILD segments only.
export interface TreeNode {
  readonly nn: Nn;
  readonly title: string;
  readonly redraftCount: number;
  readonly lastFeedback: string | null;
  readonly state: NodeState;
  // Which Claude model runs THIS node (NOT the plan-tree data model — see the leaf header).
  // Carries the full {model, effort} so Opus's effort travels with it. Required + nullable: `null`
  // is the explicit "no per-node model → global fallback" value, never a missing key (a legacy
  // pre-field ledger is normalized to `null` at the rehydrate boundary).
  readonly execution_model: ModelOptions | null;
  // How execution_model got here: "auto" (domain-triaged by the reducer) vs "override" (a user pick
  // via EXECUTION_MODEL_SET). Ledger-only (NOT on the PlanRecord wire — schema stays 2, no contract
  // churn); re-triage never clobbers an "override". Additive/optional: absent ⇒ treated as auto.
  readonly model_source?: "auto" | "override";
}

// The recursive JSON-serializable ledger, 1:1 with `.plan-tree/state.json` schema 2. `pointer` is
// GONE — the active path is derived (activePathOf); coherence guarantees ≤ 1 active node. No
// schema-1 migration exists (no resume-from-disk exists).
export interface RecursiveLedger {
  schema: 2;
  tree_id: string;
  created_ms: number;
  updated_ms: number;
  root: TreeNode;
  // The SDK conversation's session_id, captured off system_init and self-persisted via
  // SESSION_INITIALIZED so a killed run can resume. OPTIONAL + additive (schema stays 2): an old
  // state.json deserializes fine (absent ⇒ no resumable transcript). Set once on the first non-empty
  // id; a later re-init overwrites it (the live id wins).
  sdk_session_id?: string;
  // The frozen "working reference" record. PRESENT iff the user marked the prototype a
  // working reference at the prototype-approval gate — the driver froze `.plan-tree/prototype/` into
  // `.plan-tree/baseline/` and recorded it here. The baseline is a FLOOR on the outcome dimensions in
  // INTENT.md, never a behavioral match-target. OPTIONAL + additive (schema stays 2): absent ⇒ no
  // working reference. `frozen_ms` is informational (presence is the signal). No path list is stored
  // (the artifacts live under `.plan-tree/baseline/` — a list would only duplicate and drift).
  baseline_?: { frozen: true; frozen_ms: number };
  // THE ACCEPTANCE VERDICT against the frozen baseline. PRESENT iff the run reached the
  // forced acceptance gate (a baseline existed at last-child summary) AND the user resolved it:
  //   - "approved": the result clears the baseline floor (the default success verdict).
  //   - "diverged": the user accepted a result BELOW the floor and recorded WHY (`reason` — a
  //     serializable, round-tripped string). Still a completion; the reason is the audit trail.
  // OPTIONAL + additive (schema stays 2): a tree with NO baseline never reaches the gate (absent ⇒
  // byte-identical immediate finalize). The reducer reads no clock — `decided_ms` rides the event.
  acceptance_?:
    | { verdict: "approved"; decided_ms: number }
    | { verdict: "diverged"; reason: string; decided_ms: number };
  // QUOTA AUTO-RESUME BUDGET. PRESENT iff the run started with an auto-resume budget (the composer's
  // quota-resume choice → QUOTA_BUDGET_SET at START): a FINITE count of how many quota pauses may
  // auto-resume before the run must exhaust. `budget` is the original allotment (display/audit);
  // `remaining` is the live countdown QUOTA_RESUMED decrements. OPTIONAL + additive (schema STAYS 2).
  // THE FAIL-CLOSED DEFAULT lives in the reducer, NOT here: an ABSENT field (no budget set — resume()
  // path, legacy ledger) is treated as remaining 0, so a pause with no budget goes STRAIGHT to
  // exhausted and never auto-resumes. Pause itself is NOT stored here — it is in-memory orchestrator
  // state, so a killed run never resumes from a stale "paused" flag.
  auto_resume_?: { budget: number; remaining: number };
}

// THE UNIFIED APPROVAL GATE: ONE shape for ALL held-ExitPlanMode gates — the root decomposition
// gate included. A gate is addressed by its NodePath and discriminated by `kind` ("decomposition" =
// the node's split plan is awaiting approval; "leaf" = the node's own plan is). Transient — never
// serialized.
export interface ApprovalGate2 {
  readonly path: NodePath;
  readonly kind: "decomposition" | "leaf";
  readonly toolUseId: string;
  readonly planPath: string;
  readonly plansDirPath: string;
  readonly redraftCount: number;
}

// The held interactive gate, unioned rather than four separate fields: at most one of
// approval/clarify/prototype/acceptance can ever be held at a time (proven via the reducer/
// orchestrator lifecycle trace — the four kinds are disjoint), so the union makes "two gates held
// simultaneously" unconstructable instead of merely unreachable by convention.
// INVARIANT[at-most-one-gate-held] (type-level): the held interactive gate is a single tagged union (approval|clarify|prototype|acceptance), so "two gates held at once" and "a gate of unknown kind" are unconstructable at compile time — not merely unreached by convention.
//   prevents: a silent dual-gate state (two of approval/clarify/prototype/acceptance held simultaneously) or a kind-less gate the UI cannot discriminate
//   test: src/conversation/plan-tree2-reducer.test.ts asserts pendingGate holds exactly one kind-tagged gate — e.g. { kind: "prototype", gate } on PROTOTYPE_DRAFTED and { kind: "approval", gate } on DECOMPOSITION_DRAFTED — and is nulled to a single null on every gate resolution
export type PendingGate =
  | { kind: "approval"; gate: ApprovalGate2 }
  | { kind: "clarify"; gate: ClarifyGate }
  | { kind: "prototype"; gate: PrototypeGate }
  | { kind: "acceptance"; gate: AcceptanceGate };

// The gen-2 in-memory state: the persisted schema-2 ledger PLUS transient fields NEVER serialized
// (they live only while held open this session):
//   - pendingGate: the single held interactive gate (at most one at a time — see PendingGate), one of:
//     - "approval": the unified ExitPlanMode gate (decomposition AND leaf — no sentinel).
//     - "clarify": the held AskUserQuestion gate (gen-1 carry-over).
//     - "prototype": the held visual-prototype gate. NEVER serialized (no resume-from-disk — a
//       persisted gate could only describe a review the restart can't resolve; the turn re-runs).
//     - "acceptance": the held forced-acceptance gate. Opened when the root's last child summarizes
//       WITH a baseline present (the reducer parks the root in its running-children acceptance
//       window instead of finalizing); cleared by ACCEPTANCE_APPROVED/DIVERGED. NEVER serialized —
//       a resumed run re-presents it from the tree shape + baseline_.
//   - parsedChildren: children parsed from a decomposition DRAFT, stashed until the gate resolves.
//     Deliberately NOT in the tree yet: every split phase requires child activity the gate window
//     cannot have (assertCoherent2's exactly-one-active rule), and `open` is structurally child-free.
//     DECOMPOSITION_APPROVED materializes the split from this stash; DECOMPOSITION_CHANGES_REQUESTED
//     discards it.
export interface PlanTreeState2 extends RecursiveLedger {
  pendingGate: PendingGate | null;
  parsedChildren: { readonly path: NodePath; readonly children: NonEmptyArray<TreeNode> } | null;
}

// The gen-2 read-only snapshot: the ledger's tree plus DERIVED fields (active path, write policy,
// done) so consumers never re-derive them divergently, plus the transient gate.
export interface PlanTreeSnapshot2 {
  readonly treeId: string;
  readonly root: TreeNode;
  readonly activePath: NodePath | null;
  readonly writePolicy: WritePolicy;
  readonly done: boolean;
  readonly pendingGate: PendingGate | null;
}

// What resuming the active node REQUIRES of the driver. Shapes:
//   - "gate": the active node is parked at a human approval checkpoint (leaf plan, or decomposition/
//     master). The driver re-presents it from disk — `planPath` is the file reviewed, `plansDirPath`
//     its plans-dir copy when known, `redraftCount` rides. NO tokens spent.
//   - "resend": the active node is mid-turn at a re-sendable step (recon / sizer / leaf draft). The
//     driver re-arms `awaiting` and re-sends that step's existing prompt.
//   - "acceptance": the ROOT is parked in its forced-acceptance window (running-children,
//     all children summarized, baseline frozen, no verdict yet). The build is COMPLETE — only the
//     human verdict is missing. The driver re-mints the transient acceptance gate (pendingGate) (as the live
//     notifyAcceptanceReview path does) so the acceptance bar re-appears. NO model turn is sent.
//     Carries NO path/artifact fields: re-derived from the tree shape + baseline_ (never serialized).
//   - "restart": the active node is in the GENESIS clarify window (open/clarifying-intent).
//     No durable artifact; recovery RE-RUNS the clarify turn from the root title. `path` is the (root)
//     node; `from:"clarify"` is the only anchor. A FORWARD action.
//   - "prototype-gate": the root prototype-approval window (open/prototype-review). Unlike
//     clarify it HAS durable artifacts (the `.plan-tree/prototype/` dir + INTENT.md), so it is
//     re-presentable. A DEDICATED kind (not a reuse of "gate") because its artifact is a DIRECTORY
//     under `.plan-tree/`, not a single plan .md — the consumer re-mints the prototype gate, not a
//     plan-file read. `path` is the (root) node.
//   - "rewind": fast-forward-safe resume is impossible, but the run can be SALVAGED by
//     winding back to the nearest DURABLE gate. `toGate` names the checkpoint, `path` the node it
//     lives on; `planPath` is the durable artifact filename when the gate has one, else null;
//     `hazard` notes what made the active node unrecoverable. The resumable counterpart of the
//     internal RecoveryAction rewind: ONLY `offerable` rewinds (non-root roll-up, between-children
//     review, torn leaf gate, no-active-node) surface here; non-offerable ones (leaf/executing and
//     root acceptance-window holds) still map to a BLOCKED verdict.
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
  // leaf/open step from the node's own state. "rollup"/"review" re-run the
  // IN-FLIGHT TURN of an ALREADY-SPLIT node whose context is reconstructable from disk
  // (reloadDriverStateFromDisk), so the lost work is ONLY the un-landed turn:
  //   - "rollup": a NON-ROOT split in its roll-up window (running-children, all children summarized)
  //     mid roll-up-summary turn. The driver re-sends rollupSummaryPrompt and re-arms `summary`; its
  //     SUMMARY_WRITTEN{path} completes the split (OVERWRITES summaryName2(path) — idempotent). NOT a
  //     decomposition re-present — the node is already split, so its gate would dead-end on approve.
  //   - "review": a split in `reviewing` (between children) mid parent-review turn. The driver re-sends
  //     parentReviewPrompt and re-arms `parent-review`; PARENT_REVIEW_DONE{path} advances to the next
  //     pending child. The review turn is NO-TOOLS, so re-running has no duplicate side effects.
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
      // a HAZARDOUS rewind that the user may take but ONLY behind a confirmation (edits from
      // the in-flight executing turn may already be PARTIALLY APPLIED — invariant I3). `true` ⇒ the
      // banner (P3c) must gate the action behind a confirm dialog; absent/false ⇒ a one-click
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

// `RecoveryAction` is TOTAL: EVERY active (stage,phase) maps to a concrete recovery, so a dead-end
// is UNREPRESENTABLE. Three variants:
//   - "resume": re-present a gate / re-send a step (`recoveryFor` maps every resumable phase to this,
//     carrying a ResumePlan).
//   - "rewind": fast-forward-safe recovery is impossible, but the run can be SALVAGED by winding back
//     to the nearest durable gate (leaf-approval/decomposition/leaf) rather than discarded.
//   - "restart": the active node is in the GENESIS window (clarify/prototype) with no durable
//     artifact; recovery restarts the clarify turn. `from: "clarify"` is the only anchor today.
export type RewindTarget = {
  // The nearest durable gate to wind back to. `path` is the node it lives on; `hazard` is an optional
  // note about what made the active node unrecoverable (e.g. an in-flight tool call).
  toGate: "leaf-approval" | "decomposition" | "leaf";
  path: NodePath;
  hazard?: string;
  // Whether this rewind is OFFERABLE as a forward resume NOW. `true` ⇒ resumeScopeForRoot surfaces a
  // resumable `{kind:"rewind", …}` ResumePlan; absent/false ⇒ the LEGACY blocked verdict (hazard is
  // the reason). NON-offerable today: leaf/executing and the root acceptance-window holds (no
  // baseline / over-resolved).
  offerable?: boolean;
  // The durable artifact filename for an offerable rewind that re-presents a gate (a decomposition
  // plan, via planName2). null when the rewind has no single plan artifact (a torn leaf gate, or a
  // roll-up/review whose target is the split's own decomposition).
  planPath?: string | null;
  // this OFFERABLE rewind is HAZARDOUS — the user may continue, but ONLY behind a confirm,
  // because the in-flight executing turn may have ALREADY PARTIALLY APPLIED edits (invariant I3).
  // `true` ⇒ the adapter surfaces `requiresConfirm` so the banner (P3c) gates it behind a dialog;
  // absent/false ⇒ the one-click rewinds. The ONLY requiresConfirm rewind today is
  // leaf/executing.
  requiresConfirm?: boolean;
};

export type RecoveryAction =
  | { kind: "resume"; plan: ResumePlan }
  | { kind: "rewind"; target: RewindTarget }
  | { kind: "restart"; from: "clarify" };

// Injected disk-probe seam (kept OUT of this pure module): whether the decomposition artifact for a
// node path exists on disk under `.plan-tree/` (`planName2(path)`). `recoveryFor` stays pure +
// synchronous; the REAL disk check is wired by the caller. OMITTED ⇒ "artifact ABSENT" (the
// conservative re-draft path — see the `open/decomposing` case — never a phantom re-present).
export type DecompositionArtifactExists = (path: NodePath) => boolean;
