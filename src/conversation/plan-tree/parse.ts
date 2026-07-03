// Multiplan plan-tree package — LEAF: the sizer-decision parser.
//
// parseSizerDecision: extract a SizerOutcome from a single assistant text line. PURE; depends only
// on `model`.

import type { SizerOutcome } from "./model";

// Extract a SizerOutcome from a single assistant text line. FORMAT:
//   SIZER: <decision> / <num_plans> / <confidence> / <scale>
// e.g. `SIZER: split / 3 / 0.82 / standard`. `decision` ∈ {single,split}; `num_plans` a non-negative
// integer; `confidence` a float in [0,1]; `scale` ∈ {standard,large,huge}. Returns null for any
// non-matching line, INCLUDING an unknown decision word (e.g. a stale `escalate`) — the driver coerces
// a no-outcome sizer turn to split. The `scale` token is OPTIONAL: an absent, whitespace, or
// unparseable scale (a legacy 3-token line, or an emulator/golden sizer line) defaults to "standard"
// (Sonnet-tier, inert), so pre-scale sizer output keeps parsing unchanged.
export function parseSizerDecision(line: string): SizerOutcome | null {
  const m = /^\s*SIZER:\s*(single|split)\s*\/\s*(\d+)\s*\/\s*(\d*\.?\d+)\s*(?:\/\s*([^/\s]+)\s*)?$/i.exec(line);
  if (!m) return null;
  const decision = m[1].toLowerCase() as SizerOutcome["decision"];
  const num_plans = Number.parseInt(m[2], 10);
  const confidence = Number.parseFloat(m[3]);
  if (Number.isNaN(num_plans) || Number.isNaN(confidence)) return null;
  const rawScale = m[4]?.toLowerCase();
  const scale: SizerOutcome["scale"] =
    rawScale === "large" || rawScale === "huge" ? rawScale : "standard";
  return { decision, confidence, num_plans, scale };
}
