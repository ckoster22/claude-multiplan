// IPC event-chain helper — PURE, dependency-free.
// Side-effect-free at import time (single function declaration). main.ts re-exports `chainHandler` so `src/chain.test.ts`'s `import { chainHandler } from "./main"` keeps resolving unchanged.

/**
 * Append `body` to the chain and return the new tail. `.catch` makes it self-healing: rejections
 * are logged but the promise RESOLVES so subsequent events still run (no wedged chain). Exported
 * for unit-testability against the real self-healing property.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}
