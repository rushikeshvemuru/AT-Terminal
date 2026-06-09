# AT-Terminal v0.1.0 Public Beta Release Readiness

Audit date: 2026-06-07

Audited branch: `feature/terminal-block`

Audited commit: `2db7d65da99ad51aeb441f74ed80a1b7cfb168ab`

Host used for verification: Linux x86_64, Node `v24.16.0`, npm `11.13.0`, cargo `1.95.0`

## Executive Verdict

AT-Terminal is not ready for a v0.1.0 public beta yet.

The core source tree is promising: frontend production builds pass, Rust checks pass, Rust tests pass, the base module server can be built in release mode, and the Linux Tauri binary can be compiled. The release is blocked by quality gates and release-packaging gaps rather than by a single architectural failure.

The highest-priority blockers are:

1. `npm run lint` fails on three React hook rules.
2. `npm run test:e2e` fails because the Playwright test expects `tmux-state-22` while the base module is now `tmux-state-25`.
3. Full `npm run tauri build` fails for `bundle.targets = "all"` because AppImage bundling cannot find a usable square app icon.
4. Public beta basics are missing: README, LICENSE, CHANGELOG, SECURITY policy, contributor/support docs, and release notes.
5. Rust lockfiles exist locally but are not tracked, while `.gitignore` ignores `Cargo.lock`; this weakens reproducibility for a desktop app release.
6. Local dependency state is inconsistent: `npm ls --depth=0` reports installed `@tauri-apps/cli@2.11.2` as invalid because `package.json`/`package-lock.json` pin `2.9.2`.

Recommended release posture: treat v0.1.0 as blocked until the release-gate checklist below is green.

## Scope

This review covered:

- React/TypeScript/Vite frontend structure.
- Tauri v2 shell, command registration, capabilities, persistence, and module supervision.
- Base module server, terminal PTY path, tmux manager path, HTTP/WebSocket authorization, and bundled runtime path.
- File explorer/editor safety boundaries.
- Git/GitHub command surface and destructive operation flow.
- Browser preview surface.
- Build, test, dependency, packaging, and release documentation readiness.
- Cross-platform release risks for Linux, macOS, and Windows based on local code/config inspection.

This review did not complete:

- A network vulnerability audit. `npm audit` was not run because the chosen scope was no external network checks. `cargo audit` is not installed in this environment.
- Manual GUI smoke testing in a running Tauri app.
- macOS or Windows build execution.
- Installer install/uninstall smoke testing.
- Code signing, notarization, or antivirus reputation checks.

## Release Gates

These should be green before calling v0.1.0 a public beta:

| Gate                 | Current Status | Required Action                                                                                    |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Frontend build       | Pass           | Keep green.                                                                                        |
| Frontend lint        | Fail           | Fix hook lint violations in `Toolbar.tsx` and `MonacoEditorPanel.tsx`.                             |
| Rust checks          | Pass           | Keep `cargo check -p at-terminal` and `cargo check -p at-terminal-base-module` green.              |
| Rust tests           | Pass           | Keep `cargo test --workspace` green.                                                               |
| E2E tests            | Fail           | Update stale expected base module version and rerun.                                               |
| Tauri full bundle    | Fail           | Add valid app icons and prove all intended bundle targets build.                                   |
| Clean install        | Fail/unknown   | Fix local `@tauri-apps/cli` mismatch; prove `npm ci` works from a clean checkout.                  |
| Rust reproducibility | Fail           | Track the appropriate workspace `Cargo.lock` and stop ignoring release lockfiles.                  |
| Public docs          | Fail           | Add README, LICENSE, CHANGELOG, SECURITY, known issues, install/uninstall notes.                   |
| Dependency audit     | Unknown        | Run approved `npm audit` and `cargo audit`/equivalent before public release.                       |
| Cross-platform smoke | Unknown        | Test Linux, macOS, Windows launch, terminal, editor, Git, browser preview, and uninstall.          |
| Data safety smoke    | Unknown        | Test session recovery, file write conflict, destructive confirmations, and corrupted session JSON. |

## Verification Results

