// Agent SDK sidecar — env-var session-option overrides (pure, unit-testable).
//
// Test harnesses launch the app with AGENT_EFFORT / AGENT_MODEL set to make live
// runs cheap (lower output effort, cheaper model) WITHOUT changing normal app
// behavior: unset or invalid values produce NO override (the SDK/CLI defaults
// apply exactly as before). Read ONCE at startup by index.ts.

import type { Options } from "@anthropic-ai/claude-agent-sdk";

// The SDK's EffortLevel union (sdk.d.ts: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`),
// kept as a literal whitelist so a typo'd env value falls through to "no override"
// instead of being passed to the API and failing the session.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface OptionOverrides {
  effort?: Options["effort"];
  model?: string;
}

/** Single source of truth for "is this a valid SDK effort level?" — shared by
 *  the env path (here) and the picker path (model-effort.ts) so a typo'd effort
 *  falls through to "no override" instead of failing the SDK session. */
export function isEffortLevel(v: unknown): v is OptionOverrides["effort"] {
  return typeof v === "string" && EFFORT_LEVELS.has(v);
}

/** Map process env → session-option overrides. Pure: pass `process.env` in.
 *  - AGENT_EFFORT: must be a valid SDK effort level, else omitted entirely.
 *  - AGENT_MODEL: any non-empty string passes through, else omitted. */
// INVARIANT[env-override-whitelist-or-no-op] (runtime-guard): AGENT_EFFORT overrides only for a valid SDK level and AGENT_MODEL only when non-empty; invalid values produce no override.
//   prevents: a typo'd effort/empty model failing the whole session.
export function optionOverridesFromEnv(
  env: Record<string, string | undefined>,
): OptionOverrides {
  const overrides: OptionOverrides = {};
  const effort = env.AGENT_EFFORT;
  if (isEffortLevel(effort)) {
    overrides.effort = effort;
  }
  const model = env.AGENT_MODEL;
  if (model !== undefined && model.length > 0) {
    overrides.model = model;
  }
  return overrides;
}
