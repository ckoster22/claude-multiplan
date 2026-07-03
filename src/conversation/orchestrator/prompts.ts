// Multiplan orchestration — PURE prompt builders, parsers, and constants (leaf).

import { pathKey, parseNn, PlanValidationError } from "../plan-tree";
import type { NodePath, Nn, PrototypeInfo } from "../plan-tree";
import type { Mandate } from "./types";


// The per-step prompts the driver sends over the single SDK session, naming the user-level subagents
// (scope-recon / plan-sizer / devils-advocate-reviewer) /multiplan relies on. Each is sent right
// before the driver arms the matching `awaiting` variant. Node ids render via pathKey (at depth 1:
// "01", "02", …).

// Intent clarification: the GENESIS turn. The MAIN agent (this session) owns the user interaction; it
// invokes the intent-clarifier subagent ONLY to ASSESS the request. The subagent returns a STRICT
// machine-readable JSON object — NOT prose:
//   { "intent_clear": <bool>, "questions": [ { question, header(<=12c), multiSelect, options:[{label,
//   description}, ...2-4] }, ...0-4 ] }
// (`intent_clear:true` ⇒ `questions:[]`). The subagent CANNOT touch the user or the disk. The MAIN
// agent PARSES that JSON: when `intent_clear` is false it surfaces `questions` via AskUserQuestion
// (a top-level AskUserQuestion surfaces through the app's CLARIFY gate; a subagent's errors with
// "AskUserQuestion is not available inside subagents" — why ownership lives here). The MAIN agent's
// FINAL message is the confirmed INTENT as CLEAN PROSE (never the raw JSON), captured by the driver
// (→ INTENT.md) and threaded into recon. The prompt mirrors the clarifier's HARD-MANDATED contract
// ("Return EXACTLY ONE JSON object on stdout. No prose, no markdown") — a prose contract would
// capture the raw JSON buffer as the intent and lose the ambiguity signal.
//
// VISUAL-PROTOTYPE MODE (the /multiplan "visual intent loop"): the spawn prompt
// carries the `---VISUAL-MODE---` directive, so the clarifier builds a rapid throwaway visual under
// .plan-tree/prototype/ (the "prototype" write policy confines writes there) and the main agent's
// final message carries the clarifier's `prototype` JSON back via the trailing ---PROTOTYPE--- block
// (or the literal NO-PROTOTYPE line). The driver parses that (parsePrototypeBlock) and opens the
// prototype-review gate. The "no deep exploration" guard stays because the subagent has
// Read/Glob/Grep/Bash and could otherwise wander before scope-recon runs.

// The byte-exact visual-mode directive the intent-clarifier contract keys on (SKILL.md "SHARED
// CONTRACT — visual-mode intent-clarifier"). Exported so contains-pins catch a silent drift.
export const VISUAL_MODE_DIRECTIVE = [
  "---VISUAL-MODE---",
  "output_dir: .plan-tree/prototype/",
  "---END-VISUAL-MODE---",
].join("\n");

// The shared visual-mode clarifier contract: how to spawn the clarifier IN VISUAL MODE (directive +
// guard + scope), the JSON shape it returns (the usual object PLUS the optional `prototype` key),
// and the medium/variants/screenshot guidance mirroring the external skill + agent definitions.
// Spliced into BOTH visual-mode prompts (intentPrompt and refinePrototypePrompt).
function visualClarifierContractLines(): string[] {
  return [
    "Spawn it IN VISUAL MODE: include this directive block VERBATIM in its spawn prompt (it",
    "activates the subagent's visual-prototype mode and names its output directory):",
    "",
    VISUAL_MODE_DIRECTIVE,
    "",
    "In its spawn prompt also give it this guard verbatim:",
    "",
    "  - You MUST NOT deeply explore the codebase — a separate scope-recon step does that next. At",
    "    most a couple of quick reads, only if strictly necessary — and never outside this working",
    "    directory. Prototype artifacts go under .plan-tree/prototype/ ONLY, written with the Write",
    "    tool (never cat/echo/Bash redirection — the output directory already exists, so no mkdir",
    "    is needed).",
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "In visual mode the subagent returns EXACTLY ONE JSON object (no prose, no markdown): the usual",
    "shape PLUS an optional `prototype` object:",
    "",
    '  { "intent_clear": <bool>, "questions": [',
    '    { "question": "<text>", "header": "<=12 chars>", "multiSelect": <bool>,',
    '      "options": [ {"label": "<text>", "description": "<text>"}, ... ] }, ... ],',
    '    "prototype": { "kind": "html | mermaid | ascii | table", "paths": ["<artifact path>", ...],',
    '      "screenshot": "<path or null>", "inline_preview": "<text or null>",',
    '      "variants": [ {"label": "<short>", "path": "<path or null>", "inline_preview": "<text or null>"} ] } }',
    "",
    "The MEDIUM is the subagent's discretion: UI / layout / visual / game work → a WORKING",
    "single-file HTML prototype with realistic mock data (the DEFAULT); backend / data / API /",
    "refactor work → a mermaid diagram, an ASCII mockup, or a sample input/output table — whatever",
    'communicates intent fastest. The guarantee is "always SOME visual", never "always HTML". It',
    "may produce 2-4 labeled variants when the right direction is genuinely ambiguous. Screenshots",
    "(chrome-devtools) are BEST-EFFORT: if unavailable or erroring it must skip them",
    "(screenshot: null) without failing.",
    "",
    "`kind` MUST match the actual format of `inline_preview` — the reading pane routes by `kind`,",
    "so a mislabel renders as an error:",
    '  - kind "mermaid" REQUIRES `inline_preview` to be VALID MERMAID DIAGRAM SOURCE — its first',
    "    non-empty line is a mermaid diagram-type keyword (flowchart / graph / sequenceDiagram /",
    "    stateDiagram / classDiagram / erDiagram / etc.) so it renders as a real diagram. A",
    '    box-and-arrow or freeform ASCII drawing is NOT mermaid and MUST use kind "ascii" instead',
    "    (rendered as a plain monospace block, always safe).",
    '  - kind "table" for input/output tables; kind "html" for an HTML artifact.',
  ];
}

