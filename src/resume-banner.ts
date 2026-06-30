// Resume-banner PURE leaves — affordance-precedence truth table + resume action label.
// Side-effect-free at import time. main.ts re-exports `Affordance` + `computeAffordance` so their `./main` importers keep resolving unchanged; `resumeActionLabel` is imported back directly.

import type { ResumePlan } from "./conversation/orchestrator";

// One-click action label for a resumable plan. Classic kinds (gate/resend/acceptance) use "Resume — <phaseLabel>";
// PHASE-2 kinds use their own forward-action phrasing. All labels here are non-hazardous; hazardous
// variants (leaf/executing) are PHASE-3 and will extend without reshaping this switch.
export function resumeActionLabel(plan: ResumePlan, phaseLabel: string): string {
  switch (plan.kind) {
    case "restart":
      return "Restart from your original request";
    case "prototype-gate":
      return "Resume — Prototype review";
    case "rewind": {
      // PHASE 3c — hazardous rewind: label as "Continue implementation" (user is resuming, not discarding);
      // risk is surfaced in the confirm row, not the button label.
      if (plan.requiresConfirm) return "Continue implementation";
      // "decomposition" → re-present the split's decomposition plan; else → rewind to the approved leaf plan.
      const target = plan.toGate === "decomposition" ? "decomposition plan" : "approved plan";
      return `Rewind to ${target}`;
    }
    case "gate":
    case "resend":
    case "acceptance":
      // Active phase IS the forward action: re-present the gate / re-send / re-mint the acceptance bar.
      return `Resume — ${phaseLabel}`;
  }
}

// Reading-pane affordance by precedence: prototype > acceptance > review > resume > none.
// "review" covers both the held-gate VIEWING bar and the SUMMARY count. Exported for unit tests.
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
