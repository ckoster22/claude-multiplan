// @vitest-environment node
//
// Spawned-binary e2e for the scripted-fixture LLM emulator (Layer 1): builds the REAL
// `agent-driver` binary (bun build --compile), spawns it per scenario with EMU_SCENARIO set, drives
// the stdin JSON-lines protocol, and asserts the exact stdout frame stream + exit code — covering
// the index.ts control flow (529 retry loop, thrown-error catch, graceful/fatal exits) that the
// in-process tests (emulator.test.ts) cannot reach, because index.ts is not vitest-importable.
//
// SINGLE-FILE / BUILD-ONCE CONSTRAINT: vitest runs test FILES in parallel. All spawned-binary e2e
// MUST live in this one file — a second e2e file would race two concurrent `bun build --compile`
// runs on the SAME output path (src-tauri/binaries/agent-driver-<triple>) and corrupt the binary.
// The build runs once in beforeAll; tests within the file are sequential.
//
// SCOPE-OUTS (deliberately not covered here):
//   - SDK-interrupt-driven turn abort: the emulator's `interrupt` stub is a no-op that emits no
//     terminal `result`, so the abort path has no observable fixture-driven signal.
//   - buildOptions spawn-error (`error_kind:"spawn"`): extractFromBunfs failure cannot be forced
//     deterministically from outside the compiled binary.
//
// GOLDENS: after each scenario's behavioral assertions pass, the captured stdout lines are compared
// BYTE-FOR-BYTE against sidecar/__goldens__/<name>.jsonl. Regenerate with:
//   UPDATE_GOLDENS=1 npx vitest run sidecar/emulator-e2e.test.ts
// No scrubbing is applied (or needed): the fixtures are pinned by construction — sysInit hardcodes
// cwd "/Users/emulator/work", and every quota resetAt derives from FIXED_RESET_EPOCH_MS, never
// Date.now(). The goldens' correctness is established by the per-scenario frame assertions that run
// BEFORE the golden comparison — the goldens then pin the exact bytes against drift.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIO_NAMES,
  FIXED_RESET_EPOCH_MS,
  AUTH_ERROR_MESSAGE,
  THROWN_QUOTA_ERROR_MESSAGE,
  STREAM_ABORT_ERROR_MESSAGE,
} from "./emulator-scenes";
import { SCENARIO_EXIT_CODES } from "./exit-codes";
import { SECOND_START_MESSAGE } from "./session-start";
import { RESUME_FALLBACK_REASON } from "./session-resume";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const buildScript = join(repoRoot, "scripts", "sidecar-build.mjs");
const binDir = join(repoRoot, "src-tauri", "binaries");
const GOLDEN_DIR = join(__dirname, "__goldens__");

const TEST_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 180_000;

function toolAvailable(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return r.error === undefined && r.status === 0;
}

// Toolchain gate: the suite NEVER falls back to a stale pre-built binary — either both tools are
// present (build fresh, run everything) or the whole suite skips LOUDLY.
const missingTools = [
  !toolAvailable("bun") ? "bun" : null,
  !toolAvailable("rustc") ? "rustc" : null,
].filter((t): t is string => t !== null);
if (missingTools.length > 0) {
  console.warn(
    `\n[emulator-e2e] SKIPPING the entire spawned-binary suite — missing toolchain: ` +
      `${missingTools.join(", ")}. Install it so the e2e coverage actually runs; a stale ` +
      `pre-built binary is never reused as a fallback.\n`,
  );
}
const describeE2E = missingTools.length === 0 ? describe : describe.skip;

type Frame = Record<string, unknown>;

/** The frames both consumers treat as ending a run: a turn `result`, a quota pause, a fatal error. */
function isTerminal(f: Frame): boolean {
  return (
    f.kind === "result" || f.kind === "quota_exceeded" || (f.kind === "error" && f.fatal === true)
  );
}

