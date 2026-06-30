// Multiplan plan-tree package — BARREL.
//
// Re-exports the COMPLETE public surface of the former single-file `plan-tree.ts` (48 symbols: 24
// values + 24 types) so every consumer keeps importing `./plan-tree` unchanged (it now resolves to
// this `plan-tree/index.ts`). Explicit named re-exports ONLY — NO `export *` (the repo uses
// `isolatedModules`, so values and types are split into `export {}` / `export type {}` groups, and a
// cross-leaf collision under `export *` could silently drop a symbol). Each leaf encapsulates one
// invariant; private leaf-to-leaf helpers (cloneNode / replaceAt / someNodeExecuting) are NOT
// re-exported here.
//
// NOTE on `PlanValidationError`: it is re-exported from `./ids`, NOT `./reduce`. `nonEmpty` (in ids,
// the lowest leaf) throws it, so the class must live at or below ids to keep the leaf import graph
// acyclic — keeping it in reduce would force an ids → reduce back-edge. It stays in the VALUE group
// (a class) so the orchestrator's `instanceof PlanValidationError` keeps working.

// ---- values ----
export { parseNn, pathKey, parsePathKey, nonEmpty, PlanValidationError } from "./ids";
export { nodeAtPath, activePathOf, inRollupWindow, inAcceptanceWindow, isRootCollapseChild } from "./nav";
export { assertCoherent2 } from "./coherence";
export { toLedger2, toSnapshot2, treeIsDone, writePolicyFor2, summaryName2, planName2, activePhaseLabel } from "./select";
export { parseSizerDecision } from "./parse";
export { recoveryFor, resumeScopeForRoot, rehydrateState2, EXECUTING_REWIND_HAZARD } from "./recovery";
export { reduce2 } from "./reduce";

// ---- types ----
export type { PlanTreeFilePath, Nn, NodePath, PathKey, NonEmptyArray } from "./ids";
export type { NodeState, TreeNode, RecursiveLedger, PlanTreeState2, PlanTreeSnapshot2, SizerOutcome, ClarifyGate, PrototypeInfo, PrototypeGate, AcceptanceGate, WritePolicy, ApprovalGate2, ResumePlan, ResumeScope, RewindTarget, RecoveryAction, DecompositionArtifactExists } from "./model";
export type { PlanTreeEvent2, Effect2 } from "./events";
