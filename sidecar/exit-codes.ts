// Per-golden process exit codes, keyed by golden BASENAME (`sidecar/__goldens__/<key>.jsonl`).
// The key is the golden basename, NOT the `EMU_SCENARIO` value: `resume-fallback` replays the
// `happy-text` scenario under a bogus `start.resume`, so its basename differs from its scenario.
//
// Shared by BOTH consumers of a golden so the exit contract has a single source:
//   - `sidecar/emulator-e2e.test.ts` asserts the spawned binary's real exit code per scenario;
//   - `src/mock/golden.ts` synthesizes the trailing `agent-exit {code}` frame when replaying a
//     golden through the frontend mock (process termination never appears on fd-1, so the adapter
//     must supply it — from here, never a hand-copied second map).
//
// Only the fatal-flagged `error` scenarios exit 1. NOT a naive "error → 1": `error-midstream`
// (an `is_error:true` result), `thrown-quota`, and `overloaded-midturn` all end gracefully (0).
export const SCENARIO_EXIT_CODES: Record<string, number> = {
  "happy-text": 0,
  "tool-call": 0,
  "plan-write": 0,
  "prototype-write": 0,
  "review-cycle": 0,
  "subagent-fanout": 0,
  "quota-rate-limit": 0,
  "quota-result": 0,
  "overloaded-retry": 0,
  "overloaded-exhausted": 1,
  "permission-denied": 0,
  "error-midstream": 0,
  "overloaded-midturn": 0,
  "auth-failure": 1,
  "thrown-quota": 0,
  "stream-abort": 1,
  "resume-fallback": 0,
};
