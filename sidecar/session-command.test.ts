// Falsifiable unit tests for the sidecar's PURE session-command decision (session-command.ts).
//
// THE BUG UNDER TEST (#11 — a late `set-permission-mode` crashes the sidecar): when the
// command arrived AFTER the SDK query session had ended (graceful-shutdown drain in flight, or a
// turn-end iterator close), index.ts still called `await q.setPermissionMode(...)` on a stale/closed
// `q`, which throws and kills the process. `decideSessionCommand` models the session lifecycle as a
// discriminated union so `q` is reachable ONLY in the `live` variant: the SDK call is gated to a
// LIVE session, and the dead/draining paths drop the command instead of touching a dead query.
//
// The host-policy backstop is HOST state, not SDK session state — set-permission-mode rewrites it
// UNCONDITIONALLY (even with no live q; see index.ts history at the old lines 744-752). The decision
// therefore carries `hostPolicy` on EVERY variant so a drop path can never silently skip that write.

import { describe, it, expect } from "vitest";
import { decideSessionCommand, type Session } from "./session-command";
import { hostPolicyForMode } from "./permissions";

// A spy SDK query for the `live` variant — records every setPermissionMode invocation so a test can
// assert the PURE decision never calls it itself (index.ts owns the actual SDK call).
function spyQuery() {
  const q = {
    calls: [] as string[],
    setPermissionMode: async (m: string) => {
      q.calls.push(m);
    },
  };
  return q;
}

describe("decideSessionCommand — q.setPermissionMode is gated to a LIVE session (bug #11)", () => {
  it("dead session → drop-ended (a late set-permission-mode must NOT reach a stale q)", () => {
    // FALSIFY: gate `dead` → "apply" (the pre-fix unconditional behavior) → index.ts would call
    // q.setPermissionMode on a closed query and crash the sidecar → this assertion goes RED.
    const d = decideSessionCommand({ kind: "dead" }, { mode: "acceptEdits" });
    expect(d.action).toBe("drop-ended");
  });

  it("draining session → drop-ended (the graceful-shutdown drain race window — q is closing)", () => {
    const d = decideSessionCommand({ kind: "draining" }, { mode: "plan" });
    expect(d.action).toBe("drop-ended");
  });

  it("live session → apply (the ONLY path that may touch q)", () => {
    const session: Session = { kind: "live", q: spyQuery() };
    const d = decideSessionCommand(session, { mode: "acceptEdits" });
    expect(d.action).toBe("apply");
  });

  it("idle session → drop-no-session (before any start)", () => {
    expect(decideSessionCommand({ kind: "idle" }, { mode: "plan" }).action).toBe("drop-no-session");
  });

  it("starting session → drop-no-session (start accepted, q not assigned yet / 529 backoff gap)", () => {
    expect(decideSessionCommand({ kind: "starting" }, { mode: "plan" }).action).toBe("drop-no-session");
  });

  it("the decision is PURE — it never itself invokes q.setPermissionMode (index.ts owns that call)", () => {
    // FALSIFY: move the q.setPermissionMode call INTO decideSessionCommand → spy.calls grows → RED.
    const q = spyQuery();
    decideSessionCommand({ kind: "live", q }, { mode: "acceptEdits" });
    expect(q.calls).toEqual([]);
  });
});

describe("decideSessionCommand — hostPolicy is rewritten on EVERY path (unconditional-write invariant)", () => {
  // EVERY lifecycle variant, including BOTH drop paths. If the hostPolicy write were gated to the
  // apply path, a late set-permission-mode arriving on a dead/idle session would fail to update the
  // host policy backstop — a regression of the long-standing "policy is host state" behavior.
  const sessions: Session[] = [
    { kind: "idle" },
    { kind: "starting" },
    { kind: "live", q: spyQuery() },
    { kind: "draining" },
    { kind: "dead" },
  ];

  it('mode "acceptEdits" → hostPolicy "acceptEdits" on EVERY session variant (incl. both drops)', () => {
    // FALSIFY: compute hostPolicy only on the apply branch (hardcode "plan" / omit it on the drop
    // variants) → the idle/starting/draining/dead variants mismatch → RED.
    for (const s of sessions) {
      const d = decideSessionCommand(s, { mode: "acceptEdits" });
      expect(d.hostPolicy).toBe("acceptEdits");
    }
  });

  it('mode "prototype" on a DROPPED (dead) session — the drop STILL rewrites the host policy', () => {
    const d = decideSessionCommand({ kind: "dead" }, { mode: "prototype" });
    expect(d.action).toBe("drop-ended");
    expect(d.hostPolicy).toBe("prototype");
  });

  it('an unknown/malformed mode fails closed to "plan" on every variant (matches hostPolicyForMode)', () => {
    for (const s of sessions) {
      expect(decideSessionCommand(s, { mode: "bogus" }).hostPolicy).toBe(hostPolicyForMode("bogus"));
      expect(decideSessionCommand(s, {}).hostPolicy).toBe("plan");
    }
  });
});
