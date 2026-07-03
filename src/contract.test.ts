// Wire contract-conformance test (TS side).
//
// HONEST SCOPE: this test locks the SHAPE the frontend EXPECTS of a `list_plans` response —
// the exact thirteen snake_case keys per record — and gives render coverage across all three
// flavors + the cwd null/real-path branches. The fixture is a written statement of the shape the
// frontend depends on, not a copy of a runtime dump, so it asserts intent, not an observation of
// the backend.
//
// It does NOT validate the live backend or assert how Rust serializes `PlanRecord`. The
// authoritative Rust→JSON serialization is asserted by the Rust-side test
// (`planrecord_wire_contract_is_frozen`); drift is therefore caught on the PRODUCING side. This
// test catches drift on the CONSUMING side: if the frontend's expected key set changes (a field
// added/dropped here), the key-set assertion goes red.

import { describe, it, expect, vi, beforeEach } from "vitest";
// Read the REAL index.html (not a hand-built copy) via Vite's `?raw` loader so deleting a
// selector from it makes the relevant assertion go red — the property that makes this a
// genuine contract guard. `?raw` keeps this off @types/node (no fs/process needed).
import INDEX_HTML from "../index.html?raw";
// render/index.ts is the facade that re-exports the comment surface; reading its source makes the
// surface assertion go red if it drops the export.
import RENDER_FACADE_TS from "./render/index.ts?raw";
// The cmt-hl/data-c highlight convention is EMITTED by comments.ts at runtime (not in static
// index.html). Import the real emitter and drive it so the assertion tests the produced DOM, not
// source text — renaming the class or dropping data-c in the executable path turns the test red.
import { wrapRange } from "./render/comments";

// main.ts pulls in Tauri APIs + the render facade at load. Mirror main.test.ts and mock them so
// importing the module is a no-op (it only registers a DOMContentLoaded listener, never fired
// under vitest). We exercise the REAL renderSidebar.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn(async () => "/home/u") }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./render", () => ({
  renderInto: vi.fn(),
  settle: vi.fn(),
  extractToc: vi.fn(() => []),
  applyComments: vi.fn(),
  initComments: vi.fn(),
  onCommentCountChanged: vi.fn(),
  loadCommentsFor: vi.fn(async () => []),
  clearAllComments: vi.fn(),
  invalidatePopover: vi.fn(),
}));
vi.mock("./render/scroll", () => ({ captureAnchor: vi.fn(), applyDelta: vi.fn() }));
// Stub the titlebar wiring functions (importing main.ts must be a no-op), but keep the REAL
// exported constants (TEXT_SIZE_KEY / TEXT_SIZE_LADDER) so the index.html anti-FOUC assertions
// below can be pinned to the single source of truth rather than hardcoded copies.
vi.mock("./titlebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./titlebar")>();
  return { ...actual, initTitlebar: vi.fn(), initThemeToggle: vi.fn(), initTextSize: vi.fn() };
});

import { renderSidebar } from "./main";
import { TEXT_SIZE_KEY, TEXT_SIZE_LADDER } from "./titlebar";
import { asAbsPath, asStem, type PlanRecord, type SidebarCtx, type CommentRecord } from "./types";
import fixture from "./__fixtures__/list_plans.sample.json";

// The thirteen snake_case keys the frontend expects on every PlanRecord, sorted. Written out
// literally so an added/dropped fixture key is caught by the deep-equal below. `nn_path` is the
// Phase-2 additive field: the full canonical dotted id ("02.01"); `nn` stays = first segment.
const EXPECTED_KEYS = [
  "absolute_path",
  "child_count",
  "collapsed",
  "cwd",
  "execution_model",
  "filename_stem",
  "flavor",
  "h1s",
  "mtime_ms",
  "nn",
  "nn_path",
  "tree_id",
  "unread",
].sort();