// The shared FINALIZE contract for visual-mode turns: clean prose intent first, then — as the very
// last content of the final message — either the ---PROTOTYPE--- block carrying the clarifier's
// `prototype` JSON verbatim, or the literal NO-PROTOTYPE line. parsePrototypeBlock consumes exactly
// this trailing-anchored shape.
function visualFinalizeLines(step: string): string[] {
  return [
    `${step}FINALIZE. Your final message MUST be the CONCISE confirmed INTENT as CLEAN PROSE — a`,
    "short paragraph stating the goal, key constraints, and success criteria (never the raw JSON,",
    "no markdown) — and then, AS THE VERY LAST CONTENT of that final message, EXACTLY ONE of:",
    "",
    "  - when the subagent returned a `prototype` object, this block with the subagent's",
    "    `prototype` JSON object copied VERBATIM as its body:",
    "",
    "---PROTOTYPE---",
    "{the subagent's `prototype` JSON object, verbatim}",
    "---END-PROTOTYPE---",
    "",
    "  - or, when it returned no `prototype`, the single literal line:",
    "",
    "NO-PROTOTYPE",
    "",
    "Nothing may follow the block (or the line). Do not call any other tool after stating the intent.",
  ];
}

export function intentPrompt(request: string, hasImages = false): string {
  return [
    "We are running the multiplan planning flow. Before reconnaissance, YOU (this agent) must confirm",
    "what the user actually wants from this request:",
    "",
    request,
    "",
    // When the user attached image(s), they are inlined in THIS message and only YOU (this agent) can
    // see them. The planning flow delegates to TEXT-ONLY subagents (intent-clarifier, recon, planner),
    // which cannot receive inline images — so you MUST carry the visual context forward in words.
    ...(hasImages
      ? [
          "The user attached one or more IMAGES to this request (inlined above as [Image #N]). Only YOU",
          "can see them — the subagents you spawn are TEXT-ONLY and will NOT receive the image bytes.",
          "Before delegating, study each image and, in every subagent prompt you write (the",
          "intent-clarifier and any later subagents), include a faithful TEXTUAL description of the",
          "relevant image content (layout, components, colors, labels, data — whatever the request",
          "depends on) so the subagent can act on the user's visual intent.",
          "",
        ]
      : []),
    "Step 1 — ASSESS via the subagent. Invoke the **intent-clarifier** subagent to assess the request",
    "AND produce a rapid, variable-fidelity VISUAL of the intended end product (humans react far",
    "better to a visual than to prose).",
    ...visualClarifierContractLines(),
    "",
    "When `intent_clear` is true, `questions` is empty. When it is false, `questions` holds 1–4",
    "decision-forcing questions (each with 2–4 options). This MUST be a FAST, lightweight clarification",
    "that converges in ONE short turn.",
    "",
    "Step 2 — PARSE and DECIDE. Read (JSON.parse) the object the subagent returned:",
    "",
    "  - If `intent_clear` is false, YOU (the main agent — NOT the subagent) ask its `questions` to the",
    "    user using the **AskUserQuestion** tool ONCE, mapping each question/header/multiSelect and its",
    "    options (label + description) directly into AskUserQuestion's question format. AskUserQuestion",
    "    is the MAIN agent's job; the subagent must never call it. Incorporate the user's answers.",
    "  - If `intent_clear` is true, proceed without asking the user anything.",
    "",
    ...visualFinalizeLines("Step 3 — "),
  ].join("\n");
}

// The refine-loop prompt: the user reviewed the held prototype and asked for changes. Re-invoke the
// intent-clarifier IN VISUAL MODE (same directive + scope guard), instructing it to REVISE the
// existing prototype per the user's feedback (appended verbatim), under the same FINALIZE contract
// — so the next turn's result re-enters parsePrototypeBlock and re-opens the gate.
export function refinePrototypePrompt(feedback: string): string {
  return [
    "The user reviewed the visual prototype and wants it REFINED. Re-invoke the **intent-clarifier**",
    "subagent to revise the prototype (and the confirmed intent, if the feedback changes it) per the",
    "user's feedback below.",
    ...visualClarifierContractLines(),
    "",
    "Instruct it to REVISE the existing prototype under .plan-tree/prototype/ according to this",
    "feedback from the user (pass it to the subagent verbatim):",
    "",
    feedback,
    "",
    ...visualFinalizeLines(""),
  ].join("\n");
}

