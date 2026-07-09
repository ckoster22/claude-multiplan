import type { PlanTreeSnapshot2 } from "./conversation/orchestrator";

// Suppress the onActivity conversation-tab flip only while an APPROVAL gate is held: gate-held
// streams still fire onActivity and would steal focus from the Plan view. The single `pendingGate`
// union makes this structural — a "clarify"-kind gate does NOT suppress (AskUserQuestion cards
// render in Conversation and need the flip), and the `kind === "approval"` check is the natural
// expression of that, no longer an implicit convention riding on separate fields.
export function suppressConversationFlip(
  snap: Pick<PlanTreeSnapshot2, "pendingGate"> | null,
): boolean {
  return snap?.pendingGate?.kind === "approval";
}

// Should an SDK session exit clear the live-run placeholder? agent-exit is NOT 1:1 with the run:
// a prior session's late exit can arrive after a fresh run has minted its own placeholder.
// Clear only when no active orchestration claims the placeholder (treeId mismatch or no active run);
// when treeIds match, the placeholder's lifecycle belongs to onDone/onFatal, not a session exit.
export function shouldClearPlaceholderOnExit(
  placeholder: { treeId: string } | null,
  orchestrationActive: boolean,
  activeSnapTreeId: string | null,
): boolean {
  if (placeholder === null) return false;
  const activeTreeId = orchestrationActive ? activeSnapTreeId : null;
  return activeTreeId !== placeholder.treeId;
}
