/**
 * `.catch` makes the chain self-healing: a rejected `body` is logged but the returned promise still
 * RESOLVES, so subsequent events keep running instead of wedging the chain.
 */
export function chainHandler(
  pending: Promise<void>,
  body: () => Promise<void>,
): Promise<void> {
  return pending.then(body).catch((e) => console.error("plan-changed handler failed", e));
}
