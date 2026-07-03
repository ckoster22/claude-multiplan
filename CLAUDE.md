# Claude Multiplan

macOS desktop app (Tauri v2) that browses and live-renders Claude Code plan markdown files from `~/.claude/plans/`. The sidebar lists plans newest-first with each plan's originating working directory and a bold title when it has unread edits; the reading pane renders full-fidelity markdown (mermaid, images, links, code) and auto-reloads in place when a plan changes on disk.

## Stack
- **Tauri v2** (~2.11): Rust backend (`src-tauri/`) + system WebView frontend.
- **Frontend**: vanilla TypeScript + Vite. Rendering via `markdown-it`, `highlight.js`, `mermaid` (lazy-loaded), `dompurify`.
- **Tests**: `vitest` (jsdom) for the frontend, `cargo test` for Rust.

## Commands
- `npm run tauri dev` — run in development (hot reload).
- `npm run tauri build` — build the distributable `.app`/`.dmg` (output under `src-tauri/target/release/bundle/`).
- `npm test` — frontend unit tests (vitest).
- `npx tsc --noEmit` — typecheck.
- `cd src-tauri && cargo test --lib` — backend unit tests.
- `npm run mock` — token-free visual harness in a browser (`http://localhost:1421`); real frontend against an in-memory Tauri shim (`src/mock/`).
- `npm run build:sidecar` — build the `agent-driver` sidecar binary (run automatically by `tauri dev`/`build`).

## Architecture
- **Rust backend** (`src-tauri/src/lib.rs`): commands `list_plans` (mtime-sorted; fills cached `cwd` + `unread` per plan), `read_plan_contents`, `read_image_as_data_url`, `resolve_cwds`, `set_open_plan`, `mark_viewed`; a `notify` file watcher over `~/.claude/plans/` emitting the `plan-changed` event. State (cwd cache + read-state) is persisted under the Tauri app-data dir as `cwd-cache.json` / `read-state.json` via atomic temp-write+rename.
- **Frontend**: `src/main.ts` wires commands/events; `src/render/` owns the reading pane (markdown/mermaid/image/link rendering); `src/cwd.ts` + `src/resolve.ts` own the sidebar cwd/read-state; `src/titlebar.ts` owns window drag/zoom; `src/conversation/` owns the live-session domain (the `orchestrator.ts` recursive multiplan driver + its pure `plan-tree.ts` reducer, the `stream.ts`/`render.ts` conversation pane, composer, history); `src/model-picker.ts`, `src/prototype.ts`, and `src/review.ts` own the model/effort picker, prototype gate, and review bar. The reading pane and the sidebar are separate domains — keep them disjoint.
- The DOM selector contract and the Tauri command/event/wire shapes are pinned by tests, not a standalone doc: `src/contract.test.ts` (frontend selectors + `PlanRecord`/`CommentRecord` key sets) and the Rust `*_wire_contract_is_frozen` cargo tests (`PlanRecord`/`CommentRecord`/`ReviewRequest`/`ReviewResponse` serialization).

## Integration testing (token-free LLM emulator)
Use this any time you want to integration-test the full app — the sidecar pipeline AND the frontend render — across the LLM response classes (text, tool_use/tool_result, plan/prototype writes, review cycle, subagent fan-out, quota/rate-limit, 529 overload with retry/mid-turn/exhaustion, permission_denied, mid-stream errors, and auth/transport failures) WITHOUT spending Anthropic tokens. The emulator swaps the SDK's `query()` inside the sidecar, gated on the `EMU_SCENARIO` env var (unset → real `query()`, unchanged); scenarios live in `sidecar/emulator-scenes.ts` (`SCENARIO_NAMES`). Token cost is zero.

