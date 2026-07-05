// Fixture data for the emulator: builders producing RAW SDK messages (one hop upstream of
// normalize.ts) plus a named-scenario registry. Imports ONLY the `SDKMessage` type (`import type`,
// never the SDK's `query()`) so vitest can drive each scenario through the real normalize/quota/
// backoff functions in-process.
//
// These are RAW (not the pre-normalized frames src/mock/fixtures/scenes.ts feeds the frontend): the
// point is to emit the SDK's `SDKMessage` union so the sidecar's quota/overload/backoff/permission
// logic actually runs. So the `system`-envelope carriers must match what normalize.ts reads, NOT the
// flat frontend shape: taskStarted/permissionDenied are `{ type:"system", subtype, … }`, and
// permissionDenied's field is `tool_name`, not the flat `tool` scenes.ts uses.
//
// Fixtures are cast `as unknown as SDKMessage` (the SDK's `.d.ts` union is over-precise; we build
// the exact wire shape normalize reads and cast through `unknown`).

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Must satisfy isUsageLimitText AND parseClockTimeInTz (the "resets <h:mm><am|pm> (<tz>)" clause).
export const SESSION_LIMIT_TEXT =
  "You've hit your session limit · resets 2:10pm (America/Chicago)";

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

export function assistantText(text: string, parent: string | null = null): SDKMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: parent,
  } as unknown as SDKMessage;
}

/** Split `text` into word-sized chunks WITH surrounding whitespace preserved, so concatenating the
 *  chunks reproduces `text` byte-for-byte. */
export function streamTokens(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/\s*\S+\s*/g) ?? [text];
}

/** Token-by-token stream for one text block, mirroring the SDK's `includePartialMessages` output:
 *  `stream_event` deltas during the turn followed by the consolidated `assistantText` (the final
 *  authoritative block). Splice `...assistantTextStreamed(...)` where a plain `assistantText(...)`
 *  reply would appear. */
export function assistantTextStreamed(text: string, parent: string | null = null): SDKMessage[] {
  const streamEvent = (event: Record<string, unknown>): SDKMessage =>
    ({ type: "stream_event", event, parent_tool_use_id: parent } as unknown as SDKMessage);
  return [
    streamEvent({ type: "message_start" }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...streamTokens(text).map((chunk) =>
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } }),
    ),
    streamEvent({ type: "content_block_stop", index: 0 }),
    assistantText(text, parent),
  ];
}

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

/** RAW `system`/`task_started` — NOT a top-level message type. */
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

/** RAW `system`/`permission_denied`; the field is `tool_name`, not the flat `tool`. */
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

/** A terminal `is_error` result with a non-limit string. `subtype` defaults to
 *  "error_during_execution" — the orchestrator's graceful-advance subtype. */
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

/** A terminal `result` carrying the in-band HTTP-529 overload (`api_error_status === 529`). Emit as
 *  the FIRST message of an attempt (pre-output) so index.ts's retry loop re-drives. */
export function resultOverload529(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 529,
    result: "",
  } as unknown as SDKMessage;
}

/** An assistant message carrying `error:"overloaded"` — the other in-band 529 carrier. */
export function assistantOverloaded(): SDKMessage {
  return {
    type: "assistant",
    error: "overloaded",
    message: { role: "assistant", content: [] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

/** A REJECTED `rate_limit_event`. `resetsAt` is epoch-ms (>= 1e12 passes through unchanged). */
export function rateLimitRejected(resetsAt: number): SDKMessage {
  return {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt },
  } as unknown as SDKMessage;
}

/** A terminal `is_error` result whose payload is the human usage-limit wall string. */
export function resultUsageLimit(text: string = SESSION_LIMIT_TEXT): SDKMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: text,
    num_turns: 1,
  } as unknown as SDKMessage;
}

// `attempts[i]` is the message stream the i-th query() call replays; index >= 1 occurs only on a
// backoff retry (overloaded scenarios) or a resume-timeout recovery (silent-resume scenarios). Each
// attempt kind: "frames" ends normally; "throw" yields `messages` then throws `thenThrow()` (driving
// index.ts's catch classification); "hang" never yields its first frame — the wedged resume, distinct
// from a `[]` "frames" attempt that would end immediately; "await-input" stays silent until the first
// user message reaches the streaming-input prompt, then yields `messages`, modelling the real CLI
// (silent on stdin until the first user turn).
//
// INVARIANT[emulator-attempt-tagged-union] (type-level): every emulator attempt carries a "kind" discriminant (frames|throw|hang|await-input); attemptMessages switches on it exhaustively with an assertNever default, so a new variant it fails to handle is a compile error rather than a runtime shape-sniff (Array.isArray / "in") that could misclassify an attempt.
//   prevents: a bare-array-vs-object mis-probe silently dropping a hang/throw/await-input tail or misreading frames.
//   test: emulator.test.ts (makeEmulatorQuery attempt-advance + throw-tail cases); emulator-e2e goldens (hang/throw/frames/await-input).
export type EmulatorAttempt =
  | { kind: "frames"; messages: SDKMessage[] }
  | { kind: "throw"; messages: SDKMessage[]; thenThrow: () => Error }
  | { kind: "hang" }
  | { kind: "await-input"; messages: SDKMessage[] };

