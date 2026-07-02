// Scripted-fixture LLM emulator — RAW `SDKMessage` fixture data (SEAM A).
//
// This module is the fixture DATA for the emulator: tiny builders that produce RAW SDK messages
// (one hop UPSTREAM of normalize.ts) plus a named-scenario registry. It is SDK-RUNTIME-FREE — it
// imports ONLY the `SDKMessage` TYPE (`import type`), never the SDK's `query()`, so vitest can
// import it in-process and drive each scenario through the REAL `normalize`/quota/backoff functions.
//
// WHY RAW (not pre-normalized): `src/mock/fixtures/scenes.ts` already provides PRE-normalized
// `agent-stream` frames for the FRONTEND. This module deliberately INVERTS that: it emits the SDK's
// large `SDKMessage` union so the sidecar's quota/overload/backoff/permission logic ACTUALLY RUNS.
// Therefore the easiest mistake here is copying scenes.ts's already-flat shapes — DO NOT. The two
// `system`-envelope carriers below are spelled RAW (matching what normalize.ts READS), not flat:
//   - taskStarted → { type:"system", subtype:"task_started", tool_use_id, subagent_type, description }
//     (normalize.ts:154-162), NOT a top-level message type.
//   - permissionDenied → { type:"system", subtype:"permission_denied", tool_name, … } — the raw SDK
//     field is `tool_name` (normalize.ts:177-186 reads `msg.tool_name`), NOT the flat `tool` that
//     scenes.ts:291-299 uses for the ALREADY-normalized frame.
//
// Every fixture is cast `as unknown as SDKMessage` — the same convention normalize.test.ts uses:
// the SDK's `.d.ts` union is large and over-precise; we build the exact wire shape `normalize`
// reads and cast through `unknown`. The literals here are derived from the shapes pinned in
// normalize.test.ts / quota.test.ts (the project's confirmed reference shapes).

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// A session-limit string CONFIRMED matched by isUsageLimitText and parseable by parseClockTimeInTz
// (quota.test.ts: it yields a real future epoch-ms via the "resets <h:mm><am|pm> (<tz>)" clause).
export const SESSION_LIMIT_TEXT =
  "You've hit your session limit · resets 2:10pm (America/Chicago)";

// ---------------------------------------------------------------------------
// RAW `SDKMessage` builders. Each returns the EXACT wire shape normalize.ts reads, cast through
// `unknown` (the normalize.test.ts convention). `parent` defaults to null (top-level turn).
// ---------------------------------------------------------------------------

/** A `system`/`init` message — the conventional first frame of a turn (normalize.ts:164-175). */
export function sysInit(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    model: "claude-emulator",
    cwd: "/Users/emulator/work",
    tools: ["Read", "Edit", "Bash", "Write", "Task"],
    skills: [],
    slash_commands: [],
    permissionMode: "default",
    session_id: "emu-session",
  } as unknown as SDKMessage;
}

/** An assistant message carrying a single renderable text block (normalize.ts:210-219). */
export function assistantText(text: string, parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: parent,
  } as unknown as SDKMessage;
}

/** An assistant message carrying a single tool_use block (normalize.ts:220-228). */
export function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    parent_tool_use_id: parent,
  } as unknown as SDKMessage;
}

/** A `user` message carrying a single tool_result block (normalize.ts:235-251). */
export function userToolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
  parent: string | null = null,
): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: parent,
  } as unknown as SDKMessage;
}

/** A RAW `system`/`task_started` message (normalize.ts:154-162). NOT a top-level message type. */
export function taskStarted(
  toolUseId: string,
  subagentType: string,
  description: string,
): SDKMessage {
  return {
    type: "system",
    subtype: "task_started",
    tool_use_id: toolUseId,
    subagent_type: subagentType,
    description,
  } as unknown as SDKMessage;
}