interface Sidecar {
  frames: Frame[];
  rawLines: string[];
  send(cmd: Record<string, unknown>): void;
  endIfAlive(): void;
  waitFor(pred: (f: Frame) => boolean): Promise<void>;
  closed: Promise<number | null>;
}

let binaryPath = "";
let scratchCwd = "";

// A test that times out mid-await would otherwise orphan its spawned binary.
const liveChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const child of liveChildren) child.kill();
});

function startSidecar(scenario: string): Sidecar {
  const child = spawn(binaryPath, [], {
    env: { ...process.env, EMU_SCENARIO: scenario, CLAUDE_CODE_OAUTH_TOKEN: "emu-invalid" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.add(child);
  // Self-exiting scenarios (quota / fatal error) close the pipe under us — swallow the async EPIPE
  // instead of letting it surface as an uncaught stream error.
  child.stdin.on("error", () => {});
  // stderr must be consumed (emulator banner, resolved-model log) or the pipe buffer could stall
  // the child; drained to nowhere — assertions read stdout only.
  child.stderr.on("data", () => {});

  const frames: Frame[] = [];
  const rawLines: string[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: () => void }> = [];

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    rawLines.push(line);
    const frame = JSON.parse(line) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });

  const closed = new Promise<number | null>((resolveClosed) => {
    child.on("close", (code) => {
      liveChildren.delete(child);
      // Release pending waiters: a child that exits without the awaited frame must fail the
      // caller's frame assertions with a real diff, not hang into the test timeout.
      for (const w of waiters.splice(0)) w.resolve();
      resolveClosed(code);
    });
  });

  return {
    frames,
    rawLines,
    send(cmd) {
      try {
        child.stdin.write(JSON.stringify(cmd) + "\n");
      } catch {
        // Already-exited child (EPIPE) — the exit-code assertion reports the real story.
      }
    },
    endIfAlive() {
      if (child.exitCode === null && !child.killed) {
        try {
          child.stdin.write('{"type":"end"}\n');
        } catch {
          // Raced a self-exit — fine, the drain already ran.
        }
      }
    },
    waitFor(pred) {
      if (frames.some(pred)) return Promise.resolve();
      if (child.exitCode !== null) return Promise.resolve();
      return new Promise((resolvePred) => waiters.push({ pred, resolve: resolvePred }));
    },
    closed,
  };
}

async function runScenario(
  scenario: string,
  startExtra: Record<string, unknown> = {},
): Promise<{ frames: Frame[]; rawLines: string[]; exitCode: number | null }> {
  const s = startSidecar(scenario);
  s.send({ type: "start", cwd: scratchCwd, permissionMode: "default", ...startExtra });
  s.send({ type: "user", text: "drive the scripted scenario" });
  await s.waitFor(isTerminal);
  s.endIfAlive();
  const exitCode = await s.closed;
  return { frames: s.frames, rawLines: s.rawLines, exitCode };
}

function assertSeqMonotonic(frames: Frame[]): void {
  expect(frames.length).toBeGreaterThan(0);
  let prev = -1;
  for (const f of frames) {
    expect(typeof f.seq, `frame missing numeric seq: ${JSON.stringify(f)}`).toBe("number");
    expect(f.seq as number).toBeGreaterThan(prev);
    prev = f.seq as number;
  }
}

/** Every tool_result's tool_use_id must correlate to an emitted tool_use id. */
function assertToolCorrelation(frames: Frame[]): void {
  const useIds = frames.filter((f) => f.kind === "tool_use").map((f) => f.id);
  const results = frames.filter((f) => f.kind === "tool_result");
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(useIds).toContain(r.tool_use_id);
  }
}

function firstOf(frames: Frame[], kind: string): Frame {
  const f = frames.find((x) => x.kind === kind);
  expect(f, `expected a ${kind} frame`).toBeDefined();
  return f!;
}