| Command                                                          | Result  | Notes                                                                                                               |
| ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `rtk npm run build`                                              | Pass    | TypeScript and Vite production build completed. Vite reports large chunks.                                          |
| `rtk npm run lint`                                               | Fail    | Three hook lint errors.                                                                                             |
| `rtk cargo check -p at-terminal`                                 | Pass    | Tauri shell checks.                                                                                                 |
| `rtk cargo check -p at-terminal-base-module`                     | Pass    | Base module server checks.                                                                                          |
| `rtk cargo test --workspace`                                     | Pass    | 23 Rust tests passed.                                                                                               |
| `rtk npm run prepare-tauri-bundle`                               | Pass    | Frontend built and Linux base module binary copied to `AT-modules/base/server/bin/`.                                |
| `NODE_OPTIONS=--max-old-space-size=4096 rtk npm run tauri build` | Fail    | Linux app binary built; `.deb` and `.rpm` bundling began; AppImage bundling aborted due missing usable square icon. |
| `rtk npm run test:e2e`                                           | Fail    | Sandboxed run could not start base module; escalated run failed because expected version is stale.                  |
| `rtk npm ls --depth=0`                                           | Fail    | Local `node_modules` has invalid `@tauri-apps/cli@2.11.2` against `2.9.2` pin.                                      |
| `cargo audit`                                                    | Not run | Command is not installed.                                                                                           |
| `npm audit`                                                      | Not run | Skipped because this audit scope avoided external network checks.                                                   |

## Blocking Findings

### B1. Lint Fails

`npm run lint` currently fails with three React hook rule errors:

- `src/components/Toolbar.tsx:582`: `setValue(item.value)` inside an effect.
- `src/components/Toolbar.tsx:622`: `setValue(String(item.value))` inside an effect.
- `src/components/panels/MonacoEditorPanel.tsx:98`: `setDiffLayoutOverride(null)` inside an effect.

Risk: public beta builds can ship with known React lifecycle problems. Even if these are benign today, they are exactly the type of issues that become state desynchronization, repeated renders, or brittle UI behavior after small changes.

Release action: fix or intentionally suppress with a clear local justification only if the rule is truly inapplicable.

### B2. E2E Tests Are Red Due Version Drift

`tests/e2e/tmux.spec.ts` expects:

```text
tmux-state-22
```

The base module currently reports:

```text
tmux-state-25
```

Evidence:

- `AT-modules/base/server/src/tmux.rs` defines `MODULE_VERSION` as `tmux-state-25`.
- `AT-modules/base/metadata.json` validates `tmux-state-25`.
- The E2E spec still expects `tmux-state-22`.

Risk: the only Playwright E2E test suite is not usable as a release signal. This is a release-process failure even if product behavior is fine.

Release action: update the expected version, rerun the E2E suite, and keep version expectations centralized if possible.

### B3. Full Tauri Bundle Fails

`npm run tauri build` reaches the Linux release binary and starts bundling, then aborts:

```text
couldn't find a square icon to use as AppImage icon
```

Current icon state:

- `src-tauri/icons/icon.png` is tracked.
- That file is a 1x1 PNG.
- `src-tauri/tauri.conf.json` does not declare a bundle icon list.
- `bundle.targets` is `"all"`, which includes AppImage on Linux.

Risk: a public release cannot be produced from the current default release command.

Release action: generate proper Tauri icon assets, configure them, rerun `npm run tauri build`, and verify `.deb`, `.rpm`, AppImage, and any platform-specific targets that will actually be published.

### B4. Public Beta Documentation Is Missing

No files were found for:

- README
- LICENSE
- CHANGELOG
- SECURITY
- CONTRIBUTING
- GitHub workflow/release metadata under `.github`

Risk: public beta users will not know what the app does, what platforms are supported, what permissions it needs, how to report bugs, what license applies, or what data is stored locally.

Release action: add at least README, LICENSE, CHANGELOG, SECURITY, install/uninstall notes, known issues, platform support matrix, and a privacy/data-storage note.

### B5. Rust Lockfiles Are Not Tracked

`Cargo.lock` and `src-tauri/Cargo.lock` exist locally, but `git ls-files` does not list either one. `.gitignore` ignores `Cargo.lock`.

Risk: release builds are less reproducible and future dependency resolution can drift. For a Tauri desktop application, the release should normally commit the workspace lockfile.

Release action: decide on one authoritative Rust workspace lockfile, track it, and update `.gitignore` so release lockfiles are not silently dropped.

