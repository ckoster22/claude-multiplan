// Multiplan plan-tree package — LEAF: the sizer-decision parser.
//
// parseSizerDecision: extract a SizerOutcome from a single assistant text line. PURE; depends only
// on `model`.

import type { SizerOutcome } from "./model";

// Extract a SizerOutcome from a single assistant text line. DOCUMENTED FORMAT: a line of the form
//   SIZER: <decision> / <num_plans> / <confidence>
// e.g. `SIZER: split / 3 / 0.82`. `decision` ∈ {single,split} — the ONLY two outcomes; `num_plans`
// is a non-negative integer; `confidence` is a float in [0,1]. Returns null for any non-matching
// line, INCLUDING a SIZER line with an unknown decision word (e.g. a stale `escalate`) — the
// driver coerces a sizer turn with no parseable outcome to split.
export function parseSizerDecision(line: string): SizerOutcome | null {
  const m = /^\s*SIZER:\s*(single|split)\s*\/\s*(\d+)\s*\/\s*(\d*\.?\d+)\s*$/i.exec(line);
  if (!m) return null;
  const decision = m[1].toLowerCase() as SizerOutcome["decision"];
  const num_plans = Number.parseInt(m[2], 10);
  const confidence = Number.parseFloat(m[3]);
  if (Number.isNaN(num_plans) || Number.isNaN(confidence)) return null;
  return { decision, confidence, num_plans };
}
