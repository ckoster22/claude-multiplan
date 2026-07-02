// Scripted-fixture LLM emulator — the MECHANISM (SEAM A).
//
// Stands in for the SDK's `query()` so tests / token-free runs exercise the REAL sidecar pipeline
// (normalize → quota/backoff/permissions → wire framing → stdout JSON-lines → Rust → frontend)
// against fixed, diffable fixtures. SDK-RUNTIME-FREE: imports ONLY TYPES (`import type`), never the
// SDK's `query()`, so `index.ts` can swap it in at boot AND vitest can import it in-process.
//
// Mirrors two in-repo precedents:
//   - sidecar/env-overrides.ts (`optionOverridesFromEnv`) — a PURE, whitelist-guarded env→behavior
//     reader. `selectEmulatorScenario` mirrors it: unset/unknown EMU_SCENARIO → null (no swap).
//   - src/mock/fixtures/scenes.ts — a named-deterministic-sequence registry (here: raw SDKMessages).

import type {
  Query,
  SDKMessage,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { EMULATOR_SCENARIOS, attemptMessages, type EmulatorScenario } from "./emulator-scenes";

// The compressed backoff cap used ONLY when the emulator is active (index.ts clamps the real 1–30min
// schedule to this so the retry path stays genuinely exercised but fast). Inert when EMU_SCENARIO is
// unset (index.ts gates the clamp on `emulatorScenario` being non-null).
export const EMU_BACKOFF_MS = 10;

/**
 * Pure env reader (mirrors optionOverridesFromEnv): reads `env.EMU_SCENARIO` and returns the matching
 * registry scenario, or `null` for an unset/unknown value (the whitelist guard — an unknown name MUST
 * fall through to the real `query()`, never silently activate the emulator).
 */
export function selectEmulatorScenario(
  env: Record<string, string | undefined>,
): EmulatorScenario | null {
  const name = env.EMU_SCENARIO;
  if (name === undefined || name.length === 0) return null;
  return EMULATOR_SCENARIOS[name] ?? null;
}

// The argument shape index.ts passes to query(): `{ prompt, options }`. The fake ignores both
// (the scenario is fully scripted) — typed structurally so it matches `query`'s call signature.
interface QueryArgs {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}

/**
 * Build a fake `query()` from a scenario. Returns a function with `query`'s signature. Holds a closure
 * `attemptIndex`; each call picks `scenario.attempts[min(attemptIndex++, last)]` (so a backoff RETRY
 * gets the NEXT attempt; once past the last attempt it repeats the last). The returned `Query` is an
 * `async function*` over that attempt's messages — natively async-iterable — `Object.assign`-ed with
 * no-op control stubs and cast `as unknown as Query`. A throw-tailed attempt
 * (`{ messages, thenThrow }`) yields its messages then throws `thenThrow()` out of the iteration,
 * landing in index.ts's consume-loop catch exactly like a thrown SDK error.
 *
 * THE `as unknown as Query` CAST IS INTENTIONALLY LOAD-BEARING. An async generator natively provides
 * `next`/`return`/`throw`/`[Symbol.asyncIterator]`; the cast suppresses tsc errors for the ~15 `Query`
 * methods never invoked at runtime. Safe because index.ts's full runtime surface on the query is
 * exactly: async iteration (consume loop), `q.interrupt()` (drainQuery), `q.setPermissionMode(...)`,
 * and `q.close?.()` (optional-chained in shutdown.ts — its absence is safe). The no-op stub set below
 * covers everything invoked; `setModel`/`setMaxThinkingTokens` are unused but harmless. A
 * returned/completed generator → the consume loop exits → runSession returns (single-turn termination,
 * the scripted `result` is emitted before exit).
 */
export function makeEmulatorQuery(
  scenario: EmulatorScenario,
): (args: QueryArgs) => Query {
  let attemptIndex = 0;
  const last = scenario.attempts.length - 1;

  return function emulatorQuery(_args: QueryArgs): Query {
    const attempt = scenario.attempts[Math.min(attemptIndex++, last)];
    const messages = attemptMessages(attempt);
    const thenThrow = Array.isArray(attempt) ? null : attempt.thenThrow;

    async function* gen(): AsyncGenerator<SDKMessage> {
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
