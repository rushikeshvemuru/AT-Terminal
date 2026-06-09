# AT-Terminal Codex Guide

AT-Terminal is a Tauri v2 desktop app with a React/TypeScript/Vite frontend, a Rust Tauri shell, and iframe/native module panels. Keep changes scoped, verify the stack you touch, and prefer existing patterns over new abstractions.

## Shell

- Prefix shell commands with `rtk` in this workspace when supported, for example `rtk npm run build`.
- Use `rg` and `rg --files` for code search.
- Do not edit generated or build output such as `dist/`, `node_modules/`, or `src-tauri/target/`.

## Stack

- Frontend: React 18, TypeScript, Vite, Tailwind, shadcn/Radix-style primitives, Zustand.
- Desktop shell: Tauri v2, Rust 2021, commands under `src-tauri/src/commands/`.
- Module runtime: `AT-modules/` metadata plus optional module server processes supervised by the Tauri shell.
- Base terminal runtime: `AT-modules/base/server`, a Rust HTTP/WebSocket server using `portable-pty`.
- Terminal UI: iframe-backed `base.terminal` panel using vendored `xterm.js` assets.
- Editor UI: native React `base.monaco` panel using Monaco.
- Path alias: `@/*` maps to `src/*`.
- Display name is `AT-Terminal`; package identifiers may use safe names such as `com.at.terminal`.

## Commands

- Frontend dev: `npm run dev`
- Full app dev: `npm run tauri dev`
- Frontend build/typecheck: `npm run build`
- Frontend lint: `npm run lint`
- Frontend format: `npm run format`
- Tauri Rust check: `cargo check -p at-terminal`
- Base module server Rust check: `cargo check -p at-terminal-base-module`
- Whole Rust workspace check: `cargo check --workspace`
- Icon manifest: `npm run generate-icons`

Run Rust commands from the repo root for workspace checks, or from `src-tauri/` when intentionally checking only the Tauri crate. When adding npm packages, use `npm_config_legacy_peer_deps=true` because the repo has an ESLint peer dependency conflict.

## Architecture

- Frontend IPC uses `invoke()` from `@tauri-apps/api/core`.
- New Tauri commands live under `src-tauri/src/commands/` and must be re-exported from `commands/mod.rs` and registered in `main.rs` `generate_handler![]`.
- Custom `invoke()` commands do not need Tauri capability permissions. Tauri plugin APIs do.
- Add a Tauri plugin in four places: Rust crate, `.plugin(...::init())`, capability permission, and npm package.
- Never call Tauri APIs such as `getCurrentWindow()` at module scope. Use handlers or effects with error handling.
- Rust event emission requires `use tauri::Emitter;`.
- Await `listen()` before invoking commands that may immediately emit events.
- Tauri config uses a custom frameless window; window controls require capability permissions in `src-tauri/capabilities/default.json`.

## Modules And Panels

- `AT-modules/module_config.json` controls active modules.
- Each module has `AT-modules/{module}/metadata.json`; legacy `meta-data.json` is still accepted by the Rust loader.
- Runtime panel types are lowercase namespaced strings such as `base.terminal`, `base.empty`, and `base.monaco`.
- Prefer `EMPTY_PANEL_TYPE`, `TERMINAL_PANEL_TYPE`, and `MONACO_PANEL_TYPE` constants from `src/lib/panelRegistry.ts`.
- The Rust module manager reads metadata, starts `startup_script_command` from the module directory, health-checks modules, and writes `src/panel_types.json`.
- Module supervision treats declared toolbar icon assets as part of module health for iframe panels, so a stale server that still answers `/health` but no longer serves current toolbar assets should be replaced.
- `PanelWorkspace` uses `getNativePanelComponent()` first, otherwise renders iframe panels through `ModulePanelHost`.
- Register native panels at module load time with `registerNativePanel()`, not in `useEffect`.
- Native panel components must satisfy `PanelProps` from `src/lib/panelRegistry.ts`.
- Iframe panels receive `panelId`, `panelType`, `localType`, `rootDirectory`, `startupCommand`, and `startupNonce` via query params.
- Iframe panel toolbar metadata is keyed by local panel type. Runtime toolbar updates use `postMessage`, live in `usePanelToolbarStore`, and are not persisted.
- Same-origin SVG `icon_path` assets can be rendered inline by the host so toolbar icons authored with `currentColor` inherit button color.
- For module authoring details, use `docs/module-authoring-guide.md`, `docs/module-metadata-reference.md`, and `docs/panel-toolbar-protocol.md`.

## State And Persistence