function checkGolden(name: string, rawLines: string[]): void {
  const goldenPath = join(GOLDEN_DIR, `${name}.jsonl`);
  const actual = rawLines.join("\n") + "\n";
  if (process.env.UPDATE_GOLDENS) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  expect(
    existsSync(goldenPath),
    `missing golden ${goldenPath} — regenerate with UPDATE_GOLDENS=1`,
  ).toBe(true);
  expect(actual).toBe(readFileSync(goldenPath, "utf8"));
}

interface Spec {
  /** Test id AND golden basename — ALSO the SCENARIO_EXIT_CODES key that pins this spec's
   *  expected exit code. Equals the EMU_SCENARIO except for protocol-driven cases. */
  name: string;
  scenario: string;
  start?: Record<string, unknown>;
  kinds: string[];
  verify?: (frames: Frame[]) => void;
}

const SPECS: Spec[] = [
  {
    name: "happy-text",
    scenario: "happy-text",
    kinds: ["system_init", "assistant_text", "assistant_text", "result"],
    verify: (frames) => {
      const result = firstOf(frames, "result");
      expect(result.is_error).toBe(false);
      expect(result.result).toBe("All done.");
    },
  },
  {
    name: "tool-call",
    scenario: "tool-call",
    kinds: ["system_init", "tool_use", "tool_result", "assistant_text", "result"],
    verify: (frames) => {
      assertToolCorrelation(frames);
      const use = firstOf(frames, "tool_use");
      expect(use.tool).toBe("Bash");
      expect(use.id).toBe("emu-tool-1");
    },
  },
  {
    name: "plan-write",
    scenario: "plan-write",
    kinds: ["system_init", "tool_use", "tool_result", "assistant_text", "result"],
    verify: (frames) => {
      assertToolCorrelation(frames);
      const use = firstOf(frames, "tool_use");
      expect(use.tool).toBe("Write");
      expect((use.input as { file_path: string }).file_path).toContain("/.claude/plans/");
    },
  },
  {
    name: "prototype-write",
    scenario: "prototype-write",
    kinds: ["system_init", "tool_use", "tool_result", "result"],
    verify: (frames) => {
      assertToolCorrelation(frames);
      const use = firstOf(frames, "tool_use");
      expect((use.input as { file_path: string }).file_path).toContain("/.plan-tree/prototype/");
    },
  },
  {
    name: "review-cycle",
    scenario: "review-cycle",
    kinds: ["system_init", "assistant_text", "tool_use", "tool_result", "result"],
    verify: (frames) => {
      assertToolCorrelation(frames);
      expect(firstOf(frames, "tool_use").tool).toBe("ExitPlanMode");
    },
  },
  {
    name: "subagent-fanout",
    scenario: "subagent-fanout",
    kinds: [
      "system_init",
      "tool_use",
      "subagent_started",
      "assistant_text",
      "tool_use",
      "tool_result",
      "assistant_text",
      "result",
    ],
    verify: (frames) => {
      assertToolCorrelation(frames);
      const taskUse = frames.find((f) => f.kind === "tool_use" && f.tool === "Task")!;
      const started = firstOf(frames, "subagent_started");
      expect(started.tool_use_id).toBe(taskUse.id);
      expect(started.tool_use_id).toBe("T1");
      const childResult = firstOf(frames, "tool_result");
      expect(childResult.tool_use_id).toBe("subtool-1");
      expect(childResult.parent_tool_use_id).toBe("T1");
    },
  },
  {
    name: "quota-rate-limit",
    scenario: "quota-rate-limit",
    kinds: ["system_init", "quota_exceeded"],
    verify: (frames) => {
      const quota = firstOf(frames, "quota_exceeded");
      expect(quota.source).toBe("rate_limit_event");
      expect(quota.resetAt).toBe(FIXED_RESET_EPOCH_MS);
    },
  },
  {
    // The rejected rate_limit_event that pins quota-result's reset instant ITSELF pauses the
    // session (index.ts gracefulExit(0) on the first quota_exceeded), so the trailing
    // result-carrier message is never consumed here — decideResultQuota's structured-reuse branch
    // is asserted at the in-process tier (emulator.test.ts).
    name: "quota-result",
    scenario: "quota-result",
    kinds: ["system_init", "quota_exceeded"],
    verify: (frames) => {
      const quota = firstOf(frames, "quota_exceeded");
      expect(quota.source).toBe("rate_limit_event");
      expect(quota.resetAt).toBe(FIXED_RESET_EPOCH_MS);
    },
  },
  {
    name: "overloaded-retry",
    scenario: "overloaded-retry",
    kinds: ["status", "status", "system_init", "assistant_text", "result"],
    verify: (frames) => {
      // Two retry notices, then RECOVERY: the third attempt streams normally.
      const statuses = frames.filter((f) => f.kind === "status");
      expect(statuses[0].label).toContain("retrying in 1m (retry 1/6)");
      expect(statuses[1].label).toContain("retrying in 2m (retry 2/6)");
      const result = firstOf(frames, "result");
      expect(result.is_error).toBe(false);
      expect(result.result).toBe("Succeeded on retry.");
    },
  },
  {
    name: "overloaded-exhausted",
    scenario: "overloaded-exhausted",
    kinds: ["status", "status", "status", "status", "status", "status", "error"],
    verify: (frames) => {
      const statuses = frames.filter((f) => f.kind === "status");
      statuses.forEach((s, i) => {
        expect(s.label).toContain(`(retry ${i + 1}/6)`);
      });
      const err = firstOf(frames, "error");
      expect(err.error_kind).toBe("sdk");
      expect(err.fatal).toBe(true);
      expect(err.message).toContain("retried 6×");
    },
  },
  {
    name: "permission-denied",
    scenario: "permission-denied",
    kinds: ["system_init", "permission_denied", "result"],
    verify: (frames) => {
      const denied = firstOf(frames, "permission_denied");
      expect(denied.tool).toBe("Write");
      expect(denied.tool_use_id).toBe("emu-denied-1");
    },
  },
  {
    name: "error-midstream",
    scenario: "error-midstream",
    kinds: ["system_init", "assistant_text", "result"],
    verify: (frames) => {
      const result = firstOf(frames, "result");
      expect(result.is_error).toBe(true);
      expect(result.subtype).toBe("error_during_execution");
    },
  },
  {
    name: "overloaded-midturn",
    scenario: "overloaded-midturn",
    kinds: ["system_init", "assistant_text", "status", "result"],
    verify: (frames) => {
      // Mid-turn branch: an informational status + the SYNTHETIC terminal result — and NO retry
      // (no "retrying" status, no second system_init from a re-driven attempt).
      expect(firstOf(frames, "status").label).toContain("after partial output");
      const result = firstOf(frames, "result");
      expect(result.is_error).toBe(true);
      expect(result.subtype).toBe("error_during_execution");
      expect(result.result).toContain("after partial output; not retried");
      expect(frames.some((f) => f.kind === "status" && String(f.label).includes("retrying"))).toBe(
        false,
      );
      expect(frames.filter((f) => f.kind === "system_init").length).toBe(1);
    },
  },
  {
    name: "auth-failure",
    scenario: "auth-failure",
    kinds: ["system_init", "error"],
    verify: (frames) => {
      const err = firstOf(frames, "error");
      expect(err.error_kind).toBe("auth");
      expect(err.fatal).toBe(true);
      expect(err.message).toContain(AUTH_ERROR_MESSAGE);
    },
  },
  {
    name: "thrown-quota",
    scenario: "thrown-quota",
    kinds: ["system_init", "quota_exceeded"],
    verify: (frames) => {
      const quota = firstOf(frames, "quota_exceeded");
      expect(quota.source).toBe("thrown_error");
      expect(quota.resetAt).toBe(FIXED_RESET_EPOCH_MS);
    },
  },
  {
    name: "stream-abort",
    scenario: "stream-abort",
    kinds: ["system_init", "assistant_text", "error"],
    verify: (frames) => {
      const err = firstOf(frames, "error");
      expect(err.error_kind).toBe("sdk");
      expect(err.fatal).toBe(true);
      expect(err.message).toContain(STREAM_ABORT_ERROR_MESSAGE);
    },
  },
  {
    // Protocol-driven: happy-text with a bogus start.resume. The resume pre-flight
    // (getSessionInfo) is the ONE un-emulated SDK call in the suite — it is a LOCAL session-store
    // lookup (no network) that resolves undefined fast for a bogus id, so it is deterministic and
    // well inside the test timeout.
    name: "resume-fallback",
    scenario: "happy-text",
    start: { resume: "emu-bogus-resume-id" },
    kinds: ["resume_fallback", "system_init", "assistant_text", "assistant_text", "result"],
    verify: (frames) => {
      expect(firstOf(frames, "resume_fallback").reason).toBe(RESUME_FALLBACK_REASON);
    },
  },
];