### B6. Local Node Dependency State Is Invalid

`npm ls --depth=0` reports an invalid installed dependency:

- Installed: `@tauri-apps/cli@2.11.2`
- Pinned in package/lock: `@tauri-apps/cli@2.9.2`

The repo also mixes related Tauri versions:

- `@tauri-apps/api`: `2.11.0`
- Rust `tauri`: `2.11.2`
- Rust `tauri-build`: `2.6.2`
- npm `@tauri-apps/cli`: `2.9.2`

Risk: a release built from the current machine may not match a clean checkout, and Tauri CLI/runtime version skew can create packaging surprises.

Release action: run a clean install, align Tauri versions deliberately, and prove `npm ci`, `npm run build`, and `npm run tauri build` from a clean checkout.

## High-Risk Findings

### H1. Security Review Needs To Be Written Down

AT-Terminal intentionally exposes powerful local capabilities:

- terminal PTYs
- shell command execution for terminal blocks
- filesystem reads/writes/moves/deletes inside selected roots
- Git destructive operations
- browser preview webviews
- module iframes
- localhost HTTP/WebSocket services

These are reasonable for a terminal/editor app, but public beta users need explicit expectations.

Release action: write a SECURITY/privacy document explaining local command execution, filesystem scope, Git credential handling, browser preview behavior, localhost module services, and where session data is stored.

### H2. IPC Surface Is Broad

`src-tauri/src/main.rs` registers a large invoke surface covering sessions, windows, files, Git, GitHub auth, browser panels, terminal blocks, buffers, modules, and diagnostics.

Strengths:

- Commands are grouped under `src-tauri/src/commands/`.
- Most filesystem/editor commands canonicalize paths.
- Git commands generally resolve repository roots and pathspecs.
- Destructive frontend workflows use confirmation dialogs.

Risks:

- The backend does not enforce all user-confirmation semantics itself; it trusts the frontend for destructive confirmations.
- The broad command surface has limited automated test coverage.
- Custom invoke commands do not need Tauri capability permissions, so correctness depends on command-level validation.

Release action: add smoke tests or focused unit tests for the highest-risk command paths: delete/move, Git discard, worktree removal, terminal block lifecycle, browser panel close, and session save/recovery.

### H3. Module Iframes Should Check Origin Explicitly

`ModulePanelHost` verifies `event.source === iframe.contentWindow` for postMessage handling. That is useful, but the handler should also validate `event.origin` against the expected module origin before accepting panel state, toolbar, or popup messages.

Risk: source checks are strong for the direct iframe, but origin checks make the trust boundary easier to audit and safer if URLs, redirects, or module sources evolve.

Release action: add explicit origin validation for panel postMessage traffic and include tests for rejected messages.

### H4. CSP And Capabilities Are Broad For Beta

The current CSP allows broad localhost connectivity and HTTPS frames:

- `connect-src` includes `http://127.0.0.1:*` and `ws://127.0.0.1:*`.
- `frame-src` includes `http://127.0.0.1:*` and `https:`.
- `style-src` includes `'unsafe-inline'`.

The default capability includes:

- `shell:allow-open`
- `dialog:allow-open`
- several window-control permissions

Risk: this may be intentional for module panels and browser previews, but it should be reviewed and documented. Broad localhost permissions increase the importance of strict module URL and token handling.

Release action: document why each CSP source and plugin permission is needed. Tighten anything not required for v0.1.0.

### H5. Dependency Audit Is Incomplete

The lockfile contains deprecated packages:

- `core-js@2.6.12`
- `fs-promise@0.5.0`
- `glob@7.2.3`
- `har-validator@5.1.5`
- `inflight@1.0.6`
- `request@2.88.2`
- `request-promise@3.0.0`
- `rimraf@2.7.1`
- `uuid@3.4.0`
- `xterm@5.3.0`
- `xterm-addon-fit@0.8.0`
- `xterm-addon-serialize@0.11.0`

Risk: deprecated packages are not automatically vulnerabilities, but `request`-era packages and old `xterm` packages are weak signals for future maintenance and security review. The terminal iframe uses vendored xterm assets, so this needs a deliberate migration/acceptance decision.

