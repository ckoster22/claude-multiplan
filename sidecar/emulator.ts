// Scripted stand-in for the SDK's `query()`, so tests and token-free runs drive the real sidecar
// pipeline (normalize → quota/backoff/permissions → wire framing → stdout) against fixed fixtures.
// Imports ONLY types (`import type`, never the SDK's `query()`) so index.ts can swap it in at boot
// and vitest can import it in-process.

import type {
  Query,
  SDKMessage,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EMULATOR_SCENARIOS, attemptMessages, type EmulatorScenario } from "./emulator-scenes";

// Backoff cap index.ts clamps the real 1–30min schedule to while the emulator is active, so the
// retry path runs fast yet genuinely. Inert when EMU_SCENARIO is unset (the clamp is gated on a
// non-null `emulatorScenario`).
export const EMU_BACKOFF_MS = 10;

// Resume first-frame watchdog bound index.ts clamps its real ~30s ceiling to while the emulator is
// active, so a scripted `{ kind: "hang" }` attempt trips the watchdog fast yet genuinely. Small but
// non-trivial so it comfortably outlasts a healthy fresh-retry's first frame (which the emulator
// yields synchronously) — the recovery must NEVER false-trip on its own retry.
export const EMU_RESUME_TIMEOUT_MS = 100;

/**
 * Returns the registry scenario matching `env.EMU_SCENARIO`, or `null` for unset/unknown. An unknown
 * name MUST fall through to `null` (the real `query()`), never silently activate the emulator.
 */
export function selectEmulatorScenario(
  env: Record<string, string | undefined>,
): EmulatorScenario | null {
  const name = env.EMU_SCENARIO;
  if (name === undefined || name.length === 0) return null;
  return EMULATOR_SCENARIOS[name] ?? null;
}

// Structurally typed to match `query`'s call signature; the args are ignored (fully scripted).
interface QueryArgs {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}

/**
 * Build a fake `query()` from a scenario. A closure `attemptIndex` advances per call, so a backoff
 * RETRY gets the NEXT attempt and repeats the last once past the end. A `{ kind: "throw" }` attempt
 * yields its messages then throws, landing in index.ts's consume-loop catch exactly like a thrown
 * SDK error.
 *
 * The `as unknown as Query` cast is load-bearing and safe: index.ts's only runtime use of the query
 * is async iteration, `interrupt()`, `setPermissionMode()`, and an optional `close?.()`; the stubs
 * below cover those, and the ~15 other `Query` methods are never called.
 */
export function makeEmulatorQuery(
  scenario: EmulatorScenario,
): (args: QueryArgs) => Query {
  let attemptIndex = 0;
  const last = scenario.attempts.length - 1;

  return function emulatorQuery(_args: QueryArgs): Query {
    const attempt = scenario.attempts[Math.min(attemptIndex++, last)];
    const messages = attemptMessages(attempt);
    const hang = attempt.kind === "hang";
    const thenThrow = attempt.kind === "throw" ? attempt.thenThrow : null;

    async function* gen(): AsyncGenerator<SDKMessage> {
      // A "hang" attempt never settles its first `.next()` (see index.ts firstFrameWatchdog). The
      // never-settling promise registers no timer/handle, so it does not pin the event loop once
      // index.ts abandons this iterator on its first-frame timeout.
      if (hang) await new Promise<never>(() => {});
      for (const msg of messages) {
        yield msg;
      }
      if (thenThrow) throw thenThrow();
    }

    const q = gen();
    return Object.assign(q, {
      interrupt: async () => {},
      setPermissionMode: async (_mode: unknown) => {},
      setModel: async (_model?: unknown) => {},
      setMaxThinkingTokens: async (_n: number) => {},
    }) as unknown as Query;
  };
}