// Parse the visual-mode FINALIZE contract out of the intent turn's buffered final text.
// TRAILING-ANCHORED: the ---PROTOTYPE--- block (or the NO-PROTOTYPE line) must be the LAST content
// (modulo trailing whitespace) — mid-text delimiters never mis-parse, and when several blocks exist
// the LAST wins (the closer scans upward to its NEAREST opener). The body is JSON.parsed and
// validated: `kind` must be in the closed set, `paths` a non-empty string array (else garbled);
// missing/odd optional fields COERCE (screenshot→null, inline_preview/inlinePreview→null, variants→[]).
// ANY failure returns { intentText: fullText, prototype: null } and NEVER throws (a garbled block
// must not kill the run). The NO-PROTOTYPE line yields the same null prototype with the line stripped
// — and any COMPLETE ---PROTOTYPE---…---END-PROTOTYPE--- block in the remaining text is stripped too
// (a model emitting BOTH must not leak the raw block into INTENT.md).
export function parsePrototypeBlock(text: string): {
  intentText: string;
  prototype: PrototypeInfo | null;
} {
  const fallback = { intentText: text, prototype: null };
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split(/\r?\n/);
  const lastLine = (lines.at(-1) ?? "").trim();
  if (lastLine === "NO-PROTOTYPE") {
    // CONTRACT-VIOLATION GUARD: the FINALIZE contract says EXACTLY ONE of block-or-line, but a
    // model emitting BOTH (a complete ---PROTOTYPE--- block AND a trailing NO-PROTOTYPE) must not
    // leak the raw block into intentText (→ INTENT.md). Strip every COMPLETE opener…closer block
    // from the remaining lines; an unclosed opener is not a block and survives (no false strip).
    const restLines = lines.slice(0, -1);
    const kept: string[] = [];
    for (let i = 0; i < restLines.length; i++) {
      if (restLines[i].trim() === "---PROTOTYPE---") {
        let close = -1;
        for (let j = i + 1; j < restLines.length; j++) {
          if (restLines[j].trim() === "---END-PROTOTYPE---") {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          i = close; // skip the whole block (opener..closer inclusive)
          continue;
        }
      }
      kept.push(restLines[i]);
    }
    return { intentText: kept.join("\n").replace(/\s+$/, ""), prototype: null };
  }
  if (lastLine !== "---END-PROTOTYPE---") return fallback;
  // Scan upward from the trailing closer to its NEAREST opener line — last block wins.
  let open = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i].trim() === "---PROTOTYPE---") {
      open = i;
      break;
    }
  }
  if (open === -1) return fallback;
  const body = lines.slice(open + 1, lines.length - 1).join("\n");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fallback;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fallback;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== "html" && kind !== "mermaid" && kind !== "ascii" && kind !== "table") return fallback;
  const paths = o.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
    return fallback; // garbled paths ⇒ the whole block is garbled (no artifact to review)
  }
  // Accept BOTH spellings for the preview key: the clarifier's JSON is snake_case (inline_preview,
  // per its contract — the block carries it verbatim); PrototypeInfo is camelCase.
  const preview = (v: Record<string, unknown>): string | null =>
    typeof v.inlinePreview === "string"
      ? v.inlinePreview
      : typeof v.inline_preview === "string"
        ? v.inline_preview
        : null;
  const variants = Array.isArray(o.variants)
    ? o.variants.flatMap((v): PrototypeInfo["variants"] => {
        if (typeof v !== "object" || v === null) return [];
        const vo = v as Record<string, unknown>;
        if (typeof vo.label !== "string") return [];
        return [
          { label: vo.label, path: typeof vo.path === "string" ? vo.path : null, inlinePreview: preview(vo) },
        ];
      })
    : [];
  const prototype: PrototypeInfo = {
    kind,
    paths: paths as string[],
    screenshot: typeof o.screenshot === "string" ? o.screenshot : null,
    inlinePreview: preview(o),
    variants,
  };
  return { intentText: lines.slice(0, open).join("\n").replace(/\s+$/, ""), prototype };
}

// Compose the INTENT.md contents PROTOTYPE_APPROVED writes: the confirmed-intent prose, then (when a
// prototype exists) the SKILL-exact "## Embeddable visual (for plan embedding)" block so later plan
// drafts can embed the approved visual. screenshot_abs is absolutized HERE in TS (the driver knows
// cwd): absolute passes verbatim; relative drops any leading "./" and joins `cwd + "/" + rel`; null →
// "none". The block also carries `- artifacts: <paths joined with ", ">` (the exact file list).
// inline_preview is included ONLY for the text-renderable kinds (mermaid/ascii/table), the verbatim
// preview indented under the YAML-ish literal marker; for html the key is omitted (the screenshot
// carries the visual). No block at all when `proto` is null.
export function composeIntentMd(
  intentText: string,
  proto: PrototypeInfo | null,
  cwd: string,
): string {
  if (!proto) return intentText;
  const screenshotAbs =
    proto.screenshot === null
      ? "none"
      : proto.screenshot.startsWith("/")
        ? proto.screenshot
        : `${cwd}/${proto.screenshot.replace(/^\.\//, "")}`;
  const lines = [
    intentText,
    "",
    "## Embeddable visual (for plan embedding)",
    `- kind: ${proto.kind}`,
    `- screenshot_abs: ${screenshotAbs}`,
    // The exact artifact file list (the external SKILL's INTENT.md carries it too) — downstream
    // plan turns may want to read/embed the approved files directly.
    `- artifacts: ${proto.paths.join(", ")}`,
  ];
  if (proto.kind !== "html" && proto.inlinePreview !== null) {
    lines.push("- inline_preview: |");
    for (const l of proto.inlinePreview.split(/\r?\n/)) lines.push(`    ${l}`);
  }
  return lines.join("\n");
}

// A labeled context block carrying the confirmed intent (the intent-clarifier's final message),
// threaded ABOVE a planning prompt's instructions. Returns [] when intent is null/empty so the
// prompt is byte-identical to its pre-feature form (graceful empty-intent). Callers spread these
// lines into their prompt's line array before the instruction lines.
function confirmedIntentBlock(intent?: string | null): string[] {
  const text = intent?.trim();
  if (!text) return [];
  return ["Confirmed intent (from clarification):", "", text, ""];
}