Release action: run an approved network audit, remove avoidable deprecated transitive dependencies, and plan migration from `xterm*` to `@xterm/*` where practical.

### H6. Bundle Identity And Naming Are Inconsistent

Current observed names:

- Project guide/display name: `AT-Terminal`
- Tauri `productName`: `AT Terminal`
- Tauri window title: `AT-Terminal`
- Rust package description: `AT Terminal Scaffold`

Risk: package names, app titles, installer names, docs, crash reports, and user-facing support all drift.

Release action: choose one public display name and update product metadata, descriptions, README, release assets, and installer names.

## Medium-Risk Findings

### M1. Base Module Startup Script Does Not Match The Project Guide

The project guide says `AT-modules/base/scripts/start.sh` is allowed to clear any process bound to `127.0.0.1:47831` before launching.

Current script behavior:

- It changes to the module directory.
- It runs `cargo run --manifest-path server/Cargo.toml --quiet`.
- It does not clear a stale process on port `47831`.

The app runtime now chooses a dynamic local port and token, which reduces the practical impact inside the Tauri app. The fixed `47831` path still matters for direct module development, metadata defaults, and some test assumptions.

Release action: either update the script or update the guide to match the dynamic-port runtime.

### M2. Base Module Release Fallback Is Inconsistent By Platform

The module manager prefers a bundled base server binary in release mode. If it is missing:

- Windows release errors.
- Non-Windows release can fall back to the shell startup script.

Risk: a bad release package may silently rely on source/cargo availability on Linux/macOS but fail differently on Windows.

Release action: for public builds, make missing bundled base binaries a hard release failure on every platform, or document the fallback as a dev-only path.

### M3. Base Module Auth Uses Query Tokens

The base module runtime uses a random token and appends `atToken` to panel, health, and validation URLs. The server accepts token via query, bearer header, `x-at-terminal-token`, or cookie. Assets under `/assets/` are public.

Strengths:

- The server binds to `127.0.0.1`.
- API and WebSocket routes are protected when a token is configured.
- Origin checks exist for protected HTTP requests.

Risks:

- Query tokens can leak through logs, copied URLs, browser history, or error traces.
- Public assets are probably fine, but this should remain intentional.

Release action: accept this consciously for beta or move API calls to header/cookie auth where feasible. Document that module URLs include local auth tokens.

### M4. Terminal And Tmux Commands Execute Shell Commands By Design

Terminal panels, terminal blocks, tmux manager commands, and startup commands can execute shell commands on the user's machine.

Risk: expected for a terminal app, but beta users must not mistake modules or panels for sandboxed content.

Release action: document command execution clearly. For module authors, state that module startup commands and panel startup commands are trusted local code.

### M5. Browser Preview Loads Remote Pages

Browser preview windows allow `http` and `https` external URLs in Tauri webviews.

Risk: remote pages can contact the internet, set cookies/storage in the webview context, and behave like embedded browser content. That is fine if advertised, risky if surprising.

Release action: add privacy notes and test browser preview navigation/history behavior.

### M6. Detached Tab Bounds Backend Is A No-Op

`update_detached_tab_bounds` returns success but does not persist anything in the Tauri backend. The frontend tracks detached bounds in tab state and persistence may still cover the intended behavior.

Risk: the command name suggests persistence that the backend does not perform, making this easy to misread and easy to break.

Release action: verify detached window restore across restart. Either remove/rename the no-op command or document why frontend persistence is authoritative.

### M7. File Explorer Listing Is Broader Than Editor Writes

Text reads/writes enforce workspace containment and a 10 MiB cap. `list_directory(path, include_hidden)` accepts a direct path and is not scoped to a saved root in the same way.

Risk: this is likely intended because users choose local folders, but it should be understood as local filesystem browsing rather than project-sandbox browsing.

Release action: document folder access expectations and ensure the UI never lists paths without user selection.

### M8. Performance Needs Manual Profiling

Production Vite builds pass, but bundle output includes large chunks:

- Main app JS around 1.99 MB minified, 461 KB gzip.
- Monaco chunk around 3.84 MB minified, 996 KB gzip.
- TypeScript worker around 7.03 MB.

Risk: desktop apps tolerate larger bundles than websites, but startup, detached windows, and Monaco first-load latency should be measured.

