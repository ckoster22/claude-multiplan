// Agent SDK sidecar — pure `set-permission-mode` decision.
//
// Extracted from index.ts (like session-start.ts's decideStart) so the live/ended gating is
// UNIT-TESTABLE without importing index.ts's top-level side effects. The session lifecycle is
// modeled as a discriminated union so the SDK Query (`q`) is reachable ONLY in the `live` variant:
// calling `q.setPermissionMode(...)` on a dead/closing query — which throws and crashes the
// process — becomes structurally unrepresentable. index.ts is a thin switch over the result.

import { hostPolicyForMode, type HostPolicy } from "./permissions";

// The SDK Query surface index.ts holds in the `live` variant. Minimal structural interface (mirrors
// shutdown.ts's DrainableQuery) so this pure module never imports the SDK `Query` type; the real SDK
// query is assignable to it. The decision NEVER calls this — index.ts owns the actual SDK call.
export interface SettablePermissionQuery {
  setPermissionMode(mode: string): Promise<void>;
}

// The sidecar session lifecycle. `q` lives ONLY in `live`, so a command handler can reach the SDK
// query exclusively when it is safe to call:
//   idle     — no `start` accepted yet.
//   starting — `start` accepted; the SDK query is not assigned yet (boot window, OR a 529 backoff
//              gap where `q` was nulled before the re-issue).
//   live     — a usable SDK query is in flight; `q` is reachable.
//   draining — graceful shutdown began; the query is being interrupted/closed (drain race window).
//   dead     — the session ended (turn(s) done + iterator end); `q` is a stale/closed handle.
// INVARIANT[setpermissionmode-gated-to-live] (type-level): `q` exists only on the live Session variant, so setPermissionMode is unreachable on idle/dead/draining at compile time.
//   prevents: a setPermissionMode dereferencing `q` on a statically non-live session.
export type Session =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live"; q: SettablePermissionQuery }
  | { kind: "draining" }
  | { kind: "dead" };

// What index.ts must do with a `set-permission-mode` command:
//   apply           — a live query exists; index.ts calls q.setPermissionMode.
//   drop-no-session — no live session yet (idle/starting); no SDK call.
//   drop-ended      — the session ended / is ending (draining/dead); calling q would throw.
//
// `hostPolicy` is present on EVERY variant. The host-policy backstop is HOST state, not SDK session
// state, so set-permission-mode rewrites it UNCONDITIONALLY — even on the drop paths, exactly as the
// pre-refactor index.ts did before its `if (!q)` guard. Carrying it on every branch makes that
// unconditional-write invariant structural: a drop path cannot silently skip the policy write.
export interface SessionCommandDecision {
  action: "apply" | "drop-no-session" | "drop-ended";
  hostPolicy: HostPolicy;
}

// Decide how index.ts handles a `set-permission-mode` command against the current session. Pure: the
// caller owns the hostPolicy assignment and (only on `apply`) the q.setPermissionMode SDK call.
// INVARIANT[decidesessioncommand-purity] (convention): decideSessionCommand never calls q.setPermissionMode; index.ts owns the sole SDK call site.
//   prevents: a hidden SDK side-effect double-firing the mode flip.
export function decideSessionCommand(
  session: Session,
  cmd: { mode?: unknown },
): SessionCommandDecision {
  // ALWAYS recompute the host policy from THIS command's mode — returned on every branch below so
  // index.ts writes it unconditionally (the long-standing "policy is host state" behavior).
  const hostPolicy = hostPolicyForMode(cmd.mode);
  switch (session.kind) {
    case "idle":
    case "starting":
      return { action: "drop-no-session", hostPolicy };
    case "live":
      return { action: "apply", hostPolicy };
    case "draining":
    case "dead":
      return { action: "drop-ended", hostPolicy };
  }
}
