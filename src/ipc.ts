import { invoke } from "@tauri-apps/api/core";
import { isOrchestrationActive } from "./conversation/orchestrator";
import {
  success,
  failure,
  matchScalar,
  type ScalarRemoteData,
} from "./remote-data";
import { setHookStatus } from "./review-bar";
import { pendingReviews, currentReviewId, type PendingReview } from "./app-state";
import type { ReviewRequested, ReviewCancelled } from "./types";
import type { ToolPermissionRequested } from "./conversation/types";

/**
 * `.catch` makes the chain self-healing: a rejected `body` is logged but the returned promise still
 * RESOLVES, so subsequent events keep running instead of wedging the chain.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}

// ---- init-injection seam ----------------------------------------------------------------------
// The main-resident reading-pane logic the M4 plan-review handlers reach through, supplied once by
// `main` via `initIpc`. Default to no-op closures so a unit test that never calls initIpc still gets
// well-defined behavior.
export interface IpcDeps {
  openReviewPlanFile: (review: PendingReview) => Promise<void>;
  refreshReviewBar: (countOverride?: number) => void;
  refreshAffordances: () => void;
  switchToPlanTab: () => void;
  getHookStatusEl: () => HTMLElement | null;
  hookStatusMs: number;
}

let deps: IpcDeps = {
  openReviewPlanFile: async () => {},
  refreshReviewBar: () => {},
  refreshAffordances: () => {},
  switchToPlanTab: () => {},
  getHookStatusEl: () => null,
  hookStatusMs: 0,
};

export function initIpc(d: IpcDeps): void {
  deps = d;
}

// A new review request arrived (a new blocking hook). ALWAYS track it in pendingReviews (so it is
// resumable and counted), then decide whether to YANK the pane to it:
//   • If NO review is currently being viewed (currentReviewId() === null — the user is browsing a
//     non-reviewed plan or nothing), focus the window and OPEN THE REAL plan file via the normal
//     flow (selecting its sidebar row). Falls back to a detached planText render if that fails.
//   • If a review is ALREADY being viewed, do NOT yank — just refresh the bar (the count rises;
//     the user can finish the current one then Resume the rest).
export async function handleReviewRequested(payload: ReviewRequested): Promise<void> {
  // The event payload may not carry createdMs — stamp arrival time as a stable fallback so newest
  // resolution still works.
  const createdMs = (payload as { created_ms?: number }).created_ms ?? Date.now();
  const review: PendingReview = {
    reviewId: payload.review_id,
    planFilePath: payload.plan_file_path,
    planText: payload.plan_text,
    createdMs,
    source: "external",
  };
  pendingReviews.set(payload.review_id, review);

  if (currentReviewId() === null) {
    try {
      await invoke("focus_main_window");
    } catch (e) {
      console.error("focus_main_window failed", e);
    }
    // Open the REAL plan file through the normal flow (selects the sidebar row). openReviewPlanFile
    // refreshes the list first and falls back to a detached render if the open fails.
    await deps.openReviewPlanFile(review);
    return;
  }
  // A review is already being viewed — do not yank. The bar's count goes up via summary/viewing.
  deps.refreshReviewBar();
}

// A pending request was cancelled (hook gave up / timed out / removed its request). Drop it from
// pendingReviews. The open plan stays open. Removing this surface can un-suppress the resume banner
// (precedence: a pending review outranks resume), so re-derive BOTH surfaces — without this, an
// out-of-band cancel of the LAST suppressing review would clear the bar but leave a resumable open
// plan's Resume button stuck hidden until re-open.
export function handleReviewCancelled(payload: ReviewCancelled): void {
  pendingReviews.delete(payload.review_id);
  deps.refreshAffordances();
}

// ---- in-process plan-review intercept (the Agent SDK canUseTool seam) ----------
// The SDK emits `tool-permission-requested` when the in-app session wants to use a tool. This app
// is a PLAN REVIEWER: it intercepts ExitPlanMode (the plan emission), materializes the plan as a
// REAL file, registers an in-process pending review, and OPENS it through the normal plan flow on
// the Plan tab — then HOLDS. The held request is NEVER resolved here: the only path to
// resolve_tool_permission(allow) is the user clicking #review-approve. This hold is identical for
// subagent plans (agent_id != null) — agentId is captured for diagnostics, never branched on.
//
// For any OTHER tool reaching the seam, AUTO-ALLOW so the seam never hangs (liveness) AND the session
// is not flooded with "request blocked" errors during plan mode. Returning allow here does NOT defeat
// plan mode: per the installed Agent SDK, plan mode enforces read-only at the CLI level regardless of
// canUseTool, and the ONLY path that switches to acceptEdits is the post-approval
// set_agent_permission_mode("acceptEdits") in resolveReview (the #review-approve click). This handler
// writes NO plan and registers NO review for non-ExitPlanMode tools.
//
// Serialized on the SAME reviewPending chain as the external review events so a held ExitPlanMode and
// an external review/cancel can't interleave their async open/refresh.
export async function handleToolPermissionRequested(payload: ToolPermissionRequested): Promise<void> {
  // Seam ownership: when a multiplan orchestration is active, IT is the sole resolver
  // of the interactive ExitPlanMode seam (it holds/redrafts/approves each sub-plan's plan via its
  // own ledger). The legacy single-shot review path below must NOT also write the plan / register a
  // pendingReview, or the seam would be double-owned. Early-return — no behavior change when no
  // orchestration is active.
  //
  // SUBSUMPTION: the composer now ALWAYS starts a run through getOrchestrator().start()
  // (src/conversation/index.ts), so EVERY composer-initiated plan mode session has an active
  // orchestration — the degenerate single-sub-plan ("single" sizer outcome) collapses the legacy
  // single-shot review into the orchestration's own per-sub gate. As a result the in-process
  // pendingReview minting below is unreachable from the composer flow: this early-return fires first.
  // It is retained ONLY as defensive in-process handling for a future bare-session entry point (a
  // session started WITHOUT an orchestration); it must stay gated behind this guard so two in-process
  // review entry points can NEVER coexist. External file-IPC reviews (the ExitPlanMode hook from other
  // Claude Code sessions) are untouched — they ride list_pending_reviews / respond_to_review, not this
  // seam.
  if (isOrchestrationActive()) return;

  if (payload.tool !== "ExitPlanMode") {
    // DEAD BRANCH (defensive no-op): the sidecar now AUTO-ALLOWS every non-ExitPlanMode tool
    // synchronously in-process (sidecar/index.ts canUseTool) and never emits a
    // tool-permission-requested event for them — eliminating the per-tool frontend round-trip
    // (and its "Stream closed" race) entirely. So this branch should never fire. If it ever does
    // (an older sidecar), log it and do nothing: there is no pending entry to resolve here, and
    // re-resolving a non-existent id would only log "unknown permission id" on the sidecar.
    console.warn(
      "tool-permission-requested for a non-ExitPlanMode tool — ignored (sidecar auto-allows these):",
      payload.tool,
    );
    return;
  }

  // ExitPlanMode: materialize the plan markdown as a REAL file under ~/.claude/plans/, then open it
  // via the normal plan flow. input is { plan: <markdown> } (no path) per the frozen contract.
  const planMarkdown =
    (payload.input as { plan?: unknown } | null | undefined)?.plan;
  const planText = typeof planMarkdown === "string" ? planMarkdown : "";

  // The plan-save read modeled as a ScalarRemoteData<string>: success(path) on resolve — an empty
  // path is still success("") (NOT zeroResults: a scalar write has no empty state), so the
  // un-openable-path liveness branch downstream is preserved — and error(String(e)) on reject. Only
  // the local representation changes to RemoteData; the success/failure BEHAVIOR is folded unchanged.
  let writeResult: ScalarRemoteData<string>;
  try {
    // Backend write_agent_plan returns the absolute path it wrote (frontmatter-tagged, atomic,
    // containment-guarded). tree_id / nn are left undefined for now (the backend seeds a fresh
    // tree_id); re-plan versioning is settled with the backend during live smoke.
    writeResult = success(await invoke<string>("write_agent_plan", { plan: planText }));
  } catch (e) {
    console.error("write_agent_plan failed", e);
    writeResult = failure(String(e));
  }
  // Fold the four reachable scalar states. success → the written path (drives the post-write flow
  // below); error → run the AUTO-DENY liveness path (a side effect) and yield null. initial/fetching
  // are unreachable for a just-awaited write and yield null. A null fold result means "save failed —
  // stop here" (the error arm already released the seam + surfaced the status).
  const writtenPath = await matchScalar<string, Promise<string | null>>(writeResult, {
    initial: () => Promise.resolve(null),
    fetching: () => Promise.resolve(null),
    success: (path) => Promise.resolve(path),
    error: async (message) => {
      // Without a real file we cannot open + review it. Faking a pending review here (empty
      // planFilePath) would hang the seam: currentReviewId() returns null for it, so the bar falls
      // into summary mode, #review-approve stays hidden, and both the approve + submit handlers bail
      // on the null guards — the held canUseTool promise would never resolve. Instead AUTO-DENY so
      // the agent gets feedback and can retry/report, then release without registering any review.
      try {
        await invoke("resolve_tool_permission", {
          id: payload.id,
          allow: false,
          message: "Could not save the plan for review; aborting.",
        });
      } catch (e2) {
        console.error("resolve_tool_permission (write_agent_plan fallback) failed", e2);
      }
      setHookStatus(deps.getHookStatusEl(), `Could not save the plan for review: ${message}`, "error");
      setTimeout(() => setHookStatus(deps.getHookStatusEl(), ""), deps.hookStatusMs);
      return null;
    },
  });
  if (writtenPath === null) return;

  // Register the in-process pending review keyed by the SDK toolUseId (= payload.id). The hold IS
  // this registration — resolve_tool_permission is NEVER called here.
  const review: PendingReview = {
    reviewId: payload.id,
    planFilePath: writtenPath,
    planText,
    createdMs: Date.now(),
    source: "in-process",
    toolUseId: payload.id,
    agentId: payload.agent_id,
  };
  pendingReviews.set(payload.id, review);

  // If a review is already being viewed, don't yank focus (mirror handleReviewRequested): just
  // refresh the bar (the new plan still appears as a sidebar row via the watcher / refreshList).
  if (currentReviewId() !== null) {
    deps.refreshReviewBar();
    return;
  }

  // Open the REAL plan file through the normal flow (selects its sidebar row, loads/persists comments
  // on its real path, live-reloads), then OWN the tab: flip to Plan + focus the window.
  await deps.openReviewPlanFile(review);
  deps.switchToPlanTab();
  try {
    await invoke("focus_main_window");
  } catch (e) {
    console.error("focus_main_window failed", e);
  }
  deps.refreshReviewBar();
}