Release action: smoke test cold launch, opening the first editor, opening multiple terminals, detaching tabs, and reopening saved sessions.

### M9. Generated/Tracked/Ignored File Policy Is Blurry

Observed:

- `src/panel_types.json` is tracked but `.gitignore` also ignores it.
- `test-results/.last-run.json` is tracked and became dirty during E2E.
- `dist/`, `target/`, and `AT-modules/base/server/bin/` are generated/ignored as expected.

Risk: release candidates can pick up noisy generated-state changes, and clean checkouts may not match local generated outputs.

Release action: decide which generated files are committed and which are never committed. Update `.gitignore` and tests accordingly.

## Architecture Review

### Product Shape

AT-Terminal is a Tauri v2 desktop app with:

- React/TypeScript/Vite frontend.
- Rust Tauri shell.
- Zustand-based session/tab/panel state.
- Native React panel support for built-in panels.
- Iframe module panels served by local module servers.
- A base module server for terminal and tmux behavior.
- Local session persistence under `~/.atterm`.

The architecture is suitable for a beta terminal/editor app, but it exposes more trust boundaries than a normal single-window editor: Tauri IPC, local module server HTTP, WebSocket terminal sessions, iframe postMessage, Git subprocesses, and browser webviews.

### Frontend

Strengths:

- Panel types are centralized in `src/lib/panelRegistry.ts`.
- Native panels are registered up front instead of inside effects.
- Session-aware Zustand stores keep tabs/panels scoped by session.
- Persistent panels are intended to remain mounted across visibility changes.
- Destructive UI workflows generally use the confirmation store.
- The layout keeps a dense terminal/tool style suitable for the product.

Risks:

- Lint failures show lifecycle patterns need cleanup.
- No frontend unit/component test suite was observed.
- Large chunks need profiling.
- Error and empty states should be manually smoked for module startup failure, missing folder, missing Git, missing `gh`, missing tmux, and failed browser navigation.

### Session Persistence

Strengths:

- Session IDs and names are validated.
- Session metadata writes use backup/temp/rename behavior.
- Existing metadata structs use serde defaults for backward compatibility.
- Tab/panel state persistence is debounced.
- On window close, pending save is flushed before destroy.

Risks:

- Corrupt session JSON recovery should be tested manually.
- Detached tab behavior needs restart testing.
- Terminal scrollback is stored via browser localStorage keys by panel ID; this is convenient but separate from `~/.atterm/sessions`.

Beta tests to add:

- Create, rename, delete session.
- Close app immediately after tab changes; verify saved state.
- Corrupt a session file; verify app starts and gives recoverable behavior.
- Restore panels across restart, including terminal, Monaco, browser preview, and detached tabs.

### Filesystem And Editor

Strengths:

- Text reads/writes canonicalize root and target.
- Writes reject files outside root.
- Writes enforce expected modified time.
- Editor files are capped at 10 MiB.
- Existing tests cover symlink escape and outside-root delete.

Risks:

- Directory listing and reveal operations are broader local filesystem operations.
- Rename/move/delete behavior should be manually tested across files, directories, symlinks, hidden files, and permission-denied paths.
- Platform-specific reserved names and path behavior need Windows/macOS smoke testing.

Beta tests to add:

- File edit conflict.
- Unsaved editor close/discard.
- Rename across existing path.
- Move into nested folder.
- Delete recursive directory after confirmation.
- Permission denied on read/write/delete.

### Terminal Runtime

Strengths:

- Terminal PTYs are owned by the base module server, not hidden inside Tauri state.
- Blocking PTY reads use `std::thread::spawn`.
- `take_writer()` is used once.
- Terminal WebSocket message protocol is simple.
- PTY process is killed on disconnect.
- Root directory fallback to home is explicit.

Risks:

- PTY behavior is OS-sensitive.
- Terminal resize, disconnect/reconnect, shell startup command, and scrollback restore need manual testing.
- Terminal localStorage buffer keys can accumulate over time.

Beta tests to add:

- Open terminal in selected project root.
- Resize panel repeatedly.
- Close terminal panel.
- Restart app and verify terminal buffer behavior.
- Run long output command.
- Run interactive shell command.
- Test shell absence/fallback on Linux/macOS/Windows.

### Tmux

Strengths:

