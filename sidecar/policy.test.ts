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
    expect(p).toMatch(/provenance|moved from|restates|decorative/);
    expect(p).toMatch(/NEVER write/);
  });

  it("encodes the invariant-policy signal", () => {
    const p = systemPromptOption().systemPrompt;
    expect(p).toMatch(/grounded in code/);
    expect(p).toMatch(/is not evidence/);
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