/** A RAW `system`/`permission_denied` message (normalize.ts:177-186). The raw SDK field is
 *  `tool_name` (NOT the flat `tool` that scenes.ts uses for the already-normalized frame). */
export function permissionDenied(
  toolName: string,
  toolUseId: string,
  message: string,
): SDKMessage {
  return {
    type: "system",
    subtype: "permission_denied",
    tool_name: toolName,
    tool_use_id: toolUseId,
    agent_id: null,
    decision_reason_type: "rule",
    message,
  } as unknown as SDKMessage;
}

/** A terminal successful `result` (normalize.ts:255-288). */
export function resultSuccess(text = "Done."): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    num_turns: 1,
    duration_ms: 1234,
    total_cost_usd: 0,
    session_id: "emu-session",
  } as unknown as SDKMessage;
}

/** A terminal `is_error` result with a NON-limit string (normalize.ts:255-288). `subtype` defaults
 *  to "error_during_execution" — the orchestrator's graceful-advance subtype. */
export function resultError(
  subtype = "error_during_execution",
  text = "build step crashed",
): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    result: text,
    num_turns: 1,
    duration_ms: 1234,
    total_cost_usd: 0,
    session_id: "emu-session",
  } as unknown as SDKMessage;
}

/** A terminal `result` carrying the in-band HTTP-529 overload (isOverloadedMessage branch (2):
 *  `api_error_status === 529`, normalize.ts:79). Emitted as the FIRST message of an attempt
 *  (pre-output) so index.ts's retry loop re-drives. */
export function resultOverload529(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 529,
    result: "",
  } as unknown as SDKMessage;
}

/** An assistant message carrying error:"overloaded" (isOverloadedMessage branch (1),
 *  normalize.ts:75). The other documented in-band 529 carrier. */
export function assistantOverloaded(): SDKMessage {
  return {
    type: "assistant",
    error: "overloaded",
    message: { role: "assistant", content: [] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

/** A REJECTED `rate_limit_event` carrying a structured resetsAt (decideRateLimitFrame quota path,
 *  normalize.ts:291-307). `resetsAt` is epoch-ms (>= 1e12 passes through unchanged). */
export function rateLimitRejected(resetsAt: number): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt },
  } as unknown as SDKMessage;
}

/** A terminal `is_error` result whose payload is the human usage-limit wall string
 *  (result-carrier quota path: decideResultQuota, normalize.ts:274-277). */
export function resultUsageLimit(text: string = SESSION_LIMIT_TEXT): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: text,
    num_turns: 1,
  } as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// Scenario registry. `attempts[i]` is the message stream the i-th query() call replays; index >= 1
// only occurs on a backoff retry (the overloaded scenarios). All others have a single attempt.
// An attempt is either a plain message array (the stream ends normally) or a throw-tailed shape:
// the fake query yields `messages` then THROWS `thenThrow()` — driving index.ts's catch block
// (auth / thrown-quota / generic-sdk classification), which a message fixture cannot reach.
// ---------------------------------------------------------------------------

export type EmulatorAttempt =
  | SDKMessage[]
  | { messages: SDKMessage[]; thenThrow: () => Error };

/** The raw messages of an attempt, regardless of how it ends (normal return or throw). */
export function attemptMessages(attempt: EmulatorAttempt): SDKMessage[] {
  return Array.isArray(attempt) ? attempt : attempt.messages;
}

export interface EmulatorScenario {
  name: string;
  attempts: EmulatorAttempt[];
}

// Borrowed realistic tool inputs (paths mirror the app's plan/prototype/review conventions).
const PLANS_PATH = "/Users/emulator/.claude/plans/emulator-plan.md";
const PROTOTYPE_PATH = "/Users/emulator/work/.plan-tree/prototype/preview.html";

