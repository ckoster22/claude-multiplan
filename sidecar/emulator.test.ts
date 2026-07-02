// Falsifiable, TOKEN-FREE integration tests for the scripted-fixture LLM emulator (SEAM A).
//
// THE BEHAVIOR UNDER TEST: each named scenario's RAW SDKMessage fixtures, when driven through the
// REAL sidecar pipeline functions (createNormalizer().normalize, isOverloadedMessage,
// decideRateLimitFrame, decideResultQuota, decideBackoff), produce the EXACT committed agent-stream
// frames the live sidecar would emit. This is the SEAM-A value: it exercises the real normalize/quota/
// overload/backoff logic against fixed, diffable fixtures — zero tokens, fully reproducible.
//
// We import the emulator modules + the real pipeline functions directly. We do NOT import index.ts —
// it is not vitest-importable (at import it embeds the `claude` binary via `with { type: "file" }`
// AND installs a stdin readline loop + SIGTERM/SIGINT handlers; see normalize.test.ts:15-18). So the
// index.ts retry CONTROL FLOW (break→backoff→re-query()) is covered by the manual spawned-binary
// recipe (Phase 3); these tests prove the PREDICATES that loop depends on.
//
// FALSIFY discipline (mirrors normalize.test.ts): every behavioral assertion below was proven RED by
// temporarily breaking the fixture/input, then restored to GREEN. The `// FALSIFY:` comments record
// the exact break that turns each assertion red.

import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createNormalizer, isOverloadedMessage, type SeqCounter } from "./normalize";
import { decideRateLimitFrame, decideResultQuota, parseResetFromError } from "./quota";
import { decideBackoff, BACKOFF_MAX_RETRIES } from "./backoff";
import {
  selectEmulatorScenario,
  makeEmulatorQuery,
  EMU_BACKOFF_MS,
} from "./emulator";
import {
  EMULATOR_SCENARIOS,
  SCENARIO_NAMES,
  SESSION_LIMIT_TEXT,
  FIXED_RESET_EPOCH_MS,
  AUTH_ERROR_MESSAGE,
  THROWN_QUOTA_ERROR_MESSAGE,
  STREAM_ABORT_ERROR_MESSAGE,
  attemptMessages,
  resultOverload529,
  resultSuccess,
  assistantOverloaded,
  assistantText,
} from "./emulator-scenes";

/** Fresh normalizer per call so the seq counter / throttle state never bleeds across cases. */
function freshNormalize() {
  const seq: SeqCounter = { value: 0 };
  const { normalize } = createNormalizer({ seq, logErr: () => {} });
  return normalize;
}

/** Drive a whole attempt's raw messages through ONE normalizer and flatten the emitted frames —
 *  exactly as index.ts's consume loop does (minus the in-band 529 short-circuit, asserted separately). */
function runAttempt(messages: SDKMessage[]): Array<Record<string, unknown>> {
  const normalize = freshNormalize();
  const frames: Array<Record<string, unknown>> = [];
  for (const m of messages) frames.push(...normalize(m));
  return frames;
}

/** The attempts[0] message stream of a named scenario (the common single-attempt case). */
function scenarioAttempt0(name: string): SDKMessage[] {
  return attemptMessages(EMULATOR_SCENARIOS[name].attempts[0]);
}