describeE2E("emulator e2e — spawned agent-driver binary, per-scenario frame streams", () => {
  beforeAll(() => {
    try {
      execFileSync("node", [buildScript], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      throw new Error(
        `sidecar build failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`,
      );
    }
    const built = readdirSync(binDir)
      .filter((f) => f.startsWith("agent-driver-"))
      .map((f) => join(binDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    expect(built.length).toBeGreaterThan(0);
    binaryPath = built[0];
    scratchCwd = mkdtempSync(join(tmpdir(), "emu-e2e-"));
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    if (scratchCwd) rmSync(scratchCwd, { recursive: true, force: true });
  });

  it("the matrix covers every registered scenario", () => {
    const covered = SPECS.map((s) => s.name);
    for (const name of SCENARIO_NAMES) {
      expect(covered).toContain(name);
    }
  });

  for (const spec of SPECS) {
    it(
      `${spec.name} — frame sequence, key fields, exit ${SCENARIO_EXIT_CODES[spec.name]}, golden`,
      async () => {
        // The shared per-golden exit map (also consumed by the frontend golden-replay adapter's
        // agent-exit synthesis) MUST cover every spec — an uncovered name is a drift bug, not a 0.
        expect(SCENARIO_EXIT_CODES[spec.name]).toBeDefined();
        const { frames, rawLines, exitCode } = await runScenario(spec.scenario, spec.start ?? {});
        expect(frames.map((f) => f.kind)).toEqual(spec.kinds);
        assertSeqMonotonic(frames);
        spec.verify?.(frames);
        expect(exitCode).toBe(SCENARIO_EXIT_CODES[spec.name]);
        checkGolden(spec.name, rawLines);
      },
      TEST_TIMEOUT_MS,
    );
  }

  it(
    "second-start-reject — a second start after the first terminal frame is a fatal protocol rejection",
    async () => {
      const s = startSidecar("happy-text");
      s.send({ type: "start", cwd: scratchCwd, permissionMode: "default" });
      s.send({ type: "user", text: "drive the scripted scenario" });
      await s.waitFor((f) => f.kind === "result");

      // The first session's turn is over but the process is alive; a SECOND start must be
      // rejected fatally (one-session-per-process), never absorbed into the prior context.
      s.send({ type: "start", cwd: scratchCwd, permissionMode: "default" });
      await s.waitFor((f) => f.kind === "error");
      const exitCode = await s.closed;

      const err = firstOf(s.frames, "error");
      expect(err.error_kind).toBe("protocol");
      expect(err.fatal).toBe(true);
      expect(err.message).toBe(SECOND_START_MESSAGE);
      assertSeqMonotonic(s.frames);
      expect(exitCode).toBe(1);
      // Deliberately NO golden: the pre-reject frame stream is happy-text's (already pinned).
    },
    TEST_TIMEOUT_MS,
  );
});