// The one pinned reset instant every quota fixture carries. Epoch-MS (>= 1e12 → passes through
// toEpochMs unchanged) and embedded VERBATIM in the thrown-quota error text so parseResetFromError's
// bare-epoch branch yields it Date.now()-independently. Relative forms (retry-after deltas, ISO
// offsets) are BANNED in fixtures — they resolve against the wall clock and flake the goldens.
export const FIXED_RESET_EPOCH_MS = 1_750_000_000_000;

// Thrown-error texts, exported so tests assert the classification the REAL index.ts catch block
// applies to these exact strings (isAuth regex / parseResetFromError).
export const AUTH_ERROR_MESSAGE = "401 Unauthorized: OAuth token expired";
export const THROWN_QUOTA_ERROR_MESSAGE =
  "Claude usage limit reached; the limit will reset at " + FIXED_RESET_EPOCH_MS + ".";
export const STREAM_ABORT_ERROR_MESSAGE =
  "stream disconnected: ECONNRESET while reading the response body";

const SCENARIOS: EmulatorScenario[] = [
  {
    name: "happy-text",
    attempts: [
      [
        sysInit(),
        assistantText("Here is the first part of my answer."),
        assistantText("And here is the conclusion."),
        resultSuccess("All done."),
      ],
    ],
  },
  {
    name: "tool-call",
    attempts: [
      [
        sysInit(),
        assistantToolUse("emu-tool-1", "Bash", { command: "npm run build" }),
        userToolResult("emu-tool-1", "build succeeded"),
        assistantText("The build passed."),
        resultSuccess("Build complete."),
      ],
    ],
  },
  {
    name: "plan-write",
    attempts: [
      [
        sysInit(),
        assistantToolUse("emu-plan-1", "Write", {
          file_path: PLANS_PATH,
          content: "# Plan\n\n- Step one\n- Step two\n",
        }),
        userToolResult("emu-plan-1", "wrote " + PLANS_PATH),
        assistantText("Plan written to disk."),
        resultSuccess("Plan saved."),
      ],
    ],
  },
  {
    name: "prototype-write",
    attempts: [
      [
        sysInit(),
        assistantToolUse("emu-proto-1", "Write", {
          file_path: PROTOTYPE_PATH,
          content: "<html><body>preview</body></html>",
        }),
        userToolResult("emu-proto-1", "wrote " + PROTOTYPE_PATH),
        resultSuccess("Prototype written."),
      ],
    ],
  },
  {
    name: "review-cycle",
    attempts: [
      [
        sysInit(),
        assistantText("I have a complete plan ready for your review."),
        assistantToolUse("emu-review-1", "ExitPlanMode", {
          plan: "# Plan under review\n\n- Step one\n- Step two\n",
        }),
        userToolResult("emu-review-1", "plan accepted"),
        resultSuccess("Review complete."),
      ],
    ],
  },
  {
    name: "subagent-fanout",
    attempts: [
      [
        sysInit(),
        assistantToolUse("T1", "Task", {
          subagent_type: "general-purpose",
          description: "Investigate the renderer seam",
        }),
        taskStarted("T1", "general-purpose", "Investigate the renderer seam"),
        assistantText("Scanning src/render for entry points…", "T1"),
        // The subagent's OWN internal tool call (parent "T1") — its matching tool_result below
        // correlates to THIS tool_use id, so the child flow is self-consistent (no orphan result).
        assistantToolUse("subtool-1", "Grep", { pattern: "renderInto", path: "src/render" }, "T1"),
        userToolResult("subtool-1", "found renderInto(...)", false, "T1"),
        assistantText("Investigation complete.", null),
        resultSuccess("Fanout done."),
      ],
    ],
  },
  {
    name: "quota-rate-limit",
    attempts: [
      [
        sysInit(),
        // epoch-ms (>= 1e12) so it passes through extractResetAt unchanged.
        rateLimitRejected(FIXED_RESET_EPOCH_MS),
      ],
    ],
  },
  {
    name: "quota-result",
    attempts: [
      [
        sysInit(),
        // The rejected event PINS the reset instant: without it, decideResultQuota falls back to
        // parseClockTimeInTz on the wall string with an implicit Date.now() — a resetAt that rolls
        // DAILY (nondeterministic fixtures/goldens). With it, the structured-reuse branch yields
        // FIXED_RESET_EPOCH_MS. NOTE: in the LIVE pipeline index.ts pauses (gracefulExit 0) on the
        // rejected event's own quota_exceeded frame, so the trailing result-carrier is consumed
        // only by the in-process tests (which drive every message through normalize).
        rateLimitRejected(FIXED_RESET_EPOCH_MS),
        resultUsageLimit(SESSION_LIMIT_TEXT),
      ],
    ],
  },
  {
    name: "overloaded-retry",
    attempts: [
      [resultOverload529()],
      [resultOverload529()],
      [sysInit(), assistantText("Recovered after backoff."), resultSuccess("Succeeded on retry.")],
    ],
  },
  {
    name: "overloaded-exhausted",
    // 7 attempts of pre-output 529 — past BACKOFF_MAX_RETRIES (6) → decideBackoff exhaustion.
    attempts: [
      [resultOverload529()],
      [resultOverload529()],
      [resultOverload529()],
      [resultOverload529()],
      [resultOverload529()],
      [resultOverload529()],
      [resultOverload529()],
    ],
  },
  {
    name: "permission-denied",
    attempts: [
      [
        sysInit(),
        permissionDenied(
          "Write",
          "emu-denied-1",
          "Write to /etc/hosts is outside the allowed prototype directory.",
        ),
        resultSuccess("Turn ended after a denied write."),
      ],
    ],
  },
  {
    name: "error-midstream",
    attempts: [
      [
        sysInit(),
        assistantText("Starting the task…"),
        resultError("error_during_execution", "the tool crashed mid-turn"),
      ],
    ],
  },
  {
    name: "overloaded-midturn",
    // The 529 arrives AFTER rendered output (assistant_text) — index.ts's mid-turn branch: an
    // out-of-band `status` + the synthetic overloadResultFrame, NO retry (a single attempt is the
    // proof: a retry would re-query and clamp to this same attempt, duplicating frames).
    attempts: [
      [
        sysInit(),
        assistantText("Partial answer before the overload hit."),
        resultOverload529(),
      ],
    ],
  },
  {
    name: "auth-failure",
    // Throw an auth-shaped error (matches index.ts's isAuth /auth|token|unauthor|401|oauth/i) →
    // fatal `error` frame error_kind:"auth", exit 1.
    attempts: [
      {
        messages: [sysInit()],
        thenThrow: () => new Error(AUTH_ERROR_MESSAGE),
      },
    ],
  },
  {
    name: "thrown-quota",
    // Throw a quota-shaped error: NOT auth-shaped, and parseResetFromError's bare-epoch branch
    // reads the embedded FIXED_RESET_EPOCH_MS → out-of-band quota_exceeded source:"thrown_error",
    // graceful exit 0.
    attempts: [
      {
        messages: [sysInit()],
        thenThrow: () => new Error(THROWN_QUOTA_ERROR_MESSAGE),
      },
    ],
  },
  {
    name: "stream-abort",
    // Throw a generic transport error (neither auth-shaped nor reset-parseable) → fatal `error`
    // frame error_kind:"sdk", exit 1.
    attempts: [
      {
        messages: [sysInit(), assistantText("Working on it…")],
        thenThrow: () => new Error(STREAM_ABORT_ERROR_MESSAGE),
      },
    ],
  },
];

/** name → scenario. The `EMU_SCENARIO` env value selects an entry. */
export const EMULATOR_SCENARIOS: Record<string, EmulatorScenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.name, s]),
);

/** The valid `EMU_SCENARIO` values (registry keys). */
export const SCENARIO_NAMES: string[] = SCENARIOS.map((s) => s.name);