// Re-brand the two branded string fields (absolute_path / filename_stem) instead of `as any`.
// This shows the raw JSON record is STRUCTURALLY compatible with PlanRecord apart from the
// compile-time brand: every other field flows through unchanged, typed by PlanRecord.
function toPlanRecord(raw: (typeof fixture)[number]): PlanRecord {
  return {
    ...raw,
    flavor: raw.flavor as PlanRecord["flavor"],
    absolute_path: asAbsPath(raw.absolute_path),
    filename_stem: asStem(raw.filename_stem),
  };
}

const records: PlanRecord[] = fixture.map(toPlanRecord);

function makeCtx(over: Partial<SidebarCtx> = {}): SidebarCtx {
  return {
    openPath: null,
    collapseOverride: new Map(),
    subCollapse: new Map(),
    onOpen: vi.fn(),
    onToggleCollapse: vi.fn(),
    ...over,
  };
}

let listEl: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  listEl = document.createElement("div");
  listEl.id = "plan-list";
  document.body.appendChild(listEl);
});

describe("contract — fixture sanity (authored against the PlanRecord wire shape)", () => {
  it("contains exactly one master, two subs, and one standalone in pre-ordered display shape", () => {
    expect(fixture.map((r) => r.flavor)).toEqual(["master", "sub", "sub", "standalone"]);
  });

  it("covers both cwd states: at least one null cwd and at least one real-path cwd", () => {
    expect(fixture.some((r) => r.cwd === null)).toBe(true);
    expect(fixture.some((r) => typeof r.cwd === "string" && r.cwd.length > 0)).toBe(true);
  });

  it("the master has a non-null tree_id, child_count>=1, collapsed:false; subs share its tree_id with an nn", () => {
    const master = fixture.find((r) => r.flavor === "master")!;
    expect(master.tree_id).not.toBeNull();
    expect(master.child_count).toBeGreaterThanOrEqual(1);
    expect(master.collapsed).toBe(false);

    const subs = fixture.filter((r) => r.flavor === "sub");
    for (const sub of subs) {
      expect(sub.tree_id).toBe(master.tree_id);
      expect(typeof sub.nn).toBe("number");
      // nn_path is the canonical dotted id; for these flat (depth-1) subs it is the
      // zero-padded single segment, and nn equals its first segment.
      expect(typeof sub.nn_path).toBe("string");
      expect(Number(sub.nn_path!.split(".")[0])).toBe(sub.nn);
    }
  });

  it("the standalone has null tree_id, nn, and child_count", () => {
    const standalone = fixture.find((r) => r.flavor === "standalone")!;
    expect(standalone.tree_id).toBeNull();
    expect(standalone.nn).toBeNull();
    expect(standalone.child_count).toBeNull();
  });
});

describe("contract — PlanRecord key set is locked", () => {
  it("EVERY fixture record has exactly the thirteen expected snake_case keys (no more, no fewer)", () => {
    for (const raw of fixture) {
      expect(Object.keys(raw).sort()).toEqual(EXPECTED_KEYS);
    }
  });

  it("the expected key set is exactly thirteen keys", () => {
    expect(EXPECTED_KEYS).toHaveLength(13);
  });
});

describe("contract — fixture is consumable as PlanRecord[]", () => {
  it("re-branding the two branded fields yields a structurally-complete PlanRecord per record", () => {
    expect(records).toHaveLength(fixture.length);
    for (const rec of records) {
      // Branded slots carry the same underlying string value (brands erase at runtime).
      expect(typeof (rec.absolute_path as unknown as string)).toBe("string");
      expect(typeof (rec.filename_stem as unknown as string)).toBe("string");
      // Non-branded fields survive the spread unchanged and keep their contract types.
      expect(typeof rec.mtime_ms).toBe("number");
      expect(typeof rec.unread).toBe("boolean");
      expect(typeof rec.collapsed).toBe("boolean");
      expect(["master", "sub", "standalone"]).toContain(rec.flavor);
      expect(rec.cwd === null || typeof rec.cwd === "string").toBe(true);
      expect(rec.tree_id === null || typeof rec.tree_id === "string").toBe(true);
      expect(rec.nn === null || typeof rec.nn === "number").toBe(true);
      expect(rec.nn_path === null || typeof rec.nn_path === "string").toBe(true);
      expect(rec.child_count === null || typeof rec.child_count === "number").toBe(true);
    }
  });
});