Two verification layers, one canonical fixture set:
- **Layer 1 — sidecar spawned-binary e2e** (`sidecar/emulator-e2e.test.ts`): `EMU_SCENARIO=<name>` drives the compiled `agent-driver` binary and asserts its fd-1 stdout JSON-line frames against `sidecar/__goldens__/*.jsonl`.
- **Layer 2 — frontend replay** (`src/mock/golden.ts`, `src/mock/golden-scenes.test.ts`): replays those captured goldens through the host's real fd-1 → event demux into the `src/mock` shim and renders them.

How to run (from repo root):
- `npm test` — both layers (the e2e file skips loudly if the bun/rustc toolchain is missing).
- `npx vitest run sidecar/emulator-e2e.test.ts` — Layer 1 only (builds + spawns the binary).
- `UPDATE_GOLDENS=1 npx vitest run sidecar/emulator-e2e.test.ts` — regenerate the goldens.
- `npm run mock` → http://localhost:1421, pick from the **"Presets · golden replay"** group to watch a scenario render.
- `npx vitest run src/mock/golden-scenes.test.ts` — Layer 2 only.

To add a scenario: add it to `sidecar/emulator-scenes.ts` (and `SCENARIO_NAMES`), add its exit code to `sidecar/exit-codes.ts` if non-zero, then regenerate goldens with `UPDATE_GOLDENS=1`; the frontend roster/picker/lockstep sweep pick it up automatically from the `__goldens__/*.jsonl` glob.

Key invariant: the goldens are the single source of truth for the fd-1 frame contract. The frontend replays them — it never re-derives frames through a second in-process pipeline — so the two layers cannot drift (`golden-scenes.test.ts` pins this with a golden-diff identity gate).

## Conventions & gotchas (learned the hard way)
- **Window drag** requires the `core:window:allow-start-dragging` capability in `src-tauri/capabilities/default.json` — it is NOT included in `core:default`. `data-tauri-drag-region` silently no-ops without it. Double-click-to-zoom needs `core:window:allow-toggle-maximize` (note: `allow-toggle-maximization` is NOT a valid permission name).
- **Local images** cannot be served via Tauri's asset protocol: its `FsScope` globs do not match path segments beginning with `.` (e.g. `~/.claude/...`), so they 403. Use the `read_image_as_data_url` Rust command instead; CSP stays `null`.
- **mermaid** is initialized with `securityLevel: "loose"` (needed for `<br/>`/HTML labels), which does NOT auto-sanitize — the rendered SVG is sanitized with DOMPurify before `innerHTML` (the config must preserve `foreignObject` / HTML integration points or multi-line labels collapse).
- **cwd resolution**: a plan's originating directory is found by scanning `~/.claude/projects/<encoded-cwd>/*.jsonl` AND `<session>/subagents/agent-*.jsonl` (~40% of plans are written by subagents) for the plan-write event, then reading that record's in-file `cwd`. Never reverse-decode the encoded directory name (it is lossy). For app-generated plan-tree plans the `tree-cwd-index.json` app-data file (`tree_id → cwd`, written on `write_plan_tree_file`) is the fast-path. Unresolved → render "unknown".
- **CLI plan-save duplicates**: the bundled Claude Code CLI saves ITS OWN frontmatter-less copy of every plan-mode plan (on ExitPlanMode) into `~/.claude/plans/`, slugged from the session's first user message + a random word pair (e.g. `we-are-running-the-vast-pebble.md`) — a byte-identical duplicate of the app's `write_agent_plan` copy that renders as a separate top-level standalone sidebar row. The sidecar redirects these via the `plansDirectory` flag-setting to `.plan-tree/cli-plans/` (`sidecar/cli-plans.ts`); the value MUST stay a relative path (the CLI requires it to resolve inside the project root).
- **Read/unread**: a plan is unread when its mtime is newer than its last-viewed time; the currently-open plan continuously updates its last-viewed time so live edits to the plan you are actively watching do not mark it unread.
- **Prototype permission seam**: the host-side `"prototype"` write policy (writes allowed only under `<cwd>/.plan-tree/prototype/`) maps to SDK permissionMode `"default"`, because SDK `"plan"` mode hard-blocks `Write` at the CLI tier regardless of `canUseTool`. But in `"default"` mode the user's `~/.claude/settings.json` `permissions.allow` rules evaluate BEFORE `canUseTool` (SDK precedence: PreToolUse hooks → deny rules → mode → allow rules → `canUseTool`) — so containment is enforced at the PreToolUse hook tier (`sidecar/permissions.ts` `prototypeHookDecision` / `createPrototypePreToolUseHook`). Never rely on `canUseTool` alone for `"default"`-mode sessions.
- The app reads two **read-only** trees under `~/.claude/`: `plans/` (rendered + watched) and `projects/` (used only for cwd resolution). It also writes to a self-owned control directory `~/.claude/plan-reader/**` (review IPC: requests/responses + an `app.alive` heartbeat, all atomic + containment-guarded) and performs a single idempotent additive merge into `~/.claude/settings.json` to install/remove the ExitPlanMode review hook. As the app becomes a standalone Claude Code replacement, it now also **writes its own agent-produced plans into `~/.claude/plans/`** via the `write_agent_plan` command (atomic temp+rename, containment-guarded to the plans dir, frontmatter-tagged with `tree_id`/`flavor`/`nn` for sidebar nesting) — `plans/` is now its canonical, single-rooted plan store, not a read-only tree. It still NEVER writes into `~/.claude/projects/`.