// Working-directory scope guard: spliced into every exploration-capable prompt (intent, root
// recon, sub-recon) so neither the main agent nor any subagent it spawns crawls SIBLING projects
// or parent directories when hunting "prior art". Exported so contains-pins in
// orchestrator.test.ts catch a silent drop from any of the three prompts.
export const WORKDIR_SCOPE_GUARD = [
  "SCOPE: confine ALL exploration to the chosen working directory (this session's cwd).",
  "Do NOT read, glob, grep, or list sibling projects or parent directories — prior art",
  "means prior art WITHIN this directory tree only. Pass this constraint verbatim to any",
  "subagent you spawn.",
].join("\n");

// BASELINE FRAMING: the wording threaded into any prompt referencing the frozen
// working-reference baseline. The baseline is a FLOOR on the outcome dimensions in INTENT.md — the
// minimum bar to clear — NOT a behavioral match-target; improvements ABOVE the floor are good.
// Exported so later prompts reuse the identical constant (a contains-pin catches a silent drop).
export const BASELINE_FRAMING = [
  "BASELINE (working reference): a FLOOR on the outcome dimensions captured in INTENT.md — the",
  "minimum bar the build must clear — NOT a behavioral match-target to reproduce. The frozen",
  "prototype under `.plan-tree/baseline/` shows one way the floor was met; intentional improvements",
  "ABOVE the floor are good. Do NOT treat the baseline as a spec to copy.",
].join("\n");

// Root recon: delegate broad codebase/scope reconnaissance to the scope-recon subagent. When a
// confirmed `intent` is provided it is threaded in as a labeled context block ABOVE the recon
// instructions; null/empty intent yields the exact pre-feature prompt.
export function reconPrompt(request: string, intent?: string | null): string {
  return [
    ...confirmedIntentBlock(intent),
    "We are running the multiplan planning flow for this request:",
    "",
    request,
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "Use the **scope-recon** subagent to perform broad reconnaissance of the codebase and the",
    "request's scope: relevant files, modules, prior art, constraints, and risks. Return the",
    "subagent's full report verbatim as your final message — do not call any other tool.",
  ].join("\n");
}

// Sizer: delegate the decompose/size decision to the plan-sizer subagent and demand the SIZER line.
// Carries the /multiplan skill's decomposition-bias block (Gate 3) verbatim-in-spirit: without it
// the sizer under-splits greenfield multi-subsystem requests (the bias the CLI skill encodes).
// Exported so the bias prose is pinned by a contains-test (a silent drop would otherwise be invisible).
export function sizerPrompt(): string {
  return [
    "Use the **plan-sizer** subagent to decide how to decompose the request, given the recon report.",
    "Pass the recon report along with this decomposition-bias block:",
    "",
    "---DECOMPOSITION-BIAS---",
    "Greenfield projects (recon verdict: `non-repo`) with multiple subsystem concerns (rendering,",
    "physics, controls, UI, persistence, networking, audio, asset loading, etc.) should default to",
    "`split`.",
    "",
    "**Quantitative rule:** if the recon verdict is `non-repo` AND the request implicates 2 or more",
    'of those subsystems, the decision MUST be `split` unless the user\'s request contains an explicit',
    'scope-narrowing clause like "just X", "only Y", or "minimal Z".',
    "",
    "A `single` decision is only appropriate when:",
    "- The work is genuinely single-volatility (one concern, one module), OR",
    "- The user's request contains an explicit scope-narrowing clause (above), OR",
    "- An existing codebase already establishes the cross-cutting layers and the new work is one",
    "  concern within them.",
    "",
    "**Bounded-working-prototype override (DEFAULT SMALL):** when a bounded, working prototype or",
    "reference implementation already exists for the request, that is empirical proof the whole thing",
    "fits in one context. In that case bias the decision to `single` (a single-plan port). The",
    "greenfield 'request implicates 2+ subsystems => MUST split' rule above does NOT apply when such",
    "a bounded working prototype exists — do not shatter a working artifact into a layer tree. Only",
    "split if the prototype itself is genuinely too large to port in one pass. This override keys on",
    "an actual BOUNDED WORKING prototype existing — not on mere mention of a prototype, and not for",
    "genuinely large systems.",
    "",
    "When in doubt: lean split. A master plan with one or two sub-plans is easy to collapse if the",
    "user wants; an oversized single plan is painful to retroactively decompose.",
    "---END-DECOMPOSITION-BIAS---",
    "",
    "After it returns, emit exactly one line at the top level of the form:",
    "",
    "SIZER: <single|split> / <num_plans> / <confidence> / <scale>",
    "",
    "e.g. `SIZER: split / 3 / 0.82 / standard`. Those are the ONLY two decisions — when uncertain,",
    "choose `split` (the master plan gate is the human checkpoint for an uncertain decomposition).",
    "",
    "`scale` ∈ {standard, large, huge} sizes a `single`'s coding scope (ignored for a `split`):",
    "standard = fits one focused plan; large = a big cohesive job (many files / high coupling);",
    "huge = a frontier / long-horizon migration or implementation.",
    "",
    "Emit nothing else after the SIZER line.",
  ].join("\n");
}