describe("contract — table-of-contents sidebar selectors present in index.html", () => {
  // Each token is a selector/markup fragment the ToC feature depends on. The test reads the
  // real file, so removing any one of these from index.html turns its assertion red.
  const TOKENS = [
    "tab-row",
    'data-tab="plans"',
    'data-tab="contents"',
    'id="tab-plans"',
    'id="tab-contents"',
    'id="toc-list"',
    // Sidebar filter: the real interactive control inside the frozen .search container.
    'id="plan-filter"',
    'class="search"',
    'class="clear"',
    // theme toggle in the .titlebar-controls slot + the persisted-theme
    // localStorage key (pins the inline anti-FOUC script's key to the contract).
    'class="titlebar-controls"',
    'id="theme-toggle"',
    "plan-reader-theme",
  ];
  for (const token of TOKENS) {
    it(`index.html contains \`${token}\``, () => {
      expect(INDEX_HTML).toContain(token);
    });
  }

  it("#plan-count stays inside the plans pane's sidebar-head (not relocated)", () => {
    // The plans pane head still carries the frozen #plan-count selector.
    expect(INDEX_HTML).toMatch(/id="tab-plans"[\s\S]*id="plan-count"[\s\S]*id="plan-list"/);
  });
});

describe("contract — text-size anti-FOUC literals pinned in index.html", () => {
  // The inline anti-FOUC script in index.html duplicates the text-size key + ladder literally
  // (it cannot import module constants before first paint). These assertions read the REAL
  // index.html and pin those literals to titlebar.ts's single source of truth, so if the inline
  // script drifts from TEXT_SIZE_KEY / TEXT_SIZE_LADDER (or the steppers / CSS var are removed),
  // the relevant assertion goes red. Mirrors how `plan-reader-theme` is pinned above.

  it("pins the localStorage key against titlebar.ts's TEXT_SIZE_KEY", () => {
    expect(TEXT_SIZE_KEY).toBe("plan-reader-text-size");
    expect(INDEX_HTML).toContain(TEXT_SIZE_KEY);
  });

  it("pins the ladder literal byte-for-byte against titlebar.ts's TEXT_SIZE_LADDER", () => {
    // index.html writes the ladder as a JS array literal with `, ` separators: `[13, 14, 15, 17, 19, 21]`.
    // Build the expected string from the real constant so a changed rung fails BOTH sides at once.
    const ladderLiteral = "[" + TEXT_SIZE_LADDER.join(", ") + "]";
    expect(ladderLiteral).toBe("[13, 14, 15, 17, 19, 21]");
    expect(INDEX_HTML).toContain(ladderLiteral);
  });

  it("pins the stepper button ids and the --reading-font-size CSS variable", () => {
    expect(INDEX_HTML).toContain('id="text-dec"');
    expect(INDEX_HTML).toContain('id="text-inc"');
    expect(INDEX_HTML).toContain("--reading-font-size");
  });
});

