#!/usr/bin/env node
// Generator for the co-located invariant catalog.
//
// Source of truth: the `// INVARIANT[name] (tier): ...` doc-comments sitting
// directly above the construct they describe in src/**/*.ts, sidecar/**/*.ts, and
// src-tauri/**/*.rs (Rust uses the same `//` line-comment syntax, so the parser is shared).
// This script greps those blocks, resolves a FRESH anchor (the line number of the
// first real code line below each block, computed now so it never rots), and emits
// a deterministic INVARIANTS.md index at the repo root.
//
// Usage:
//   node scripts/gen-invariants.mjs           writes INVARIANTS.md, exits 0
//   node scripts/gen-invariants.mjs --check    regenerates in memory, diffs against
//                                              the on-disk file, exits 1 if stale (CI)
//
// Flags (compose with the above):
//   --exclude <a,b,c>  or  --exclude=a,b,c    skip these repo-relative source files
//                                             during the scan (comma-separated; may be
//                                             repeated). Honored by --check too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(REPO_ROOT, "INVARIANTS.md");

// Scan roots (recursive) and exclusion rules.
const SCAN_ROOTS = ["src", "sidecar", "src-tauri"];
const isExcluded = (rel) =>
  rel.endsWith(".test.ts") ||
  rel.endsWith(".d.ts") ||
  rel.startsWith("src/mock/") ||
  rel.startsWith("src-tauri/target/"); // Cargo build artifacts, not source

// Tiers ranked strongest -> weakest (PART A order). Drives the legend, the summary
// table columns, and tier validation.
const TIERS = [
  "type-level",
  "runtime-guard",
  "precedence",
  "reducer-total",
  "containment",
  "sanitization",
  "test-pinned",
  "convention",
];

const TIER_LEGEND = {
  "type-level": "the property is enforced by the type system — the invalid state does not compile.",
  "runtime-guard": "an explicit runtime check rejects or neutralizes the invalid state.",
  "precedence": "an ordering / priority of rules guarantees the property (e.g. SDK hook precedence).",
  "reducer-total": "a total, exhaustive pure reducer maps every input to a defined valid state.",
  "containment": "writes or effects are constrained to a bounded path / scope.",
  "sanitization": "untrusted content is cleansed before it reaches a sink.",
  "test-pinned": "the property holds because a test pins it — no structural enforcement.",
  "convention": "a discipline the code follows (grep-verifiable), not compiler- or test-enforced.",
};

// Domain order for the sections + summary rows.
const DOMAINS = [
  "Reading-pane render",
  "Conversation / live-session",
  "App shell — selection / review / gates",
  "Sidecar / agent-driver",
  "Rust backend (`src-tauri/`)",
  "Other",
];

function domainFor(rel) {
  if (rel.startsWith("src/render/")) return "Reading-pane render";
  if (rel.startsWith("src/conversation/")) return "Conversation / live-session";
  if (rel === "src/main.ts" || rel === "src/review.ts" || rel === "src/prototype.ts")
    return "App shell — selection / review / gates";
  if (rel.startsWith("sidecar/")) return "Sidecar / agent-driver";
  if (rel.startsWith("src-tauri/")) return "Rust backend (`src-tauri/`)";
  return "Other";
}

function walk(absDir, relDir, out, excludes) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort for deterministic traversal.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      walk(path.join(absDir, ent.name), rel, out, excludes);
    } else if (
      ent.isFile() &&
      (ent.name.endsWith(".ts") || ent.name.endsWith(".rs")) &&
      !isExcluded(rel) &&
      !excludes.has(rel)
    ) {
      out.push(rel);
    }
  }
}

function discoverFiles(excludes) {
  const files = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(REPO_ROOT, root), root, files, excludes);
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return files;
}

const HEADER_RE = /^\s*\/\/\s*INVARIANT\[([^\]]+)\]\s*\(([^)]+)\)\s*:\s*(.*)$/;
const CONT_RE = /^\s*\/\/\s+(prevents|test)\s*:\s*(.*)$/;

const isBlank = (line) => line.trim() === "";
const isComment = (line) => {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
};

