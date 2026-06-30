// IPC event-chain helper — PURE, dependency-free.
//
// Side-effect-free at import time (a single function declaration; no `listen(...)`, no
// `addEventListener`, no module singleton). Extracted verbatim from main.ts as part of the
// composition-root slim-down; main.ts re-exports `chainHandler` so `src/chain.test.ts`'s
// `import { chainHandler } from "./main"` keeps resolving unchanged.

/**
 * Append `body` to a serialized promise chain and return the new tail. The `.catch` makes the
 * chain self-healing: if `body` rejects, it is logged and the returned promise still RESOLVES,
 * so the next event chained onto the tail still runs (a single failed handler can never wedge
 * the chain in a permanently-rejected state and silently drop all future events). Exported so
 * this self-healing property is unit-testable against the real code, not a copy of the pattern.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}