describe("contract — highlight/comment selectors present in index.html", () => {
  // Popover markup the comment feature depends on. Reads the real file, so removing any of
  // these from index.html turns its assertion red.
  const TOKENS = [
    'id="sel-popover"',
    'id="sp-quote"',
    'id="sp-text"',
    'id="sp-cancel"',
    'id="sp-save"',
  ];
  for (const token of TOKENS) {
    it(`index.html contains \`${token}\``, () => {
      expect(INDEX_HTML).toContain(token);
    });
  }

  it("the popover lives OUTSIDE #reading-pane (survives the pane's innerHTML wipe)", () => {
    // #reading-pane is an empty <div> in the markup; the popover must NOT be nested inside it.
    // Assert the popover markup appears AFTER the #reading-pane element closes, as a sibling
    // under .window. (A naive nesting would place #sel-popover between #reading-pane's tags.)
    const paneIdx = INDEX_HTML.indexOf('id="reading-pane"');
    const popIdx = INDEX_HTML.indexOf('id="sel-popover"');
    expect(paneIdx).toBeGreaterThan(-1);
    expect(popIdx).toBeGreaterThan(paneIdx);
    // The #reading-pane div is self-contained (`<div ... id="reading-pane"></div>`), so the
    // popover cannot be a descendant — it appears later in the document as a sibling.
    expect(INDEX_HTML).toMatch(/id="reading-pane"><\/div>/);
  });

  it("the popover has NO data-tauri-drag-region (it is not part of the titlebar)", () => {
    // Slice from the popover's start to its save button and assert the drag attribute is absent
    // within that region (the titlebar above it does carry it, so a global check would be wrong).
    const start = INDEX_HTML.indexOf('id="sel-popover"');
    const end = INDEX_HTML.indexOf('id="sp-save"');
    const region = INDEX_HTML.slice(start, end);
    expect(region).not.toContain("data-tauri-drag-region");
  });

  it("the emitter produces a span.cmt-hl carrying data-c=<id> around the wrapped range", () => {
    // Drive the REAL emitter (wrapRange) over a jsdom Range and assert on the produced DOM, not on
    // source text — so renaming the class or dropping the data-c attribute in the executable path
    // turns this red (a source-grep would pass off the stale JSDoc comment).
    const container = document.createElement("p");
    container.textContent = "highlight this text";
    document.body.appendChild(container);

    const textNode = container.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);

    const id = 7;
    wrapRange(range, id);

    const span = container.querySelector<HTMLElement>("span.cmt-hl");
    expect(span).toBeTruthy();
    expect(span!.classList.contains("cmt-hl")).toBe(true);
    expect(span!.dataset.c).toBe(String(id));
    expect(span!.getAttribute("data-c")).toBe(String(id));
  });
});

describe("contract — Prompt Feedback button + overlay are REMOVED from index.html", () => {
  // The old titlebar "Prompt Feedback" button + its overlay were removed (commenting goes through the
  // conversation composer + the #review-bar now). These tokens must NOT appear anywhere in the real
  // index.html, so a re-introduction turns this red.
  const REMOVED = [
    'id="feedback-btn"',
    'id="feedback-count"',
    'id="feedback-overlay"',
    'id="feedback-body"',
    'id="feedback-copy"',
    'id="feedback-clear"',
  ];
  for (const token of REMOVED) {
    it(`index.html does NOT contain \`${token}\``, () => {
      expect(INDEX_HTML).not.toContain(token);
    });
  }

  it("the render facade re-exports clearAllComments (the comment-clear surface)", () => {
    expect(RENDER_FACADE_TS).toContain("clearAllComments");
  });
});