## Comments

A comment is justified for exactly TWO reasons. If a comment serves neither, delete it — and never write one that does.

1. **A non-obvious "why" or "how"** — and only when the code cannot be made self-evident on its own. Always prefer restructuring, renaming, or simplifying the code so it explains itself; reach for a comment only when readable code still cannot convey the rationale or mechanism (a non-obvious constraint, an ordering requirement, a platform quirk/workaround, a subtle algorithm, an external contract). The gotchas above are the bar: each explains something the code genuinely cannot.
2. **The invariants script** — the machine-parsed `// INVARIANT[name] (tier): …` headers and their `//   prevents:` / `//   test:` continuation lines (`scripts/gen-invariants.mjs` → `INVARIANTS.md`). These are load-bearing; `npm run gen:invariants` regenerates the catalog when they or the code around them move.

Everything else is noise — remove it. In particular, NEVER write:
- **Historical / provenance tracking**: "relocated verbatim from…", "moved from X", "formerly in…", "was previously…", "(orig lines …)", "import path shifts", changelog / PR / ticket references. Git history is the record of change; the source is not.
- **Restating what the code plainly does**: narration a reader already gets from the names, types, and control flow.
- **Decorative section-divider banners** and JSDoc that only echoes the signature.

Prefer readable code with no comment over clever code that needs one.

## Invariants
- **Invariants must be grounded in code, not comments.** When documenting, cataloging, or asserting that an invariant holds, its evidence MUST be an actual enforcing construct:
  - a **type / discriminated union** that makes the invalid state unconstructable, or
  - a **runtime guard / ordering / idempotent operation** in executable code, or
  - a **test** that asserts it (ideally falsifiable — inverting the production code makes it fail).
- A code comment is **not** evidence — including comments that say `// INVARIANT:`, "single source of truth", "always", or "never". Comments drift and can lie; verify the enforcing code before claiming the invariant holds, and cite the construct (the union/guard/test), never the comment.
- When cataloging invariants, label each with the tier where the **named behavioral guarantee actually lives**, not merely where a related type exists. A tagged union that only supplies a value (e.g. a status enum) while a runtime reducer enforces the guarantee is a **runtime** invariant, not a type-level one.

## Notes
- The app is unsigned; first launch needs right-click → Open (Gatekeeper). Signing/notarization is not configured.
- `.plan-tree/` holds the multiplan planning state (master plan + per-sub-plan plans and summaries) used to build this project.