/** Parse every INVARIANT block in one file's text. Returns an array of block records. */
function parseFile(rel, text) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = HEADER_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const headerLine = i + 1; // 1-based
    const name = m[1].trim();
    const tier = m[2].trim();
    const statement = m[3].trim();

    // Consume the `prevents:` / `test:` continuation lines.
    let prevents = null;
    const tests = [];
    let j = i + 1;
    while (j < lines.length) {
      const c = CONT_RE.exec(lines[j]);
      if (!c) break;
      if (c[1] === "prevents") prevents = c[2].trim();
      else tests.push(c[2].trim());
      j++;
    }

    // Resolve the anchor: first non-blank, non-comment line below the block. Stacked
    // INVARIANT blocks (consecutive comment lines) all resolve to the same construct.
    let k = j;
    while (k < lines.length && (isBlank(lines[k]) || isComment(lines[k]))) k++;
    const hasAnchor = k < lines.length;
    const anchorLine = hasAnchor ? k + 1 : 0; // 1-based
    const symbol = hasAnchor ? lines[k].trim() : "(no anchor — block at end of file)";

    blocks.push({
      file: rel,
      domain: domainFor(rel),
      name,
      tier,
      statement,
      prevents,
      tests,
      headerLine,
      anchorLine,
      symbol,
    });

    // Resume from the first non-continuation line so a stacked block's header is seen next.
    i = j;
  }
  return blocks;
}

function tierBadge(tier) {
  const valid = TIERS.includes(tier);
  return valid ? `**\`${tier}\`**` : `**\`${tier}\`** ⚠️(unknown tier)`;
}

function renderTests(tests) {
  if (!tests.length) return "—";
  return tests.map((t) => `\`${t}\``).join(", ");
}

function renderInvariant(b) {
  const out = [];
  out.push(`### ${b.name}`);
  out.push(`${tierBadge(b.tier)} — ${b.statement}`);
  out.push("");
  out.push(`**Prevents:** ${b.prevents ?? "_(missing — prevents is required)_"}`);
  out.push("");
  out.push(`**Anchor:** \`${b.file}:${b.anchorLine}\` — \`${b.symbol}\``);
  // The Tests line is CONDITIONAL: emit it only when the block declares ≥1 `test:`
  // entry. Compact blocks (header + prevents only) omit it entirely — never "Tests: —".
  if (b.tests.length > 0) {
    out.push("");
    out.push(`**Tests:** ${renderTests(b.tests)}`);
  }
  return out.join("\n");
}

function compareBlocks(a, b) {
  const da = DOMAINS.indexOf(a.domain);
  const db = DOMAINS.indexOf(b.domain);
  if (da !== db) return da - db;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.anchorLine !== b.anchorLine) return a.anchorLine - b.anchorLine;
  return a.headerLine - b.headerLine; // tiebreak for stacked blocks
}

function buildSummaryTable(blocks) {
  // counts[domain][tier]
  const counts = {};
  for (const d of DOMAINS) {
    counts[d] = {};
    for (const t of TIERS) counts[d][t] = 0;
  }
  for (const b of blocks) {
    if (counts[b.domain] && b.tier in counts[b.domain]) counts[b.domain][b.tier]++;
  }

  const header = `| Domain | ${TIERS.join(" | ")} | Total |`;
  const divider = `|${"---|".repeat(TIERS.length + 2)}`;
  const rows = [header, divider];

  const colTotals = {};
  for (const t of TIERS) colTotals[t] = 0;
  let grand = 0;

  for (const d of DOMAINS) {
    const cells = TIERS.map((t) => {
      colTotals[t] += counts[d][t];
      return String(counts[d][t]);
    });
    const rowTotal = TIERS.reduce((s, t) => s + counts[d][t], 0);
    grand += rowTotal;
    rows.push(`| ${d} | ${cells.join(" | ")} | ${rowTotal} |`);
  }

  const totalCells = TIERS.map((t) => String(colTotals[t]));
  rows.push(`| **Total** | ${totalCells.join(" | ")} | ${grand} |`);
  return rows.join("\n");
}