describe("contract — #sdk-status pill lives in the sidebar (moved off the titlebar)", () => {
  it("#sdk-status appears INSIDE the sidebar's Plans tab, not the titlebar-controls", () => {
    const statusIdx = INDEX_HTML.indexOf('id="sdk-status"');
    expect(statusIdx).toBeGreaterThan(-1);
    // It must come AFTER the sidebar's Plans head (#plan-count) — i.e. it is sidebar chrome now.
    const planCountIdx = INDEX_HTML.indexOf('id="plan-count"');
    expect(planCountIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(planCountIdx);
    // And it must NOT sit between the titlebar-controls open and the #new-plan-btn (its old home).
    const controlsIdx = INDEX_HTML.indexOf('class="titlebar-controls"');
    const themeToggleIdx = INDEX_HTML.indexOf('id="theme-toggle"');
    const titlebarControlsSlice = INDEX_HTML.slice(controlsIdx, themeToggleIdx);
    expect(titlebarControlsSlice).not.toContain('id="sdk-status"');
  });
});

describe("contract — conversation-header live model chip selector present in index.html", () => {
  // The live execution-model chip is queried by id from main.ts (convModelChipEl) and lives inside
  // the conversation toolbar. Removing it from index.html would silently no-op the chip — this pin
  // reads the real file so that turns red.
  it("index.html contains the #conversation-model-chip inside the conv-toolbar", () => {
    expect(INDEX_HTML).toContain('id="conversation-model-chip"');
    // It sits within the conversation toolbar, before the session controls (Pause/Resume/Stop).
    const toolbarIdx = INDEX_HTML.indexOf('class="conv-toolbar"');
    const chipIdx = INDEX_HTML.indexOf('id="conversation-model-chip"');
    const pauseIdx = INDEX_HTML.indexOf('id="conversation-pause"');
    expect(toolbarIdx).toBeGreaterThan(-1);
    expect(chipIdx).toBeGreaterThan(toolbarIdx);
    expect(pauseIdx).toBeGreaterThan(chipIdx);
  });
});

describe("contract — CommentRecord carries exactly its 6 fields (separate from PlanRecord)", () => {
  // DERIVED FROM THE TYPE, not a hand-written literal: the keymap is `satisfies
  // Record<keyof CommentRecord, true>`, so the COMPILER enforces it covers EVERY key of the
  // interface. Adding a 6th interface field → tsc fails (the keymap is missing that key);
  // renaming a field → tsc fails (the keymap names a key that no longer exists). Either way the
  // freeze is falsifiable via the type, not just runtime. PlanRecord is UNAFFECTED — comments do
  // not ride on it (EXPECTED_KEYS stays thirteen, untouched). The authoritative Rust→JSON freeze is
  // the cargo test `comment_record_wire_contract_is_frozen`.
  const COMMENT_KEY_MAP = {
    quote: true,
    block_line: true,
    block_end_line: true,
    occurrence: true,
    comment: true,
    id: true,
  } satisfies Record<keyof CommentRecord, true>;
  const COMMENT_KEYS = Object.keys(COMMENT_KEY_MAP).sort();

  const EXPECTED_COMMENT_KEYS = ["block_end_line", "block_line", "comment", "id", "occurrence", "quote"].sort();

  it("the type-derived CommentRecord key set is exactly the six expected snake_case keys", () => {
    // The keymap is exhaustive over keyof CommentRecord (compile-enforced); this runtime check
    // pins the EXACT key names so a renamed field (which still type-checks if both sides rename)
    // is caught against the written contract.
    expect(COMMENT_KEYS).toEqual(EXPECTED_COMMENT_KEYS);
    expect(COMMENT_KEYS).toHaveLength(6);
  });

  it("a CommentRecord literal carries exactly those keys, with block_line nullable (both branches)", () => {
    const anchored: CommentRecord = { quote: "hello", block_line: 5, block_end_line: 8, occurrence: 1, comment: "note", id: 0 };
    const wholePane: CommentRecord = { quote: "floating", block_line: null, block_end_line: null, occurrence: 0, comment: "note2", id: 1 };
    expect(Object.keys(anchored).sort()).toEqual(COMMENT_KEYS);
    expect(Object.keys(wholePane).sort()).toEqual(COMMENT_KEYS);
    // block_line covers BOTH branches: a number and null (the no-block-ancestor type, no -1).
    expect(typeof anchored.block_line).toBe("number");
    expect(wholePane.block_line).toBeNull();
  });
});

describe("contract — render coverage across flavors + cwd states", () => {
  it("renders all three flavors from the fixture without throwing: master row, sub rows, standalone row", () => {
    expect(() => renderSidebar(listEl, records, makeCtx())).not.toThrow();

    // master → .master wrapper with a .master-row
    const masterRow = listEl.querySelector('.master .master-row[data-path="/Users/u/.claude/plans/master-alpha.md"]');
    expect(masterRow).toBeTruthy();

    // both subs nested under the master's .children
    const subs = listEl.querySelectorAll(".master .children .plan.sub");
    expect(subs.length).toBe(2);

    // standalone → a flat .plan that is neither .master nor .sub
    const standalone = listEl.querySelector<HTMLElement>(
      '.plan[data-path="/Users/u/.claude/plans/standalone-solo.md"]',
    )!;
    expect(standalone).toBeTruthy();
    expect(standalone.classList.contains("master")).toBe(false);
    expect(standalone.classList.contains("sub")).toBe(false);
  });

  it("the .plan-src cwd display covers BOTH branches: real-path cwd shown verbatim, null cwd ⇒ empty", () => {
    renderSidebar(listEl, records, makeCtx());

    // real-path branch: rec.cwd wins in planSrcText. homePath is unset under vitest (homeDir is
    // mocked but never invoked since DOMContentLoaded never fires), so displayCwd returns the
    // path verbatim — the master row's .plan-src shows its real cwd.
    const masterSrc = listEl.querySelector<HTMLElement>(
      '.master .master-row[data-path="/Users/u/.claude/plans/master-alpha.md"] .plan-src',
    )!;
    expect(masterSrc).toBeTruthy();
    expect(masterSrc.textContent).toBe("/Users/u/work/alpha");

    // null-cwd branch: standalone-solo has cwd:null and its stem is absent from cwdByStem
    // (unresolved) ⇒ empty string (no "unknown" flash).
    const standaloneSrc = listEl.querySelector<HTMLElement>(
      '.plan[data-path="/Users/u/.claude/plans/standalone-solo.md"] .plan-src',
    )!;
    expect(standaloneSrc).toBeTruthy();
    expect(standaloneSrc.textContent).toBe("");
  });

  // The PERSISTED-row model badge (no live orchestrator snapshot in this test module, so
  // rowModelState reads rec.execution_model off the wire — a chip only, no auto/override affordance).
  it("renders a .mbadge for a record with execution_model, omits it for null/unknown", () => {
    const withModel: PlanRecord = {
      absolute_path: asAbsPath("/Users/u/.claude/plans/badge-sonnet.md"),
      filename_stem: asStem("badge-sonnet"),
      mtime_ms: 5,
      cwd: null,
      unread: false,
      flavor: "standalone",
      tree_id: null,
      nn: null,
      nn_path: null,
      child_count: null,
      collapsed: false,
      h1s: [],
      execution_model: { model: "claude-sonnet-5" },
    };
    const noModel: PlanRecord = {
      ...withModel,
      absolute_path: asAbsPath("/Users/u/.claude/plans/badge-none.md"),
      filename_stem: asStem("badge-none"),
      execution_model: null,
    };
    const unknownModel: PlanRecord = {
      ...withModel,
      absolute_path: asAbsPath("/Users/u/.claude/plans/badge-unknown.md"),
      filename_stem: asStem("badge-unknown"),
      execution_model: { model: "gpt-4o" },
    };

    renderSidebar(listEl, [withModel, noModel, unknownModel], makeCtx());

    // present branch: a Sonnet chip on the plan-row.
    const badge = listEl.querySelector<HTMLElement>(
      '.plan[data-path="/Users/u/.claude/plans/badge-sonnet.md"] .plan-row .mbadge',
    );
    expect(badge).toBeTruthy();
    expect(badge!.classList.contains("sonnet")).toBe(true);
    expect(badge!.textContent).toBe("Sonnet 5");
    // persisted row: NO auto/override affordance (source is off-wire).
    expect(badge!.querySelector(".rec")).toBeNull();
    expect(badge!.classList.contains("override")).toBe(false);

    // FALSIFY: render the badge unconditionally → these absence assertions go RED.
    expect(
      listEl.querySelector('.plan[data-path="/Users/u/.claude/plans/badge-none.md"] .mbadge'),
    ).toBeNull();
    expect(
      listEl.querySelector('.plan[data-path="/Users/u/.claude/plans/badge-unknown.md"] .mbadge'),
    ).toBeNull();
  });
});
