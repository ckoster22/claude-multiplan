// Resume-banner PURE leaves — the affordance-precedence truth table + the resume action label.
//
// Side-effect-free at import time (only a type + two function declarations; no DOM-handle closure, no
// module singleton). The STATEFUL resume banner (`detectResumable`, `renderResumeBanner`,
// `refreshResumeBanner`, `refreshAffordances`, the confirm/toast handlers) stays in main.ts — it
// reads the cwd subsystem + DOM handles. Only these pure leaves move. Imports only the `ResumePlan`
// TYPE from the SP02 barrel. main.ts re-exports `Affordance` + `computeAffordance` so their `./main`
// importers keep resolving unchanged; `resumeActionLabel` was never in main's public export surface,
// so main imports it back directly.

import type { ResumePlan } from "./conversation/orchestrator";

// The HONEST one-click action label for a resumable ResumePlan. Each kind names the concrete forward
// action the user is about to take (the orchestrator decides HOW from the ledger; this label only
// describes WHAT). The classic gate/resend/acceptance shapes keep the "Resume — <phaseLabel>" form;
// the PHASE-2 kinds (restart / prototype-gate / rewind) read as their own forward actions:
//   - restart{from:"clarify"} → re-run the clarify turn from the original request.
//   - prototype-gate → a normal resume back into the prototype-review gate.
//   - rewind{toGate} → wind the run back to the nearest durable gate, named per `toGate`.
// PHASE-2 SCOPE: every label here is a NON-hazardous one-click action. The structured switch leaves
// room for PHASE 3 to add the confirmation-gated hazardous variant (leaf/executing) as a SECONDARY
// without reshaping this; today no hazardous resumable kind reaches the banner.
export function resumeActionLabel(plan: ResumePlan, phaseLabel: string): string {
  switch (plan.kind) {
    case "restart":
      // `from` is "clarify" today (the only restart anchor).
      return "Restart from your original request";
    case "prototype-gate":
      return "Resume — Prototype review";
    case "rewind": {
      // PHASE 3c — the HAZARDOUS executing rewind (requiresConfirm) reads as a forward "continue", NOT a
      // "Rewind to …": the user is resuming the in-flight implementation behind a confirmation, not
      // discarding work. The honest risk ("edits may be partially applied") is surfaced in the confirm
      // row, not the button label.
      if (plan.requiresConfirm) return "Continue implementation";
      // Human-readable per `toGate`: a decomposition rewind re-presents the split's decomposition plan;
      // a leaf / leaf-approval rewind winds back to the node's own approved leaf plan.
      const target = plan.toGate === "decomposition" ? "decomposition plan" : "approved plan";
      return `Rewind to ${target}`;
    }
    case "gate":
    case "resend":
    case "acceptance":
      // The classic resumable kinds keep the "Resume — <active phase>" form (the active phase IS the
      // forward action for these — re-present the gate / re-send the step / re-mint the acceptance bar).
      return `Resume — ${phaseLabel}`;
  }
}

// THE reading-pane affordance, by precedence prototype > acceptance > review > resume
// (at most ONE active at a time). PURE truth table: the caller passes the already-derived signals.
// EXPORTED so the precedence is unit-tested directly (the same pattern as suppressConversationFlip /
// shouldClearPlaceholderOnExit). "review" covers BOTH the held-gate VIEWING bar and the SUMMARY count;
// "resume" is the lowest — the resume banner only surfaces when nothing higher occupies the bar.
export type Affordance = "none" | "prototype" | "acceptance" | "review" | "resume";

// INVARIANT[affordance-union] (precedence): at most one reading-pane affordance is active, chosen by first-match over the total order prototype > acceptance > review > resume > none.
//   prevents: two affordances painted into the bar at once
export function computeAffordance(signals: {
  prototype: boolean;
  acceptance: boolean;
  review: boolean;
  resume: boolean;
}): Affordance {
  if (signals.prototype) return "prototype";
  if (signals.acceptance) return "acceptance";
  if (signals.review) return "review";
  if (signals.resume) return "resume";
  return "none";
}
