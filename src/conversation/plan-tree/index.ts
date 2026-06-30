// Multiplan plan-tree package — BARREL.
//
// Re-exports the complete public surface of the former single-file `plan-tree.ts` so consumers keep
// importing `./plan-tree` unchanged. Explicit named re-exports ONLY — NO `export *`: under
// `isolatedModules` values and types split into `export {}` / `export type {}` groups, and a
// cross-leaf collision under `export *` could silently drop a symbol. Private leaf-to-leaf helpers
// (cloneNode / replaceAt / someNodeExecuting) are NOT re-exported.
//
// `PlanValidationError` is re-exported from `./ids`, NOT `./reduce`: `nonEmpty` (in ids) throws it,
// so the class must live at or below ids to keep the import graph acyclic (reduce would force an
// ids → reduce back-edge). It stays in the VALUE group (a class) so `instanceof` keeps working.

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