- `tmux-state-25` format uses `|||` separators, avoiding control-character stripping.
- Parser has fallback behavior for older tmux formats.
- Unit tests cover several tmux parsing paths.
- Tmux manager has compact iframe UI and collapsed advanced output.

Risks:

- E2E is red.
- tmux availability/version varies by user machine.
- tmux command endpoint executes tmux command strings via shell; this is expected but should be clearly trusted-user behavior.

Beta tests to add:

- No tmux installed.
- tmux installed but old version.
- Existing sessions with panes/windows.
- Attach/detach flows.
- Create/kill session from manager.
- Toolbar state sync after restart.

### Module Runtime

Strengths:

- Base module runtime gets a dynamic local port and token.
- Metadata URLs are rewritten from default `127.0.0.1:47831` to runtime origin.
- Health checks validate module server endpoints and declared assets.
- Supervisors restart unhealthy modules with backoff.
- Runtime panel metadata is generated for the frontend.

Risks:

- Generated `src/panel_types.json` policy is unclear.
- Health-check failures and restart loops need visible diagnostics for beta users.
- Release binary fallback behavior should be hardened.
- Module server assets and validation should be tested after release packaging, not only in dev.

Beta tests to add:

- Launch app with base module binary present.
- Launch app after deleting/renaming base module binary in a test package.
- Kill base module process during app use; verify recovery and user-facing state.
- Validate terminal toolbar icons and tmux manager asset loading.

### Git And GitHub

Strengths:

- Git operations run off the UI thread.
- Repository root is resolved through Git.
- Path-specific Git operations reject absolute paths outside the repo.
- Network operations disable interactive terminal prompting.
- Destructive UI actions have confirmation dialogs.
- GitHub OAuth token storage uses keyring.

Risks:

- Backend destructive commands can be invoked without frontend confirmation.
- GitHub OAuth requires environment configuration and may be nonfunctional for public beta unless documented.
- SSH remotes are explicitly outside app-managed auth.
- `gh` availability and auth setup need clear error states.
- `git checkout -- .` and `git clean -fd` for discard all are intentionally destructive and need careful copy.

Beta tests to add:

- Repo with no remote.
- GitHub HTTPS remote without `gh`.
- Authenticated GitHub HTTPS remote.
- SSH remote.
- Branch checkout with dirty tree.
- Merge conflict.
- Stash/pop conflict.
- Discard all after confirmation.
- Worktree create/remove.

### Browser Preview

Strengths:

- URLs are restricted to `http` and `https`.
- Browser panel state is tracked and emitted back to the frontend.
- Browser preview is separate from normal module iframes.

Risks:

- No public privacy doc.
- Browser preview can load arbitrary internet content.
- Installers and CSP should be reviewed for how external content behaves on each platform.

Beta tests to add:

- Navigate to `http` and `https`.
- Invalid URL.
- Localhost URL.
- Back/forward/history persistence.
- Close/reopen browser preview.

### Security And Privacy

Current strengths:

- Tauri capabilities are explicit in `src-tauri/capabilities/default.json`.
- Custom command validation exists in filesystem and Git paths.
- Base module binds localhost.
- Base module API/WS routes are token-protected when launched by the app.
- Popup routes reject cross-origin URLs.

Main beta risks:

- Broad local capabilities are not documented.
- No SECURITY.md.
- CSP is permissive for localhost and frames.
- iframe postMessage lacks explicit origin validation.
- Query tokens can appear in URLs/traces.
- Browser preview privacy expectations are not documented.
- GitHub OAuth setup is environment-dependent.

Release action: write the docs, tighten obvious config, and add a short threat-model section for trusted local modules versus untrusted external content.

### Packaging And Distribution

Current strengths:

- `prepare-tauri-bundle` builds and copies the base module binary.
- Linux `.deb` and `.rpm` artifacts were created before AppImage bundling aborted.
- Tauri resource config maps `../AT-modules` into the package.

Current gaps:

- AppImage target fails.
- App icon is a 1x1 placeholder.
- No evidence of code signing/notarization.
- No platform-specific installer notes.
- No auto-update strategy observed.
- No release CI observed.
- No clean checkout build proof.

Release action: define what v0.1.0 will publish by platform. If Linux only, change targets from `"all"` to the intended target set. If all desktop platforms, add CI/build machines and platform-specific signing/notarization plans.