export const frames = (...messages: SDKMessage[]): EmulatorAttempt => ({ kind: "frames", messages });

function assertNever(x: never): never {
  throw new Error("unreachable EmulatorAttempt: " + JSON.stringify(x));
}

export function attemptMessages(attempt: EmulatorAttempt): SDKMessage[] {
  switch (attempt.kind) {
    case "frames":
      return attempt.messages;
    case "throw":
      return attempt.messages;
    case "await-input":
      return attempt.messages;
    case "hang":
      return [];
    default:
      return assertNever(attempt);
  }
}

export interface EmulatorScenario {
  name: string;
  attempts: EmulatorAttempt[];
  // Emulator seam for the resume pre-flight (index.ts `resumeTranscriptExists`). Set true so a
  // scenario's `start.resume` passes the pre-flight and reaches the SDK — the only way to drive the
  // live-resume path token-free. Absent ⇒ the real getSessionInfo runs (resume-fallback's bogus-id probe).
  resumeTranscriptExists?: boolean;
}

const PLANS_PATH = "/Users/emulator/.claude/plans/emulator-plan.md";
const PROTOTYPE_PATH = "/Users/emulator/work/.plan-tree/prototype/preview.html";

// The one pinned reset instant every quota fixture carries. Epoch-ms (>= 1e12 passes through
// unchanged) and embedded verbatim in the thrown-quota error text so parseResetFromError's bare-epoch
// branch yields it independently of Date.now(). Relative forms (retry-after deltas, ISO offsets) are
// banned in fixtures — they resolve against the wall clock and flake the goldens.
export const FIXED_RESET_EPOCH_MS = 1_750_000_000_000;

// Thrown-error texts, exported so tests assert the exact classification index.ts's catch block applies.
export const AUTH_ERROR_MESSAGE = "401 Unauthorized: OAuth token expired";
export const THROWN_QUOTA_ERROR_MESSAGE =
  "Claude usage limit reached; the limit will reset at " + FIXED_RESET_EPOCH_MS + ".";
export const STREAM_ABORT_ERROR_MESSAGE =
  "stream disconnected: ECONNRESET while reading the response body";

