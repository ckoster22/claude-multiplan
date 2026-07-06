import { describe, it, expect } from "vitest";
import { systemPromptOption } from "./policy";

describe("sidecar systemPromptOption — buildOptions' systemPrompt spread", () => {
  it("carries a systemPrompt string", () => {
    const opt = systemPromptOption();
    expect(typeof opt.systemPrompt).toBe("string");
    expect(opt.systemPrompt.length).toBeGreaterThan(0);
  });

  it("encodes the comment-policy signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/provenance|moved from|formerly|extracted from/);
    expect(p).toMatch(/NEVER write/);
  });

  it("encodes the invariant-design signal (impossible states unrepresentable)", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/impossible states unrepresentable/);
    expect(p).toMatch(/discriminated union/);
  });

  it("encodes the invariant-as-code signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/grounded in code/);
    expect(p).toMatch(/is not evidence/);
  });

  it("encodes the invariant-first testing signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/invariant-first/);
    expect(p).toMatch(/reverse-engineered/);
  });

  it("encodes the falsifiable-testing signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/falsifiable/);
    expect(p).toMatch(/MUST make the test fail/);
  });

  it("encodes the no-test-only-surface signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/only for tests/);
    expect(p).toMatch(/internal-state accessors/);
  });

  it("is self-scoped to source code", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/apply ONLY to source code|write or edit SOURCE CODE/);
  });

  it("explicitly exempts prose (plans/summaries), never globally forbids it", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/Plans, summaries.*unaffected/);
  });
});