- `useSessionStore` owns session navigation and active session identity.
- `useTabStore` owns session-scoped UI state: tabs, panels, active IDs, side panel state, explorer selection, drag state, context menus, and rename dialog.
- Most tab and panel actions require `sessionId` first. Use `useActiveSessionId()` or `useActiveSessionTabState()`.
- Each `Tab` has `rootDirectory`, `panels`, and `activePanelId`.
- Panel metadata includes `id`, `name`, `type`, optional `state`, and optional `preview`.
- `useTabPersistence` debounces session tab-state saves by 300ms through `save_tab_state`.
- Session files live under `~/.atterm/sessions/`; terminal iframe scrollback currently uses browser `localStorage` keys `at-terminal-buffer:{panelId}`.
- Add `#[serde(default)]` to new or optional Rust fields stored in existing JSON.
- Keep Rust `snake_case` and TypeScript `camelCase` mappings explicit across persistence boundaries.

## Terminal Runtime

- Terminal PTYs are not managed by Tauri state in `src-tauri`; they are created by `AT-modules/base/server`.
- The base module server listens on `127.0.0.1:47831`, serves `/panels/terminal`, and accepts `/ws/terminal`.
- `AT-modules/base/scripts/start.sh` is allowed to clear any process already bound to `127.0.0.1:47831` before launching the base server so stale module processes do not survive app restarts.
- `terminal.js` opens a WebSocket, sends input as `i...`, commands as `c...`, and resize messages as `r:{cols}:{rows}`.
- `portable-pty` blocking reads must use `std::thread::spawn`, not `tokio::spawn`.
- `take_writer()` can only be called once per PTY master.
- Persistent panel components must remain mounted across visibility changes. Use CSS visibility and pointer-events patterns; do not conditionally unmount side-effectful panels.
- The base terminal has tmux toolbar integration through panel state `tmuxMode` and `at.panelToolbar.*` messages.
- The tmux manager popup is iframe-backed from `AT-modules/base/ui/tmux-manager.html` with behavior in `tmux-manager.js` and styles in `base.css`. Keep it minimal and dark: compact header, session tree on the left, selected item actions/details on the right, and advanced command/activity output collapsed by default.

## Tmux Format Parsing

- Use `|||` (triple pipe) as the tmux format field separator in Rust, not `\x1f` — control characters can be stripped in certain environments, causing all rows to parse as single-field and be dropped by length checks.
- When parsing tmux output, log raw line count and field count on first line when results are unexpected (e.g., 0 sessions but non-empty output).
- Add fallback parsing: if primary format yields 0 sessions but raw output was non-empty, retry with a simpler format like `#{session_id}|||#{session_name}`.
- `#{session_path}` requires tmux ≥ 3.2; use `parse_tmux_version()` to select appropriate format strings for older versions.

## File, Editor, And Git

- File commands enforce workspace containment for text reads/writes and cap editor files at 10 MiB.
- Monaco preview/open behavior is VS Code-like: single-click preview, double-click permanent, and only one preview panel per tab.
- File explorer drag-to-move should work from the whole row with a small movement threshold; avoid drag-handle icons and root-drop helper banners.
- Destructive file and git operations must go through the confirmation store.
- Git operations run through Rust commands and shell out to `git`/`gh`; keep long-running work off the UI thread with the existing async/blocking patterns.
- GitHub auth uses `keyring`, a local OAuth callback listener, and emits `git-auth-updated`.

## UI Conventions

- Preserve the dense terminal/tool UI. Do not introduce decorative landing-page patterns for app screens.
- Use existing shadcn/Radix/Tailwind patterns and lucide icons where appropriate.
- Keep app layout stable: `HeaderBar`, optional `Toolbar`, main row, `FooterBar`, then overlays.
- Tmux manager UI should match the app's dark terminal palette with near-black surfaces, neutral borders, restrained status colors, compact rows/buttons, and no dashboard-style card grid.
- Radix context menu items should use `onSelect`, not `onClick`.
- Keep side panel default behavior in sync wherever a fallback `true` is used.

## Verification

- TypeScript/frontend changes: run `npm run build`; run `npm run lint` when practical.
- Tauri shell Rust changes: run `cargo check -p at-terminal`.
- Base module server Rust changes: run `cargo check -p at-terminal-base-module`.
- Cross-cutting Rust changes: run `cargo check --workspace`.
- UI changes affecting layout, tabs, panels, dialogs, xterm, or module iframes should be checked in the running app when feasible.
- If verification cannot be run, state exactly what was skipped and why.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, invoke the `skill` tool with `skill: "graphify"` before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
