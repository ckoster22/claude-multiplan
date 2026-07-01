// Multiplan orchestration package — BARREL.
//
// Re-exports the package's public surface so consumers keep importing
// `./conversation/orchestrator` unchanged. Explicit named re-exports ONLY — NO `export *`
// (isolatedModules splits values/types into `export {}` / `export type {}`, and a cross-leaf
// collision under `export *` could silently drop a symbol).

export {
  isOrchestrationActive,
  isOrchestratorResuming,
  createOrchestrator,
  __ingestSeenForTest,
  __runTransientSizesForTest,
  getOrchestrator,
  __setOrchestratorForTest,
  __setActiveOrchestratorForTest,
  __resetOrchestratorForTest,
} from "./core";
export {
  intentPrompt,
  refinePrototypePrompt,
  parsePrototypeBlock,
  composeIntentMd,
  reconPrompt,
  sizerPrompt,
  masterDraftPrompt,
  subReconPrompt,
  subDraftPrompt,
  summaryPrompt,
  resumedLeafApprovalPrompt,
  resumedLeafContinuePrompt,
  resumedLeafChangesPrompt,
  resumedDecompositionChangesPrompt,
  quotaResumeWrap,
  nestedDecompositionDraftPrompt,
  rollupSummaryPrompt,
  parentReviewPrompt,
  parseParentReview,
  parseSubPlanHeaders,
  VISUAL_MODE_DIRECTIVE,
  WORKDIR_SCOPE_GUARD,
  BASELINE_FRAMING,
  QUOTA_RESUME_NOTE,
  QUOTA_RESUME_GENERIC,
} from "./prompts";
export { defaultDeps } from "./deps";
export { pathKey, parsePathKey, PlanValidationError } from "../plan-tree";

export type { ParsedMasterPlan } from "./prompts";
export type { OrchestratorDeps } from "./deps";
export type { Mandate, OrchestratorObserver, OrchestratorHandle } from "./types";
export type {
  PlanTreeSnapshot2,
  ApprovalGate2,
  ClarifyGate,
  PlanTreeEvent2,
  WritePolicy,
  Nn,
  NodePath,
  PathKey,
  PlanTreeFilePath,
  PrototypeInfo,
  PrototypeGate,
  AcceptanceGate,
  RecursiveLedger,
  ResumePlan,
  ResumeScope,
} from "../plan-tree";