### Cross-Platform Risk

Linux:

- Most local verification was Linux-only.
- Release binary builds.
- `.deb` and `.rpm` bundling began successfully.
- AppImage fails due icon.

macOS:

- Needs build execution.
- Needs signing/notarization decisions.
- Needs terminal shell behavior smoke.
- Needs `open -R` reveal behavior smoke.
- Needs keyring/GitHub OAuth smoke.

Windows:

- Needs build execution.
- Needs installer target decision.
- Needs terminal shell behavior smoke.
- Needs path separator/reserved-name smoke.
- Needs `explorer /select` reveal behavior smoke.
- Needs keyring/GitHub OAuth smoke.
- Release base module binary missing is already hard failure on Windows.

## Public Beta Documentation Checklist

Minimum docs to add before release:

- README with product description, screenshots, supported platforms, install instructions, and basic workflows.
- LICENSE.
- CHANGELOG for v0.1.0.
- SECURITY with vulnerability reporting path and local capability explanation.
- Privacy/data-storage note covering `~/.atterm`, localStorage terminal buffers, GitHub keyring token, browser preview webview data, and localhost module server.
- Known issues for beta.
- Uninstall instructions, including session data location.
- Module authoring docs link map.
- Troubleshooting for missing tmux, missing Git, missing `gh`, module startup failure, and stale localhost ports.
- Release artifact checksums.

## Suggested Beta Smoke Matrix

Run this on each supported platform before publishing:

| Area            | Smoke Test                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| Launch          | Fresh install launches with no terminal errors.                               |
| Sessions        | Create, rename, switch, delete, restart restore.                              |
| Tabs            | Create, rename, close, detach, reattach/restart restore if supported.         |
| Terminal        | Open terminal, run command, resize, close, restart.                           |
| Tmux            | Detect no tmux, detect tmux, open manager, create/attach/kill session.        |
| Editor          | Open file, preview/permanent open, save, conflict, unsaved close.             |
| File explorer   | Create, rename, move, delete file/folder, hidden files, reveal.               |
| Git             | Status, stage, commit path if present, branch, fetch, pull/push error states. |
| Git destructive | Discard all and remove worktree require confirmation and behave correctly.    |
| Browser preview | Open URL, navigate, history, close/reopen.                                    |
| Module health   | Kill base module and verify recovery/error UI.                                |
| Persistence     | Quit during pending changes; reopen and verify no lost tab/session state.     |
| Packaging       | Install, launch, uninstall, reinstall, no stale resources.                    |

## Recommended Release Plan

### Phase 1: Unblock Release Commands

1. Fix lint failures.
2. Update E2E expected tmux state and rerun Playwright.
3. Add real Tauri icons and rerun full Tauri bundle.
4. Fix local dependency mismatch with a clean `npm ci`.
5. Track the correct Rust lockfile.

### Phase 2: Public Beta Hygiene

1. Add README, LICENSE, CHANGELOG, SECURITY, privacy, known issues, and uninstall docs.
2. Normalize display/product names.
3. Replace scaffold descriptions with product descriptions.
4. Define supported platforms and artifact targets.
5. Add release checklist and artifact checksum process.

### Phase 3: Safety And Regression Coverage

1. Add origin validation in `ModulePanelHost`.
2. Add high-risk backend tests for destructive filesystem/Git/session operations.
3. Add E2E coverage for terminal startup, file editor save, and session restore.
4. Document and test GitHub auth setup.
5. Run network dependency audits with approval.

### Phase 4: Platform Certification

1. Build and smoke Linux artifacts.
2. Build and smoke macOS artifacts, including signing/notarization decision.
3. Build and smoke Windows artifacts, including installer behavior.
4. Test clean install, upgrade from an older local build if applicable, and uninstall.

## Final Beta Readiness Call

Current state: not beta-ready.

The project is close enough that a focused release-hardening pass could plausibly get it to beta, but the current repo should not be published as v0.1.0 until the hard gates are resolved. The most important near-term move is to make the release commands trustworthy: clean install, lint, E2E, Rust checks/tests, and full Tauri bundle must all pass from a clean checkout. After that, documentation and platform smoke testing become the main public-beta work.