// ---------------------------------------------------------------------------
// Selector — pure env reader (mirrors optionOverridesFromEnv's whitelist guard).
// ---------------------------------------------------------------------------
describe("selectEmulatorScenario — env whitelist guard", () => {
  it("a known EMU_SCENARIO selects that scenario", () => {
    const s = selectEmulatorScenario({ EMU_SCENARIO: "happy-text" });
    // FALSIFY: return null for a known name → s is null → RED.
    expect(s).not.toBeNull();
    expect(s!.name).toBe("happy-text");
  });

  it("unset env → null (real query() runs)", () => {
    // FALSIFY: return any scenario for unset env → non-null → RED (emulator would silently activate).
    expect(selectEmulatorScenario({})).toBeNull();
  });

  it("an unknown EMU_SCENARIO → null (NOT a silent partial match)", () => {
    // FALSIFY: point env at a non-existent name and assert non-null — proves unknown ↛ activation.
    expect(selectEmulatorScenario({ EMU_SCENARIO: "bogus" })).toBeNull();
    // An empty string is also "unset" (length-0 guard).
    expect(selectEmulatorScenario({ EMU_SCENARIO: "" })).toBeNull();
  });

  it("every registered name resolves (registry/SCENARIO_NAMES are consistent)", () => {
    for (const name of SCENARIO_NAMES) {
      expect(selectEmulatorScenario({ EMU_SCENARIO: name })!.name).toBe(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Mechanism — the fake Query: per-attempt streams + async-iterability + no-op control stubs.
// ---------------------------------------------------------------------------
describe("makeEmulatorQuery — per-attempt fake Query", () => {
  async function collect(q: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const out: SDKMessage[] = [];
    for await (const m of q) out.push(m);
    return out;
  }

  it("successive calls return DISTINCT scripted streams (attempt 0 ≠ attempt 2)", async () => {
    const make = makeEmulatorQuery(EMULATOR_SCENARIOS["overloaded-retry"]);
    const a0 = await collect(make({ prompt: "ignored" }) as AsyncIterable<SDKMessage>);
    make({ prompt: "ignored" }); // attempt 1 (also an overload) — advance the closure index.
    const a2 = await collect(make({ prompt: "ignored" }) as AsyncIterable<SDKMessage>);

    // Attempt 0 is the PRE-OUTPUT 529 (a single overload message); attempt 2 is the recovery turn.
    // FALSIFY: have makeEmulatorQuery ignore attemptIndex (always return attempts[0]) → a2 === a0 → RED.
    expect(isOverloadedMessage(a0[0])).toBe(true);
    expect(a0.length).toBe(1);
    expect(a2.length).toBeGreaterThan(1);
    expect(isOverloadedMessage(a2[0])).toBe(false);
    // Distinct streams: attempt 0's first message is an overload result; attempt 2's first is sysInit.
    expect((a0[0] as { type?: string }).type).toBe("result");
    expect((a2[0] as { type?: string }).type).toBe("system");
  });

  it("past the last attempt, repeats the LAST attempt (min clamp)", async () => {
    const make = makeEmulatorQuery(EMULATOR_SCENARIOS["overloaded-retry"]);
    make({ prompt: "x" }); // 0
    make({ prompt: "x" }); // 1
    const a2 = await collect(make({ prompt: "x" }) as AsyncIterable<SDKMessage>); // 2 (last)
    const a3 = await collect(make({ prompt: "x" }) as AsyncIterable<SDKMessage>); // 3 → clamps to 2
    // FALSIFY: drop the Math.min clamp → attempts[3] is undefined → the for-await throws → RED.
    expect(a3.map((m) => (m as { type?: string }).type)).toEqual(
      a2.map((m) => (m as { type?: string }).type),
    );
  });

  it("a throw-tailed attempt yields its messages THEN throws out of the iteration", async () => {
    const make = makeEmulatorQuery(EMULATOR_SCENARIOS["auth-failure"]);
    const q = make({ prompt: "x" }) as AsyncIterable<SDKMessage>;
    const seen: SDKMessage[] = [];
    // FALSIFY: drop the `if (thenThrow) throw thenThrow()` tail in makeEmulatorQuery → the
    // iteration completes normally → `.rejects` fails → RED.
    await expect(
      (async () => {
        for await (const m of q) seen.push(m);
      })(),
    ).rejects.toThrow(AUTH_ERROR_MESSAGE);
    // The scripted messages were yielded BEFORE the throw (index.ts emits them, THEN catches).
    expect(seen.length).toBe(1);
    expect((seen[0] as { type?: string }).type).toBe("system");
  });

  it("the fake Query exposes async iteration + no-op interrupt/setPermissionMode", async () => {
    const make = makeEmulatorQuery(EMULATOR_SCENARIOS["happy-text"]);
    const q = make({ prompt: "x" }) as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<SDKMessage>;
      interrupt: () => Promise<void>;
      setPermissionMode: (m: string) => Promise<void>;
    };
    // FALSIFY: omit the Object.assign stubs → these are undefined → calling them throws → RED.
    expect(typeof q.interrupt).toBe("function");
    expect(typeof q.setPermissionMode).toBe("function");
    expect(typeof q[Symbol.asyncIterator]).toBe("function");
    // The stubs resolve without throwing (no-ops, exactly as index.ts's drain/mode-flip expect).
    await expect(q.interrupt()).resolves.toBeUndefined();
    await expect(q.setPermissionMode("default")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// happy-text — streaming assistant text + terminal result.
// ---------------------------------------------------------------------------
describe("scenario happy-text — assistant_text frames + result", () => {
  it("emits two assistant_text frames then a success result", () => {
    const frames = runAttempt(scenarioAttempt0("happy-text"));
    const kinds = frames.map((f) => f.kind);
    // system_init, assistant_text, assistant_text, result.
    // FALSIFY: drop one assistantText fixture → only one assistant_text frame → RED.
    expect(kinds).toEqual(["system_init", "assistant_text", "assistant_text", "result"]);
    const texts = frames.filter((f) => f.kind === "assistant_text").map((f) => f.text);
    expect(texts).toEqual([
      "Here is the first part of my answer.",
      "And here is the conclusion.",
    ]);
    const result = frames.find((f) => f.kind === "result")!;
    expect(result.is_error).toBe(false);
    expect(result.result).toBe("All done.");
  });
});

// ---------------------------------------------------------------------------
// tool-call — tool_use ↔ tool_result correlation by id.
// ---------------------------------------------------------------------------
describe("scenario tool-call — tool_use/tool_result id correlation", () => {
  it("the tool_result.tool_use_id matches the tool_use.id", () => {
    const frames = runAttempt(scenarioAttempt0("tool-call"));
    const toolUse = frames.find((f) => f.kind === "tool_use")!;
    const toolResult = frames.find((f) => f.kind === "tool_result")!;
    expect(toolUse.tool).toBe("Bash");
    expect(toolUse.id).toBe("emu-tool-1");
    // The correlation invariant the frontend keys a tool row's completion on.
    // FALSIFY: mismatch the ids in the fixture (e.g. userToolResult("WRONG", …)) → this fails → RED.
    expect(toolResult.tool_use_id).toBe(toolUse.id);
    expect(toolResult.is_error).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// plan-write / prototype-write — the write tool flows (paths borrowed from app conventions).
// ---------------------------------------------------------------------------
describe("scenario plan-write / prototype-write — Write tool flows", () => {
  it("plan-write drives a Write to a plans path, correlated result, success", () => {
    const frames = runAttempt(scenarioAttempt0("plan-write"));
    const toolUse = frames.find((f) => f.kind === "tool_use")!;
    expect(toolUse.tool).toBe("Write");
    // FALSIFY: change the fixture's file_path to a non-plans dir → this assertion fails → RED.
    expect((toolUse.input as { file_path: string }).file_path).toContain("/.claude/plans/");
    const result = frames.find((f) => f.kind === "result")!;
    expect(result.is_error).toBe(false);
  });

  it("prototype-write drives a Write under .plan-tree/prototype/", () => {
    const frames = runAttempt(scenarioAttempt0("prototype-write"));
    const toolUse = frames.find((f) => f.kind === "tool_use")!;
    expect(toolUse.tool).toBe("Write");
    // FALSIFY: point the fixture path outside the prototype dir → this fails → RED.
    expect((toolUse.input as { file_path: string }).file_path).toContain("/.plan-tree/prototype/");
  });
});

// ---------------------------------------------------------------------------
// review-cycle — the review-bar flow (ExitPlanMode tool_use + result).
// ---------------------------------------------------------------------------
describe("scenario review-cycle — review tool flow", () => {
  it("emits an assistant_text, an ExitPlanMode tool_use, a tool_result, then success", () => {
    const frames = runAttempt(scenarioAttempt0("review-cycle"));
    const kinds = frames.map((f) => f.kind);
    expect(kinds).toEqual([
      "system_init",
      "assistant_text",
      "tool_use",
      "tool_result",
      "result",
    ]);
    const toolUse = frames.find((f) => f.kind === "tool_use")!;
    // FALSIFY: rename the fixture's tool from ExitPlanMode → this fails → RED.
    expect(toolUse.tool).toBe("ExitPlanMode");
    expect((toolUse.input as { plan?: string }).plan).toContain("Plan under review");
  });
});

// ---------------------------------------------------------------------------
// subagent-fanout — depth-2 subagent_started + parent_tool_use_id nesting.
// ---------------------------------------------------------------------------
describe("scenario subagent-fanout — subagent_started + parent nesting", () => {
  it("emits a subagent_started keyed by the Task tool_use id, with children nested under it", () => {
    const frames = runAttempt(scenarioAttempt0("subagent-fanout"));

    const taskUse = frames.find((f) => f.kind === "tool_use" && f.tool === "Task")!;
    const started = frames.find((f) => f.kind === "subagent_started")!;
    // The subagent_started's tool_use_id is the SAME id the parent Task tool_use carries — the
    // frontend keys the subagent group off it.
    // FALSIFY: change taskStarted's tool_use_id to a different value → this fails → RED.
    expect(started.tool_use_id).toBe(taskUse.id);
    expect(started.tool_use_id).toBe("T1");
    expect(started.subagent_type).toBe("general-purpose");

    // The child frames (the nested assistant_text + tool_result) carry parent_tool_use_id === that id.
    const childText = frames.find(
      (f) => f.kind === "assistant_text" && f.parent_tool_use_id === "T1",
    );
    const childResult = frames.find(
      (f) => f.kind === "tool_result" && f.parent_tool_use_id === "T1",
    );
    // FALSIFY: null the parent in the assistantText("…","T1") fixture → childText undefined → RED.
    expect(childText).toBeDefined();
    expect(childResult).toBeDefined();

    // The child tool_result correlates to the subagent's OWN internal tool_use (parent "T1"), not
    // to the parent Task — so the subagent's internal flow is self-consistent (no orphan result).
    const childToolUse = frames.find(
      (f) => f.kind === "tool_use" && f.parent_tool_use_id === "T1",
    )!;
    // FALSIFY: drop the child assistantToolUse("subtool-1",…,"T1") fixture → childToolUse undefined → RED.
    expect(childToolUse).toBeDefined();
    expect(childToolUse.tool).toBe("Grep");
    expect(childToolUse.id).toBe("subtool-1");
    expect(childResult!.tool_use_id).toBe(childToolUse.id);

    // The trailing top-level assistant_text returns to parent null (out of the subagent group).
    const topText = frames.filter(
      (f) => f.kind === "assistant_text" && f.parent_tool_use_id === null,
    );
    expect(topText.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// quota-rate-limit / quota-result — the two quota carriers → quota_exceeded.
// ---------------------------------------------------------------------------
describe("scenario quota-rate-limit — rate_limit_event → quota_exceeded", () => {
  it("the rejected rate_limit_event normalizes to a quota_exceeded frame", () => {
    const frames = runAttempt(scenarioAttempt0("quota-rate-limit"));
    const quota = frames.find((f) => f.kind === "quota_exceeded")!;
    // FALSIFY: change the fixture status to "allowed" → decideRateLimitFrame returns {quota:false}
    // → no quota_exceeded frame → RED.
    expect(quota).toBeDefined();
    expect(quota.source).toBe("rate_limit_event");
    expect(quota.resetAt).toBe(1_750_000_000_000);

    // Cross-check the decider directly against the raw fixture info (the value normalize reads).
    const raw = scenarioAttempt0("quota-rate-limit")[1] as unknown as {
      rate_limit_info: unknown;
    };
    expect(decideRateLimitFrame(raw.rate_limit_info)).toEqual({
      quota: true,
      resetAt: 1_750_000_000_000,
      source: "rate_limit_event",
    });
  });
});

describe("scenario quota-result — usage-limit result → quota_exceeded", () => {
  it("the usage-limit result normalizes to a quota_exceeded frame pinned by the structured resetsAt", () => {
    const frames = runAttempt(scenarioAttempt0("quota-result"));
    // The preceding rejected rate_limit_event pins the reset instant: the normalizer retains its
    // structured resetsAt (lastRateLimitInfo), so decideResultQuota takes the structured-reuse
    // branch instead of parsing the wall string against an implicit Date.now() (which rolls daily).
    // Two quota frames result IN-PROCESS (the event's own + the result-carrier's); the LIVE
    // pipeline pauses on the first (index.ts gracefulExit(0) on any quota_exceeded).
    const quotas = frames.filter((f) => f.kind === "quota_exceeded");
    expect(quotas.length).toBe(2);
    expect(quotas[0].source).toBe("rate_limit_event");
    // FALSIFY: change the fixture string to a NON-limit string → isUsageLimitText false → a plain
    // `result` frame instead of the second quota_exceeded → RED.
    expect(quotas[1].source).toBe("result_error");
    // Deterministic: BOTH carry the pinned epoch, never a Date.now()-dependent parse.
    // FALSIFY: drop the rateLimitRejected fixture → the result-carrier resetAt comes from
    // parseClockTimeInTz(Date.now()) ≠ the pinned epoch → RED.
    expect(quotas[0].resetAt).toBe(FIXED_RESET_EPOCH_MS);
    expect(quotas[1].resetAt).toBe(FIXED_RESET_EPOCH_MS);
    // And the usage-limit result is NOT a plain result.
    expect(frames.some((f) => f.kind === "result")).toBe(false);
  });

  it("decideResultQuota pins the exact resetAt for a fixed nowMs (hermetic, no Date.now race)", () => {
    // Lock the EXACT value by injecting a pinned `nowMs` into BOTH the expectation and the decider —
    // hermetic because nothing here reads the wall clock. The reset clause is "resets 2:10pm
    // (America/Chicago)"; with nowMs at 2026-06-26T12:00:00Z (07:00 CDT, BEFORE 2:10pm CDT), the
    // reset is TODAY 2:10pm CDT = 19:10:00Z = Date.UTC(2026, 5, 26, 19, 10, 0).
    const nowMs = Date.UTC(2026, 5, 26, 12, 0, 0); // 2026-06-26T12:00:00Z
    const expectedResetAt = Date.UTC(2026, 5, 26, 19, 10, 0); // 2:10pm America/Chicago (CDT, UTC-5)
    const decision = decideResultQuota(SESSION_LIMIT_TEXT, null, nowMs);
    expect(decision.source).toBe("result_error");
    // FALSIFY: change the expected to +24h (or any other instant) → the pinned decider value differs → RED.
    expect(decision.resetAt).toBe(expectedResetAt);
  });
});

// ---------------------------------------------------------------------------
// overloaded-retry — the predicates index.ts's retry loop depends on (NOT the loop control flow).
// ---------------------------------------------------------------------------
describe("scenario overloaded-retry — overload predicate + backoff schedule", () => {
  it("attempts[0][0] is an in-band 529 overload (pre-output → retryable)", () => {
    const a0 = attemptMessages(EMULATOR_SCENARIOS["overloaded-retry"].attempts[0]);
    // FALSIFY: replace resultOverload529() with a plain resultSuccess() → isOverloadedMessage false → RED.
    expect(isOverloadedMessage(a0[0])).toBe(true);
    // It is the FIRST message of the attempt → nothing emitted yet → index.ts treats it as retryable.
    expect(a0.length).toBe(1);
  });

  it("the recovery attempt (index 2) is NOT an overload → the loop stops retrying", () => {
    const a2 = attemptMessages(EMULATOR_SCENARIOS["overloaded-retry"].attempts[2]);
    // FALSIFY: make a2[0] a resultOverload529() → isOverloadedMessage true → the loop would retry → RED.
    expect(isOverloadedMessage(a2[0])).toBe(false);
    const frames = runAttempt(a2);
    expect(frames.some((f) => f.kind === "result" && f.is_error === false)).toBe(true);
  });

  it("decideBackoff yields increasing finite delays across retries 1 and 2", () => {
    const t = 1_750_000_000_000;
    const d1 = decideBackoff(1, t);
    const d2 = decideBackoff(2, t);
    expect(d1.kind).toBe("retry");
    expect(d2.kind).toBe("retry");
    if (d1.kind === "retry" && d2.kind === "retry") {
      expect(Number.isFinite(d1.delayMs)).toBe(true);
      // FALSIFY: make backoff constant (drop the 2**(retry-1) growth) → d2.delayMs === d1.delayMs → RED.
      expect(d2.delayMs).toBeGreaterThan(d1.delayMs);
    }
  });

  it("EMU_BACKOFF_MS clamps the real delay to a tiny value (the emulator's fast-retry cap)", () => {
    const t = 1_750_000_000_000;
    const d1 = decideBackoff(1, t);
    if (d1.kind === "retry") {
      // index.ts under the emulator computes Math.min(decision.delayMs, EMU_BACKOFF_MS).
      // FALSIFY: raise EMU_BACKOFF_MS above the real delay → the clamp would NOT shrink it → RED.
      expect(Math.min(d1.delayMs, EMU_BACKOFF_MS)).toBe(EMU_BACKOFF_MS);
      expect(EMU_BACKOFF_MS).toBeLessThan(d1.delayMs);
    }
  });
});

// ---------------------------------------------------------------------------
// overloaded-exhausted — decideBackoff exhaustion past BACKOFF_MAX_RETRIES.
// ---------------------------------------------------------------------------
describe("scenario overloaded-exhausted — backoff exhaustion", () => {
  it("the scenario scripts 7 pre-output overload attempts (one past BACKOFF_MAX_RETRIES)", () => {
    const sc = EMULATOR_SCENARIOS["overloaded-exhausted"];
    // 7 attempts → retries 1..6 are real, retry 7 exhausts (BACKOFF_MAX_RETRIES = 6).
    expect(sc.attempts.length).toBe(BACKOFF_MAX_RETRIES + 1);
    for (const att of sc.attempts) {
      expect(isOverloadedMessage(attemptMessages(att)[0])).toBe(true);
    }
  });

  it("decideBackoff(7) is exhausted; decideBackoff(6) is NOT", () => {
    const t = 1_750_000_000_000;
    // FALSIFY: assert retry 6 IS exhausted → it reports {kind:"retry"} → RED (proves the boundary).
    expect(decideBackoff(BACKOFF_MAX_RETRIES, t).kind).toBe("retry");
    expect(decideBackoff(BACKOFF_MAX_RETRIES + 1, t).kind).toBe("exhausted");
  });
});

// ---------------------------------------------------------------------------
// permission-denied — raw system/permission_denied → permission_denied frame.
// ---------------------------------------------------------------------------
describe("scenario permission-denied — system/permission_denied → permission_denied frame", () => {
  it("normalizes to a permission_denied frame carrying tool/tool_use_id/message", () => {
    const frames = runAttempt(scenarioAttempt0("permission-denied"));
    const denied = frames.find((f) => f.kind === "permission_denied")!;
    expect(denied).toBeDefined();
    // normalize.ts:180 maps the RAW `tool_name` field onto the frame's `tool` key.
    // FALSIFY: build the fixture with the flat `tool` field (scenes.ts shape) instead of `tool_name`
    // → normalize reads msg.tool_name → undefined → frame.tool is null → this fails → RED.
    expect(denied.tool).toBe("Write");
    expect(denied.tool_use_id).toBe("emu-denied-1");
    expect(denied.message).toContain("outside the allowed prototype directory");
  });

  it("dropping the system subtype yields NO permission_denied frame (falsify)", () => {
    // FALSIFY proof: a system message with NO subtype must not normalize to permission_denied.
    const normalize = freshNormalize();
    const frames = normalize({ type: "system" } as unknown as SDKMessage);
    expect(frames.some((f) => f.kind === "permission_denied")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// error-midstream — is_error result → a plain result frame (NOT quota, NOT overload).
// ---------------------------------------------------------------------------
describe("scenario error-midstream — is_error result is a plain result (not quota/overload)", () => {
  it("normalizes to a result frame with is_error:true and is NOT misclassified", () => {
    const messages = scenarioAttempt0("error-midstream");
    const frames = runAttempt(messages);
    const result = frames.find((f) => f.kind === "result")!;
    expect(result).toBeDefined();
    expect(result.is_error).toBe(true);
    expect(result.subtype).toBe("error_during_execution");
    expect(result.result).toBe("the tool crashed mid-turn");
    // It must NOT be a quota frame…
    // FALSIFY: give the fixture a usage-limit string (isUsageLimitText true) → it becomes
    // quota_exceeded → this fails → RED.
    expect(frames.some((f) => f.kind === "quota_exceeded")).toBe(false);
    // …and the terminal error message must NOT trip the overload predicate.
    const terminal = messages[messages.length - 1];
    expect(isOverloadedMessage(terminal)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: the overload fixtures used elsewhere behave as the predicate expects (guards drift).
// ---------------------------------------------------------------------------
describe("emulator-scenes overload fixtures — predicate alignment", () => {
  it("resultOverload529() is an overload; resultSuccess() is not", () => {
    expect(isOverloadedMessage(resultOverload529())).toBe(true);
    expect(isOverloadedMessage(resultSuccess())).toBe(false);
  });

  it("assistantOverloaded() is an overload (branch 1: assistant error:\"overloaded\"); plain assistantText() is not", () => {
    // Drives isOverloadedMessage branch (1) — the assistant-message overload carrier
    // (normalize.ts:75, m.type==="assistant" && m.error==="overloaded"), the dual of the
    // result-carrier branch (2) above. The plain assistantText control keeps it falsifiable.
    // FALSIFY: assert `.toBe(false)` here → the real carrier IS an overload → RED.
    expect(isOverloadedMessage(assistantOverloaded())).toBe(true);
    // FALSIFY: assert `.toBe(true)` here → a plain assistant text is NOT an overload → RED.
    expect(isOverloadedMessage(assistantText("just some prose"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// overloaded-midturn — the 529 carrier is positioned AFTER rendered output, so index.ts's
// emittedAnyFrame gate routes it to the mid-turn branch (status + synthetic result, NO retry).
// The frame emissions themselves are asserted at the spawned-binary tier (emulator-e2e.test.ts).
// ---------------------------------------------------------------------------
describe("scenario overloaded-midturn — overload AFTER rendered output", () => {
  it("the 529 carrier follows a renderable assistant_text (mid-turn, not pre-output)", () => {
    const msgs = scenarioAttempt0("overloaded-midturn");
    const overloadIdx = msgs.findIndex((m) => isOverloadedMessage(m));
    // FALSIFY: move resultOverload529() to the front of the fixture → overloadIdx 0 / no
    // preceding assistant_text → RED (the scenario would exercise the pre-output retry instead).
    expect(overloadIdx).toBeGreaterThan(0);
    const before = runAttempt(msgs.slice(0, overloadIdx));
    expect(before.some((f) => f.kind === "assistant_text")).toBe(true);
    // Single attempt — the mid-turn branch must never re-query (a retry would clamp back onto
    // this same attempt and duplicate the already-emitted text).
    expect(EMULATOR_SCENARIOS["overloaded-midturn"].attempts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Thrown-error scenarios — the PURE classification index.ts's catch block applies to the exact
// thrown texts. (The resulting frame emissions + exit codes are asserted at the e2e tier.)
// ---------------------------------------------------------------------------
describe("thrown-error scenarios — catch-block classification of the thrown texts", () => {
  // index.ts stringifies the caught Error, so the classified text carries the "Error: " prefix.
  const asThrown = (msg: string) => "Error: " + msg;

  it("auth-failure's text is auth-shaped — the quota backstop refuses it", () => {
    // parseResetFromError's auth guard returns null FIRST, so even if index.ts's isAuth were
    // bypassed this text could never be misclassified as a pausable quota.
    // FALSIFY: strip the auth words from AUTH_ERROR_MESSAGE (leaving digits) → the guard no longer
    // fires → RED.
    expect(parseResetFromError(asThrown(AUTH_ERROR_MESSAGE))).toBeNull();
  });

  it("thrown-quota's text parses to the pinned, Date.now()-independent resetAt", () => {
    // The bare-epoch branch must not consult nowMs — inject two absurd values and expect the SAME
    // pinned instant from both.
    // FALSIFY: reword the fixture to a relative form ("retry-after: 60") → the parse becomes
    // nowMs + 60s → the two calls disagree → RED.
    expect(parseResetFromError(asThrown(THROWN_QUOTA_ERROR_MESSAGE), 0)).toBe(FIXED_RESET_EPOCH_MS);
    expect(parseResetFromError(asThrown(THROWN_QUOTA_ERROR_MESSAGE), 9_999_999_999_999)).toBe(
      FIXED_RESET_EPOCH_MS,
    );
  });

  it("stream-abort's text is neither auth nor quota-parseable → falls to the fatal sdk path", () => {
    // FALSIFY: embed a 13-digit epoch in STREAM_ABORT_ERROR_MESSAGE → parseResetFromError returns
    // it → index.ts would pause instead of dying → RED.
    expect(parseResetFromError(asThrown(STREAM_ABORT_ERROR_MESSAGE))).toBeNull();
  });
});