const SCENARIOS: EmulatorScenario[] = [
  {
    name: "happy-text",
    attempts: [
      frames(
        sysInit(),
        ...assistantTextStreamed("Here is the first part of my answer."),
        ...assistantTextStreamed("And here is the conclusion."),
        resultSuccess("All done."),
      ),
    ],
  },
  {
    name: "tool-call",
    attempts: [
      frames(
        sysInit(),
        assistantToolUse("emu-tool-1", "Bash", { command: "npm run build" }),
        userToolResult("emu-tool-1", "build succeeded"),
        ...assistantTextStreamed("The build passed."),
        resultSuccess("Build complete."),
      ),
    ],
  },
  {
    name: "plan-write",
    attempts: [
      frames(
        sysInit(),
        assistantToolUse("emu-plan-1", "Write", {
          file_path: PLANS_PATH,
          content: "# Plan\n\n- Step one\n- Step two\n",
        }),
        userToolResult("emu-plan-1", "wrote " + PLANS_PATH),
        ...assistantTextStreamed("Plan written to disk."),
        resultSuccess("Plan saved."),
      ),
    ],
  },
  {
    name: "prototype-write",
    attempts: [
      frames(
        sysInit(),
        assistantToolUse("emu-proto-1", "Write", {
          file_path: PROTOTYPE_PATH,
          content: "<html><body>preview</body></html>",
        }),
        userToolResult("emu-proto-1", "wrote " + PROTOTYPE_PATH),
        resultSuccess("Prototype written."),
      ),
    ],
  },
  {
    name: "review-cycle",
    attempts: [
      frames(
        sysInit(),
        ...assistantTextStreamed("I have a complete plan ready for your review."),
        assistantToolUse("emu-review-1", "ExitPlanMode", {
          plan: "# Plan under review\n\n- Step one\n- Step two\n",
        }),
        userToolResult("emu-review-1", "plan accepted"),
        resultSuccess("Review complete."),
      ),
    ],
  },
  {
    name: "subagent-fanout",
    attempts: [
      frames(
        sysInit(),
        assistantToolUse("T1", "Task", {
          subagent_type: "general-purpose",
          description: "Investigate the renderer seam",
        }),
        taskStarted("T1", "general-purpose", "Investigate the renderer seam"),
        ...assistantTextStreamed("Scanning src/render for entry points…", "T1"),
        // The subagent's OWN internal tool call (parent "T1") — its matching tool_result below
        // correlates to THIS tool_use id, so the child flow is self-consistent (no orphan result).
        assistantToolUse("subtool-1", "Grep", { pattern: "renderInto", path: "src/render" }, "T1"),
        userToolResult("subtool-1", "found renderInto(...)", false, "T1"),
        ...assistantTextStreamed("Investigation complete.", null),
        resultSuccess("Fanout done."),
      ),
    ],
  },
  {
    name: "quota-rate-limit",
    attempts: [
      frames(
        sysInit(),
        // epoch-ms (>= 1e12) so it passes through extractResetAt unchanged.
        rateLimitRejected(FIXED_RESET_EPOCH_MS),
      ),
    ],
  },
  {
    name: "quota-result",
    attempts: [
      frames(
        sysInit(),
        // The rejected event pins the reset instant: without it, decideResultQuota falls back to
        // parseClockTimeInTz on the wall string against Date.now() — a resetAt that rolls daily
        // (nondeterministic goldens). In the live pipeline index.ts pauses (gracefulExit 0) on the
        // rejected event's own quota_exceeded frame, so the trailing result-carrier is consumed only
        // by the in-process tests (which drive every message through normalize).
        rateLimitRejected(FIXED_RESET_EPOCH_MS),
        resultUsageLimit(SESSION_LIMIT_TEXT),
      ),
    ],
  },
  {
    name: "overloaded-retry",
    attempts: [
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(sysInit(), assistantText("Recovered after backoff."), resultSuccess("Succeeded on retry.")),
    ],
  },
  {
    name: "overloaded-exhausted",
    // 7 attempts of pre-output 529 — past BACKOFF_MAX_RETRIES (6) → decideBackoff exhaustion.
    attempts: [
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(resultOverload529()),
      frames(resultOverload529()),
    ],
  },
  {
    name: "permission-denied",
    attempts: [
      frames(
        sysInit(),
        permissionDenied(
          "Write",
          "emu-denied-1",
          "Write to /etc/hosts is outside the allowed prototype directory.",
        ),
        resultSuccess("Turn ended after a denied write."),
      ),
    ],
  },
  {
    name: "error-midstream",
    attempts: [
      frames(
        sysInit(),
        assistantText("Starting the task…"),
        resultError("error_during_execution", "the tool crashed mid-turn"),
      ),
    ],
  },
  {
    name: "overloaded-midturn",
    // The 529 arrives AFTER rendered output (assistant_text) — index.ts's mid-turn branch: an
    // out-of-band `status` + the synthetic overloadResultFrame, NO retry (a single attempt is the
    // proof: a retry would re-query and clamp to this same attempt, duplicating frames).
    attempts: [
      frames(
        sysInit(),
        assistantText("Partial answer before the overload hit."),
        resultOverload529(),
      ),
    ],
  },
  {
    name: "auth-failure",
    // Throw an auth-shaped error (matches index.ts's isAuth /auth|token|unauthor|401|oauth/i) →
    // fatal `error` frame error_kind:"auth", exit 1.
    attempts: [
      {
        kind: "throw",
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
        kind: "throw",
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
        kind: "throw",
        messages: [sysInit(), assistantText("Working on it…")],
        thenThrow: () => new Error(STREAM_ABORT_ERROR_MESSAGE),
      },
    ],
  },
  {
    // resume-silent-recover: a wedged first-frame resume must recover to a terminal `result` (attempt
    // 0 hangs → first-frame watchdog → fresh no-resume retry completes). See index.ts firstFrameWatchdog.
    name: "resume-silent-recover",
    resumeTranscriptExists: true,
    attempts: [
      { kind: "hang" },
      frames(
        sysInit(),
        ...assistantTextStreamed("Recovered on a fresh start after the silent resume."),
        resultSuccess("Recovered after resume timeout."),
      ),
    ],
  },
  {
    // resume-silent-exhausted: when BOTH the resume attempt and its fresh retry hang, the sidecar must
    // still terminate — a loud fatal `error`, exit 1. See index.ts firstFrameWatchdog.
    name: "resume-silent-exhausted",
    resumeTranscriptExists: true,
    attempts: [{ kind: "hang" }, { kind: "hang" }],
  },
  {
    // resume-idle-until-input: a resume parked at a gate re-presentation gets NO user message for a
    // while — the watchdog must NOT arm — then a late message completes to a clean `result`. The
    // `await-input` attempt is silent until that message, so an arm-at-query-start watchdog would
    // double-fatal in the quiet window; arm-on-first-input completes cleanly. See index.ts firstFrameWatchdog.
    name: "resume-idle-until-input",
    resumeTranscriptExists: true,
    attempts: [
      {
        kind: "await-input",
        messages: [
          sysInit(),
          ...assistantTextStreamed("Handled the gate after the late message arrived."),
          resultSuccess("Resumed and completed after idle."),
        ],
      },
    ],
  },
];

export const EMULATOR_SCENARIOS: Record<string, EmulatorScenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.name, s]),
);

export const SCENARIO_NAMES: string[] = SCENARIOS.map((s) => s.name);
