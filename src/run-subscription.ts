// Run-subscription PURE predicates — the orchestrator-observer truth tables.
//
// Side-effect-free at import time (only function declarations; the `getOrchestrator().subscribe({...})`
// observer and the `listen(...)` handlers that CONSUME these predicates live inside main.ts's
// DOMContentLoaded closure and stay there). Imports only the snapshot TYPE from the SP02 barrel.
// main.ts re-exports both predicates so their existing `./main` importers (the unit-test truth tables)
// keep resolving unchanged.

import type { PlanTreeSnapshot2 } from "./conversation/orchestrator";

// Pure helper (Bug B fix): should the onActivity conversation-tab flip be SUPPRESSED? Keyed
// STRICTLY on pendingApproval — while a gate is held, every non-result stream frame still fires
// onActivity, which would steal the tab from the Plan view the gate handler just opened. It must
// NOT consider pendingClarify: AskUserQuestion cards render in the Conversation tab and NEED the
// flip. EXPORTED for the unit-test truth table.
export function suppressConversationFlip(
  snap: Pick<PlanTreeSnapshot2, "pendingApproval"> | null,
): boolean {
  return snap?.pendingApproval != null;
}

// Pure helper (agent-exit × placeholder race): should an SDK SESSION exit clear the live-run
// placeholder? agent-exit is NOT 1:1 with the placeholder's run — a previous session's late exit
// can arrive AFTER a fresh run has minted its own placeholder. Clear ONLY when no orchestration is
// active OR the active snapshot's treeId differs from the placeholder's (a stale placeholder no
// ACTIVE orchestration claims). When the active run's treeId MATCHES, the placeholder belongs to a
// still-live run — its lifecycle is owned by onDone/onFatal, never by a session exit. EXPORTED for
// the unit-test truth table.
export function shouldClearPlaceholderOnExit(
  placeholder: { treeId: string } | null,
  orchestrationActive: boolean,
  activeSnapTreeId: string | null,
): boolean {
  if (placeholder === null) return false;
  const activeTreeId = orchestrationActive ? activeSnapTreeId : null;
  return activeTreeId !== placeholder.treeId;
}