// The top-level acceptance-criterion block injected into the MASTER draft prompt ONLY
// when a frozen working-reference baseline exists. Anchors on BASELINE_FRAMING and states the
// acceptance bar in OUTCOME terms — never "match the prototype", never pinned to its exact
// numbers/behavior; intentional justified divergences ABOVE the floor are permitted. Returns [] when
// no baseline exists so the no-baseline prompt stays BYTE-IDENTICAL (pinned by golden-depth1 +
// masterDraftPrompt contains-tests).
function baselineAcceptanceLines(hasBaseline: boolean): string[] {
  if (!hasBaseline) return [];
  return [
    "",
    "ACCEPTANCE CRITERION (top-level — a frozen working reference exists):",
    "",
    BASELINE_FRAMING,
    "",
    "State this as a top-level acceptance criterion of the master plan, phrased in OUTCOME terms",
    "drawn from INTENT.md (e.g. \"the core loop works end-to-end; nothing runs away; the headline",
    "mechanics all fire\"). Do NOT phrase it as \"match the prototype\" and do NOT pin it to the",
    "prototype's exact numbers or exact behavior — the bar is the intended outcome dimensions, the",
    "baseline is merely a FLOOR proving those dimensions are reachable. Intentional, justified",
    "divergences ABOVE the floor are GOOD (improvements to call out, not regressions to flag).",
  ];
}

// Decomposition draft (root: the master plan): draft the decomposition, self-review, then hold via
// ExitPlanMode. A confirmed `intent` threads in as a labeled context block above the instructions;
// null/empty yields the pre-feature prompt (feedback threading is independent — both may coexist).
// `hasBaseline` true injects the top-level OUTCOME-bar acceptance criterion
// (baselineAcceptanceLines). Default false ⇒ byte-unchanged.
export function masterDraftPrompt(
  request: string,
  feedback?: string,
  intent?: string | null,
  hasBaseline = false,
): string {
  const lines = [
    ...confirmedIntentBlock(intent),
    "Draft the MASTER decomposition plan for this request:",
    "",
    request,
    "",
    "Break the work into sequential sub-plans. For each, write a header of the exact form",
    "`### Sub-Plan NN: <title>` (NN is a zero-padded number, e.g. 01) followed by its scope.",
    "",
    "SLICE-FIRST (capability-first, NOT layer-first): decompose by capability / vertical slice, not",
    "by subsystem / horizontal layer. Sub-Plan 01 MUST be the thinnest runnable END-TO-END vertical",
    "slice — a thinnest-playable/usable version that actually runs — and every subsequent sub-plan",
    "MUST enhance that already-running artifact rather than add an isolated horizontal layer. This is",
    "the same vertical-slice principle the plan template already mandates.",
    ...baselineAcceptanceLines(hasBaseline),
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full master plan as `plan` to hold for approval.",
  ];
  if (feedback) {
    lines.push(
      "",
      "The previous master draft was sent back with this feedback — address it fully:",
      "",
      feedback,
    );
  }
  return lines.join("\n");
}

// Render a Mandate into the prompt lines shared by node recon and node draft: the header line, the
// decomposition section body, and (when present) the preamble as shared context. Empty/whitespace
// parts are omitted so degenerate-single mandates (no decomposition plan exists) stay minimal.
// The node id is rendered via pathKey.
function mandateLines(path: NodePath, mandate: Mandate): string[] {
  const lines = [`### Sub-Plan ${pathKey(path)}: ${mandate.title}`];
  if (mandate.sectionBody.trim()) lines.push("", mandate.sectionBody.trim());
  if (mandate.masterPreamble.trim()) {
    lines.push(
      "",
      "Master-plan preamble (shared context for every sub-plan):",
      "",
      mandate.masterPreamble.trim(),
    );
  }
  return lines;
}

// The labeled adjustment-note block threaded into the NEXT sibling's recon AND draft
// prompts after a parent review answered `ADJUST: <note>`. Returns [] when the note is null/empty
// so those prompts stay BYTE-IDENTICAL to their note-free form (pinned by parent-review.test.ts).
// Callers spread these lines directly after the mandate lines.
function adjustNoteLines(note?: string | null): string[] {
  const text = note?.trim();
  if (!text) return [];
  return ["", "Adjustment from the parent's review of the previous sibling:", "", text];
}