function generate(blocks) {
  const out = [];

  out.push("# Invariants catalog");
  out.push("");
  out.push(
    "> **GENERATED FILE — do not edit by hand. Run `npm run gen:invariants`. Source of truth: the `// INVARIANT[...]` comments in the code.**",
  );
  out.push("");
  out.push(
    "Each invariant is a named property that always holds, documented as a co-located doc-comment directly above the construct that guarantees it. Line numbers below are recomputed at generation time, so they never rot — the comment next to the code is authoritative.",
  );
  out.push("");

  // Tier legend.
  out.push("## Tier legend");
  out.push("");
  out.push("Ranked strongest → weakest (how hard the invariant is to violate):");
  out.push("");
  for (const t of TIERS) {
    out.push(`- **\`${t}\`** — ${TIER_LEGEND[t]}`);
  }
  out.push("");

  // Summary table.
  out.push("## Summary (count per domain × tier)");
  out.push("");
  out.push(buildSummaryTable(blocks));
  out.push("");

  // One section per domain (only domains that have invariants get a body; empty
  // domains still get a heading + a note so the structure is stable).
  const byDomain = {};
  for (const d of DOMAINS) byDomain[d] = [];
  for (const b of blocks) {
    if (byDomain[b.domain]) byDomain[b.domain].push(b);
  }

  for (const d of DOMAINS) {
    const list = byDomain[d].slice().sort(compareBlocks);
    out.push(`## ${d}`);
    out.push("");
    if (list.length === 0) {
      out.push("_No invariants annotated yet in this domain._");
      out.push("");
      continue;
    }
    for (let idx = 0; idx < list.length; idx++) {
      out.push(renderInvariant(list[idx]));
      out.push("");
    }
  }

  // Trailing static stubs (NOT scanned by the generator).
  out.push("## §Mock harness (`src/mock/`)");
  out.push("");
  out.push("NOT YET AUDITED — this branch did not touch it; tracked as a follow-up.");
  out.push("(Static placeholder — the generator does not scan this tree.)");
  out.push("");

  return out.join("\n");
}

/**
 * Parse `--exclude <a,b,c>` and `--exclude=a,b,c` flags out of argv into a Set of
 * repo-relative paths to skip during the scan. Both forms may be repeated and their
 * values are unioned. Absent flag → empty set (no exclusions; legacy behavior).
 */
function parseExcludes(argv) {
  const set = new Set();
  const add = (csv) => {
    for (const part of csv.split(",")) {
      const t = part.trim();
      if (t) set.add(t);
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--exclude") {
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        add(val);
        i++; // consume the value token
      }
    } else if (a.startsWith("--exclude=")) {
      add(a.slice("--exclude=".length));
    }
  }
  return set;
}

function collectBlocks(excludes) {
  const files = discoverFiles(excludes);
  const blocks = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    blocks.push(...parseFile(rel, text));
  }
  blocks.sort(compareBlocks);
  return blocks;
}

/**
 * Structural problems that make a block malformed, regardless of staleness:
 *   (a) an unknown tier (not in the 8-tier set), or
 *   (b) a missing `prevents:` line (prevents is required).
 * Returns a flat list of human-readable, per-block messages (empty when all blocks
 * are well-formed). `--check` treats a non-empty list as a hard failure; a normal run
 * prints the same messages as warnings but still writes the file.
 */
function findBlockProblems(blocks) {
  const problems = [];
  for (const b of blocks) {
    const where = `${b.file}:${b.headerLine} INVARIANT[${b.name}]`;
    if (!TIERS.includes(b.tier)) {
      problems.push(`${where}: unknown tier "${b.tier}" (valid: ${TIERS.join(", ")}).`);
    }
    if (b.prevents === null) {
      problems.push(`${where}: missing required "prevents:" line.`);
    }
  }
  return problems;
}

function main() {
  const check = process.argv.includes("--check");
  const excludes = parseExcludes(process.argv.slice(2));
  const blocks = collectBlocks(excludes);
  const problems = findBlockProblems(blocks);
  const content = generate(blocks);

  if (check) {
    // STRICT: a malformed block (unknown tier / missing prevents) fails CI outright,
    // independent of whether the on-disk file is stale.
    if (problems.length > 0) {
      console.error("INVARIANTS.md check FAILED — malformed INVARIANT block(s):");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    let onDisk = null;
    try {
      onDisk = fs.readFileSync(OUT_PATH, "utf8");
    } catch {
      onDisk = null;
    }
    if (onDisk !== content) {
      console.error(
        "INVARIANTS.md is OUT OF DATE (or missing). Run `npm run gen:invariants` to regenerate.",
      );
      process.exit(1);
    }
    console.log(`INVARIANTS.md is up to date (${blocks.length} invariants).`);
    process.exit(0);
  }

  // Normal run: surface the same problems as warnings, but still write the file so
  // the catalog stays regenerable while malformed blocks are being fixed.
  if (problems.length > 0) {
    console.warn("WARNING — malformed INVARIANT block(s) (run with --check to fail CI):");
    for (const p of problems) console.warn(`  - ${p}`);
  }

  fs.writeFileSync(OUT_PATH, content, "utf8");
  console.log(`Wrote ${OUT_PATH} (${blocks.length} invariants).`);
}

main();