// Node recon: reconnaissance scoped to one node's mandate, threading prior sibling summaries forward.
// `adjustNote` (the parent review's ADJUST note for THIS node) injects as a labeled block;
// null/empty yields the note-free prompt. Exported so the byte-identical pin is testable.
export function subReconPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
): string {
  const lines = [
    `We are now working sub-plan ${pathKey(path)}. Its mandate from the master plan:`,
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Use the **scope-recon** subagent to perform reconnaissance scoped to THIS sub-plan only.",
    "",
    WORKDIR_SCOPE_GUARD,
    "",
    "Return its report verbatim as your final message — do not call any other tool.",
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// The behavioral-envelope-test mandate injected into the sub-plan DRAFT and SUMMARY
// prompts ONLY when a frozen working-reference baseline exists, GATED on the sub-plan producing a
// runnable artifact. The bound is INTENT-tied (the INTENDED envelope in INTENT.md), NOT the
// prototype's exact numbers. Returns [] when no baseline exists so the no-baseline prompts stay
// BYTE-IDENTICAL (pinned by golden-depth1 + sub/summary contains-tests).
function baselineEnvelopeTestLines(hasBaseline: boolean): string[] {
  if (!hasBaseline) return [];
  return [
    "",
    "RUNNABLE-ARTIFACT REQUIREMENT (a frozen working reference exists). IF this sub-plan produces a",
    "runnable artifact, it MUST ship all three of the following:",
    "  (a) the core / simulation logic SEPARATED from rendering/DOM — importable and headless-drivable",
    "      so it can be stepped in a test without a browser or a render loop;",
    "  (b) at least ONE integrated behavioral-envelope test that ASSEMBLES the loop and drives it for",
    "      N steps, asserting an intent-tied bound — the bound comes from the INTENDED envelope in",
    "      INTENT.md (the outcome dimensions / floor), NOT from the prototype's exact numbers or its",
    "      exact behavior;",
    "  (c) a falsifiability step: temporarily BREAK the loop, confirm the envelope test goes RED, then",
    "      RESTORE it — an envelope test that cannot go red is unfalsifiable and does not count.",
  ];
}

// Node draft: draft this node's plan, self-review, then hold via ExitPlanMode. Threads prior
// summaries and the parent review's ADJUST note like subReconPrompt (the note lands in BOTH of the
// next sibling's prompts). Exported for the byte-identical pin.
// `hasBaseline` true injects the runnable-artifact envelope-test mandate
// (baselineEnvelopeTestLines). Default false ⇒ byte-unchanged.
export function subDraftPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
  hasBaseline = false,
): string {
  const lines = [
    `Draft the implementation plan for sub-plan ${pathKey(path)}. Its mandate from the master plan:`,
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full sub-plan as `plan` to hold for approval.",
    ...baselineEnvelopeTestLines(hasBaseline),
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// Summary: after a node executes, produce its structured summary (threaded into later siblings).
// `hasBaseline` true injects the same runnable-artifact envelope-test mandate so the
// summary reports whether the behavioral-envelope test + its falsifiability proof landed. Default
// false ⇒ byte-unchanged. Exported so the gated-both-directions pin is testable.
export function summaryPrompt(path: NodePath, hasBaseline = false): string {
  return [
    `Sub-plan ${pathKey(path)} has finished executing. Output a concise summary with these sections:`,
    "",
    "## Changes",
    "## Findings",
    "## Next-step inputs",
    "",
    "Output ONLY the summary markdown as your final message — do not call any tool.",
    ...baselineEnvelopeTestLines(hasBaseline),
  ].join("\n");
}

// The LEAF-approval continuation prompt. On a RESUMED leaf gate the live
// ExitPlanMode resolver is dead, so approving can't "resume the same turn into execution". Instead
// the driver instructs the resumed conversation to implement the already-approved plan — NAMING the
// plan file and FORBIDDING re-output (re-drafting would burn a turn and risk diverging from the
// reviewed artifact).
export function resumedLeafApprovalPrompt(planPath: string): string {
  return [
    `The plan at ${planPath} is approved. Begin implementing it now.`,
    "Do not rewrite or re-output the plan — it is already approved as written; implement it directly.",
  ].join("\n");
}

// The LEAF EXECUTING continuation prompt (the AUDIT-AND-CONTINUE variant). A
// leaf/executing node was killed MID-implementation: its plan is approved AND some edits may already
// be on disk (the executing turn may have partially applied). Unlike resumedLeafApprovalPrompt (which
// would restart from scratch and re-apply on-disk edits), this instructs the model to FIRST inspect
// the working tree for edits already made, then CONTINUE only the remaining steps. NAMES the plan
// file and FORBIDS restarting / re-applying completed edits.
export function resumedLeafContinuePrompt(planPath: string): string {
  return [
    `Implementation of the approved plan at ${planPath} was interrupted partway through and is being resumed.`,
    "Some of this plan's edits may ALREADY be applied to the working tree. Before doing anything else,",
    "inspect the CURRENT state of the working tree to determine which steps of the plan are already done.",
    "Then CONTINUE implementing ONLY the remaining, not-yet-applied steps.",
    "Do NOT restart from scratch and do NOT re-apply edits that are already present — that would duplicate",
    "or corrupt completed work. Do not rewrite or re-output the plan; it is already approved as written.",
  ].join("\n");
}

// The LEAF request-changes continuation prompt. On a RESUMED leaf gate a live
// deny (which would resume the held turn to re-draft) is impossible, so the driver sends the user's
// feedback explicitly and asks for a fresh re-draft held via ExitPlanMode (the next signal is that
// re-draft's ExitPlanMode hold, exactly as the live redraft path produces).
export function resumedLeafChangesPrompt(feedback: string): string {
  return [
    "The plan you drafted was sent back for changes. Revise it to address this feedback fully:",
    "",
    feedback,
    "",
    "Then call ExitPlanMode with the full revised plan as `plan` to hold for approval again.",
  ].join("\n");
}

// The DECOMPOSITION request-changes continuation prompt. Mirrors
// resumedLeafChangesPrompt but for a held decomposition/master gate: re-draft the DECOMPOSITION with
// the same `### Sub-Plan NN:` header contract and hold it via ExitPlanMode.
export function resumedDecompositionChangesPrompt(feedback: string): string {
  return [
    "The decomposition plan you drafted was sent back for changes. Revise it to address this",
    "feedback fully:",
    "",
    feedback,
    "",
    "Keep the `### Sub-Plan NN: <title>` header format for each sub-plan. Then call ExitPlanMode",
    "with the full revised decomposition plan as `plan` to hold for approval again.",
  ].join("\n");
}

// QUOTA RESUME — the note prepended to EVERY auto-resume prompt re-issued after a quota
// pause refreshed. Exported so the per-variant quotaResumePrompt tests pin it (a silent drop is
// caught). RE-EMISSION CONTRACT: the interrupted turn's PARTIAL buffer is DISCARDED, not continued
// (fireResume re-arms the captured variant with `buffer: ""`), so the resumed turn must produce the
// COMPLETE, self-contained artifact FRESH — concatenating a stale partial would corrupt the
// downstream artifact (recon.md / INTENT.md / summary).
export const QUOTA_RESUME_NOTE = [
  "RESUMING AFTER A QUOTA PAUSE. The previous turn was interrupted partway through when an Anthropic",
  "usage/quota limit was reached. The quota has now refreshed and the session is being resumed.",
  "The partial output from the interrupted turn was DISCARDED — do NOT try to continue it from where",
  "it stopped. Instead, produce the COMPLETE, self-contained output for this turn FRESH, as a full",
  "re-emission. The full instructions for the turn follow.",
].join("\n");

// QUOTA RESUME — the generic fallback used when no clean per-variant turn was captured
// (the pause hit while `idle`/`resuming`): there is no specific artifact to re-emit, so just nudge
// the conversation to produce the complete result for whatever step it was on.
export const QUOTA_RESUME_GENERIC = [
  "RESUMING AFTER A QUOTA PAUSE. The previous turn was interrupted when an Anthropic usage/quota",
  "limit was reached. The quota has now refreshed and the session is being resumed. Continue where",
  "you left off and produce the complete result for the current step.",
].join("\n");

// QUOTA RESUME — wrap an original per-variant turn prompt with the re-emission note above.
// Exported + pure so per-variant assertions can build the EXACT expected string from each builder's
// output. The driver-local quotaResumePrompt threads its closure context into the matching builder,
// then calls this to attach the note.
export function quotaResumeWrap(originalTurnPrompt: string): string {
  return [QUOTA_RESUME_NOTE, "", originalTurnPrompt].join("\n");
}

// Nested decomposition draft: a NON-ROOT split node drafts its own decomposition, scoped
// to its mandate (the nested-master preamble travels with it), then holds via ExitPlanMode like the
// root's master draft. Child headers are PER-LEVEL `### Sub-Plan NN:` numbers (the full dotted id
// derives from nesting: <pathKey>.NN) — parseSubPlanHeaders is reused verbatim, so the 1-99
// validation (deny-for-redraft on overflow) is identical at every depth.
// `hasBaseline` true injects the same top-level OUTCOME-bar acceptance criterion the
// root master draft does (baselineAcceptanceLines), so a baseline'd tree decomposing a sub-plan
// further keeps the outcome-bar reminder. Default false ⇒ byte-unchanged.
export function nestedDecompositionDraftPrompt(
  path: NodePath,
  mandate: Mandate,
  summaries: string[],
  adjustNote?: string | null,
  hasBaseline = false,
): string {
  const key = pathKey(path);
  const lines = [
    `Sub-plan ${key} is itself too large for a single plan. Draft its DECOMPOSITION plan. Its mandate`,
    "from the parent plan:",
    "",
    ...mandateLines(path, mandate),
    ...adjustNoteLines(adjustNote),
    "",
    "Break THIS sub-plan's work into sequential child sub-plans. For each, write a header of the",
    "exact form `### Sub-Plan NN: <title>` (NN is a zero-padded number local to this sub-plan,",
    `e.g. 01 — the full id will be ${key}.NN) followed by its scope.`,
    "",
    "SLICE-FIRST (capability-first, NOT layer-first): decompose by capability / vertical slice, not",
    "by subsystem / horizontal layer. Child Sub-Plan 01 MUST be the thinnest runnable END-TO-END",
    "vertical slice — a thinnest-playable/usable version that actually runs — and every subsequent",
    "child sub-plan MUST enhance that already-running artifact rather than add an isolated horizontal",
    "layer. This is the same vertical-slice principle the plan template already mandates.",
    ...baselineAcceptanceLines(hasBaseline),
    "Run a silent **devils-advocate-reviewer** pass over the draft and incorporate its findings.",
    "Then call **ExitPlanMode** with the full decomposition plan as `plan` to hold for approval.",
  ];
  appendPriorSummaries(lines, summaries);
  return lines.join("\n");
}

// Roll-up summary: after a non-root split node's LAST child summarizes, the parent gets
// its own summary turn synthesizing the children's summaries (so every completed sibling — leaf or
// split — contributes exactly ONE summary to per-level threading). The ROOT never gets this turn
// (it writes no roll-up; done is derived).
export function rollupSummaryPrompt(path: NodePath, childSummaries: string[]): string {
  const lines = [
    `All child sub-plans of sub-plan ${pathKey(path)} have finished. Output a concise ROLL-UP summary`,
    `of sub-plan ${pathKey(path)} AS A WHOLE, with these sections:`,
    "",
    "## Changes",
    "## Findings",
    "## Next-step inputs",
    "",
    "Synthesize it from the children's summaries below — do not merely concatenate them.",
    "",
    "Output ONLY the summary markdown as your final message — do not call any tool.",
  ];
  if (childSummaries.length > 0) {
    lines.push("", "Summaries of the child sub-plans (synthesize these):", "");
    for (const s of childSummaries) lines.push(s, "");
  }
  return lines.join("\n");
}

// The parent-review prompt: a NO-TOOLS turn the parent runs after a non-final child's
// summary lands. Carries the reviewed child's summary VERBATIM plus the remaining siblings'
// mandates (titles + section bodies — FROZEN: the review may only pass one adjustment note, never
// re-decompose) and the strict ADJUST/NONE output protocol parseParentReview consumes.
export function parentReviewPrompt(
  reviewedChild: NodePath,
  childSummary: string,
  remainingSiblings: ReadonlyArray<{ path: NodePath; mandate: Mandate }>,
): string {
  const lines = [
    `Sub-plan ${pathKey(reviewedChild)} has completed; its summary is below. You are the PARENT plan`,
    "reviewing that summary BEFORE the next sibling sub-plan begins. The remaining sibling mandates",
    "are FROZEN — you cannot re-decompose, reorder, or rescope them; you may only pass ONE short",
    "adjustment note into the next sub-plan's prompts.",
    "",
    `Summary of sub-plan ${pathKey(reviewedChild)} (verbatim):`,
    "",
    childSummary,
    "",
    "Remaining sibling sub-plans (mandates frozen):",
    "",
  ];
  for (const sib of remainingSiblings) {
    lines.push(`### Sub-Plan ${pathKey(sib.path)}: ${sib.mandate.title}`);
    if (sib.mandate.sectionBody.trim()) lines.push("", sib.mandate.sectionBody.trim());
    lines.push("");
  }
  lines.push(
    "Do NOT call any tool in this turn. Review the summary against the remaining mandates, then END",
    "your final message with EXACTLY ONE line of this strict form (nothing after it):",
    "",
    "ADJUST: <one short adjustment note for the next sub-plan>",
    "",
    "or, when no adjustment is needed:",
    "",
    "NONE",
  );
  return lines.join("\n");
}

// Parse the parent-review turn's ADJUST/NONE protocol from the buffered assistant text.
// Scans every line; the LAST matching line wins (avoids a stray echo earlier in the turn).
//   `ADJUST: <note>` (non-empty note) → { note }   |   `NONE` → { note: null }
// Returns null when NO line matches (including a bare/empty `ADJUST:`) — the DRIVER coerces that
// to NONE with a loud diag, never fatally (a garbled review must not kill the run).
export function parseParentReview(text: string): { note: string | null } | null {
  let result: { note: string | null } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const adjust = /^\s*ADJUST:\s*(.*\S)\s*$/i.exec(line);
    if (adjust) {
      result = { note: adjust[1] };
      continue;
    }
    if (/^\s*NONE\s*$/i.test(line)) result = { note: null };
  }
  return result;
}

function appendPriorSummaries(lines: string[], summaries: string[]): void {
  if (summaries.length === 0) return;
  lines.push("", "Summaries of the sub-plans completed so far (use them as context):", "");
  for (const s of summaries) lines.push(s, "");
}

// The decomposition plan, parsed into its shared preamble + per-child sections (header, title, body
// span).
export interface ParsedMasterPlan {
  // Everything ABOVE the first sub-plan header — shared context threaded into every child's mandate.
  preamble: string;
  subplans: Array<{ nn: Nn; title: string; body: string }>;
}

// Parse `### Sub-Plan NN: <title>` headers (case-insensitive) from a decomposition plan body into
// the ordered {nn,title,body} sections CHILDREN_PARSED + the per-child Mandates consume. `body` is
// the section span between this header and the next (or end of plan). The matcher stays at \d{1,3}
// ON PURPOSE: a header like `Sub-Plan 100` MUST match and then fail parseNn LOUDLY (a decomposition
// validation error the driver surfaces) — narrowing the regex to \d{1,2} would silently DROP it,
// truncating the decomposition.
export function parseSubPlanHeaders(plan: string): ParsedMasterPlan {
  const raw: Array<{ nnText: string; title: string; start: number; bodyStart: number }> = [];
  const re = /^\s*#{1,6}\s*Sub-Plan\s+(\d{1,3})\s*[:\-—]\s*(.+?)\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    raw.push({ nnText: m[1], title: m[2].trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  // ZERO headers is a RECOVERABLE validation failure (the header-less draft), same typed class
  // as the nn>99 case below. Throwing HERE — before the empty array reaches the CHILDREN_PARSED
  // reducer's nonEmpty boundary — lets the orchestrator's `instanceof PlanValidationError` catch deny
  // the held ExitPlanMode for a redraft (run stays active) instead of FATALing.
  if (raw.length === 0) {
    throw new PlanValidationError(
      "master plan validation failed: the decomposition draft contains no `### Sub-Plan NN: <title>` " +
        "headers — redraft it with at least one sub-plan section using that exact header format",
    );
  }
  const subplans = raw.map((h, i) => {
    const n = Number.parseInt(h.nnText, 10);
    let nn: Nn;
    try {
      nn = parseNn(n);
    } catch {
      throw new PlanValidationError(
        `master plan validation failed: header "Sub-Plan ${h.nnText}: ${h.title}" is outside the ` +
          "supported 1-99 sub-plan range — redraft the master decomposition with at most 99 sub-plans",
      );
    }
    const bodyEnd = i + 1 < raw.length ? raw[i + 1].start : plan.length;
    return { nn, title: h.title, body: plan.slice(h.bodyStart, bodyEnd).trim() };
  });
  // SIBLING-nn UNIQUENESS. Two headers parsing to the SAME nn (e.g. "Sub-Plan 1" and
  // "Sub-Plan 01") mint duplicate-nn siblings — and every navigation primitive resolves nn to the
  // FIRST match, so the run executes one twin while later events alias back to the other, wedging
  // mid-run. Reject HERE (the parse boundary), same typed class as the empty/out-of-range cases, so
  // the `instanceof PlanValidationError` catch DENIES the held ExitPlanMode for a redraft (run stays
  // active, and the malformed master is NEVER persisted — writeAgentPlan runs only after this
  // returns). The reducer's CHILDREN_PARSED guard + assertStructure are defense in depth.
  const seenNn = new Set<Nn>();
  for (const s of subplans) {
    if (seenNn.has(s.nn)) {
      throw new PlanValidationError(
        `master plan validation failed: sub-plan number ${s.nn} appears in more than one header — ` +
          "sibling sub-plan numbers must be unique; redraft the master decomposition with distinct `### Sub-Plan NN:` headers",
      );
    }
    seenNn.add(s.nn);
  }
  const preamble = plan.slice(0, raw[0].start).trim();
  return { preamble, subplans };
}
