# Security Policy

## TL;DR

- AT-Terminal is a local desktop application. It can read, write, create, delete, and rename files inside user-approved workspace roots, and it can run terminal commands as the current operating-system user. It is **not** a sandbox against the local user.
- Workspace containment, capability allowlists, and the base-module runtime token are defense-in-depth boundaries against a compromised renderer or malformed IPC, **not** against code the user intentionally runs in a terminal panel.
- `v0.1.0` is a public beta. Binaries are not code-signed or notarized. The bundled `base` module is the only supported module; third-party modules are not supported in this version.

## Supported Versions

| Version  | Status           | Notes                                                         |
| -------- | ---------------- | ------------------------------------------------------------- |
| `v0.1.0` | Supported (beta) | First public beta. Ships the bundled `base` module only.      |
| `< v0.1` | Unsupported      | Older tags are not maintained.                                |
| `-dev`   | Best-effort      | Builds from `main` / `prod/*` branches; treat as pre-release. |

Security fixes are backported to the latest beta release. See the [GitHub Releases page](https://github.com/rushikeshvemuru/AT-Terminal/releases) for published tags and [`docs/release-readiness-v0.1.0.md`](./docs/release-readiness-v0.1.0.md) for the v0.1.0 readiness audit.

## Reporting a Vulnerability

Please report security issues privately before publishing details.

- **Preferred**: open a private GitHub Security Advisory at <https://github.com/rushikeshvemuru/AT-Terminal/security/advisories/new>.
- **Fallback**: open a minimal GitHub issue tagged `security` and request a private channel, or contact the maintainer through the address visible in `git log`.

Include:

- The affected AT-Terminal version and operating system.
- Steps to reproduce.
- Impact and any required user interaction.
- Whether the issue requires a malicious workspace folder, malicious session file, local process access, or renderer compromise.

We do not run a paid bug-bounty program. Credit is given in the release notes for accepted reports unless the reporter asks to remain anonymous.

## Local-First Threat Model

AT-Terminal is a local-first Tauri v2 desktop application. The trust boundary is the operating-system user account that runs the app.

**In scope (what we defend against):**

- A compromised renderer (XSS in the React UI, malicious npm dependency) attempting to read or modify files outside user-approved workspace roots.
- A malformed or hostile IPC payload attempting to escape the workspace boundary, escape a panel id, or hit a filesystem path the user did not approve.
- A local process attempting to abuse the loopback base-module server by guessing the runtime token, bypassing the CORS `allowed_origin` check, or hijacking the GitHub OAuth callback.
- Local exfiltration of the GitHub access token from the keyring via another application that has the user's privileges.

**Out of scope (user-accepted risk):**

- Code that the user intentionally runs inside a terminal panel — that runs as the local user with no sandbox.
- A workspace folder the user has explicitly approved — anything inside it is reachable.
- A module the user has intentionally installed — module code runs with full local user permissions.
- A session file the user has chosen to open — session metadata, including `root_directory` strings, is restored as-is.
- Binaries the user has chosen to run despite the platform's code-signing warning (Gatekeeper, SmartScreen, AppArmor, SELinux).

## File and Workspace Containment

The Tauri shell enforces an in-memory allowlist of workspace roots for the lifetime of the running process. The relevant types and checks live in:

- `src-tauri/src/commands/workspace_roots.rs` — `ApprovedRoots`, `canonical_existing_dir`, `ensure_root_approved`, `ensure_path_within_approved_root`.
- `src-tauri/src/commands/filesystem.rs` — `canonical_root`, `canonical_target`, `ensure_destination_within_root`, `remove_existing_target_if_compatible`, `MAX_TEXT_FILE_BYTES`.

Properties of the boundary:

- A root is added to the allowlist only when the user picks it through the native folder picker (`select_workspace_root`) or when a session file is opened and the contained `root_directory` strings are re-approved (`approve_session_roots` in `sessions.rs`).
- The set is an in-memory `HashSet<PathBuf>` keyed by the canonical absolute path. It is **not** persisted across app restarts.
- Filesystem operations use `Path::canonicalize()` followed by a `starts_with` check against an approved root, which is a containment check rather than a sandbox.
- The text read/write path caps files at 10 MiB (`MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024`) and refuses to replace a symlink destination (`remove_existing_target_if_compatible` checks `symlink_metadata`).
- All blocking I/O runs on the Tauri async runtime's blocking thread pool via `run_fs_task` so disk operations never stall the executor.

## Session Trust

Session state is local application state. It is treated as trusted data and **not** as user input.

- `src-tauri/src/commands/sessions.rs` — `~/.atterm/sessions/<uuid>.json`, atomic write via `*.tmp` → rename with a `*.bak` mirror, `validate_session_id` rejects empty, `/`, `\`, and `..` segments.
- Panel ids are validated by `validate_panel_id` (alphanumerics, `-`, `_`, length-bounded) and used to build `~/.atterm/buffers/<panel-id>.buf` paths via `save_buffer` / `load_buffer` / `delete_buffer`.
- Opening a session re-approves every `root_directory` it contains as a workspace root. **Do not open a session file from an untrusted source.**
- `~/.atterm/window_<label>.json` records window lifecycle metadata; deleting a window removes the file.

## Tauri Shell and Renderer Boundary

The Tauri capability allowlist is in `src-tauri/capabilities/default.json` and is intentionally narrow:

- `core:default` plus the minimum window controls (`allow-close`, `allow-destroy`, `allow-minimize`, `allow-toggle-maximize`, `allow-start-dragging`, `allow-set-decorations`).
- `shell:allow-open` — the only `shell` permission. The app can open URLs in the OS-default handler; the user is the trust boundary for which URLs get passed in.
- `dialog:allow-open` — the only `dialog` permission. Used for the native workspace folder picker.

The Content Security Policy is defined in `src-tauri/tauri.conf.json`:

- `default-src` is `'self'` plus `customprotocol:` and `asset:`.
- `connect-src` whitelists `'self'`, `ipc:`, the IPC loopback origin (`http://ipc.localhost`), the base-module loopback origin (`http://127.0.0.1:*`), the Vite dev server (`http://localhost:5173` / `ws://localhost:5173` in dev only), and the matching `ws://` for the base module.
- `frame-src` is `'self'` plus `http://127.0.0.1:*` (iframe module panels) and `https:` (browser preview webview).
- `img-src` is `'self'` plus `asset:`, `http://asset.localhost`, `http://127.0.0.1:*`, `data:`, and `blob:`.
- `style-src` is `'self' 'unsafe-inline'`; inline styles are required by the React/Tailwind tooling.
- `script-src` is `'self'` plus the Vite dev server in dev only. Production builds do not include the dev server.

Detached-tab webviews share the same capability scope (`webviews: ["main", "detached-tab-*"]`).

## Base Module Server (Terminal Runtime)

The base module is a Rust HTTP/WebSocket server (`AT-modules/base/server`) that backs the `base.terminal` panel.

- It binds to `127.0.0.1:47831` by default; the port is overridable via the `AT_BASE_PORT` env var. The host is hard-coded to `127.0.0.1` (`DEFAULT_HOST` in `AT-modules/base/server/src/main.rs`).
- The Tauri shell generates a per-process random UUID at startup (`ModuleManager::base_runtime` in `src-tauri/src/commands/modules.rs`) and passes it to the base module as the `AT_BASE_TOKEN` env var.
- The Tauri shell appends the token to the base module's `panel_url_template`, `healthcheck_url`, and `validation_urls` as a `?atToken=<uuid>` query string (`append_auth_token` in `modules.rs`).
- The base module rejects requests whose `atToken` query parameter does not match the env var (handled in `AT-modules/base/server/src/http.rs`). It also checks the request `Origin` against `AT_BASE_ALLOWED_ORIGIN` when that env var is set, as a CORS-equivalent guard.
- The token is **process-local** — it is generated when the Tauri process starts, lives only in that process and the child base-module process, and is never persisted. It is rotated on every app launch.
- The base module is supervised: the Tauri shell restarts it on healthcheck failure (with backoff capped at `MAX_RESTART_DELAY_SECS = 30`), and `ModuleSupervisors::cancel_all` stops it on `RunEvent::Exit`.
- On Windows, the spawned base-module process is created with `CREATE_NO_WINDOW` (`CREATE_NO_WINDOW = 0x0800_0000` in `modules.rs`) so no console window flashes.

The base-module runtime token is the only thing between the loopback server and the rest of the machine. Do not enable verbose logging in production environments; the token may appear in dev logs and debugging tools.

## GitHub Authentication

GitHub authentication uses the standard OAuth device-flow-with-loopback-callback pattern. The flow is implemented in `src-tauri/src/commands/git.rs`.

- The Tauri shell binds a `TcpListener` on `127.0.0.1:0` (a random loopback port) when the user starts OAuth (`start_github_oauth`). The callback URL is `http://127.0.0.1:<port>/github/callback`.
- The flow requests only the `repo` scope (`GITHUB_SCOPE`).
- A `state` token (a random UUID) is generated per attempt and verified on the callback to prevent CSRF. The attempt expires 10 minutes after creation (`expires_at = Utc::now() + Duration::minutes(10)`).
- The `gh` CLI's own `gh auth login` path is also supported; it just shells out to the local `gh` binary and does not go through the Tauri-supervised callback listener.
- Browser auth is only offered for `github.com` HTTPS remotes; non-GitHub remotes fall back to `gh` or a credential helper.
- The resulting access token is written to the OS keyring under service `at-terminal.github-auth` (`GITHUB_KEYRING_SERVICE` in `git.rs`) using the `keyring` crate. AT-Terminal does not write the token to disk in any other location.
- The Tauri shell emits a `git-auth-updated` event (`GITHUB_AUTH_EVENT`) whenever the keyring entry is written, read, or deleted, so the UI can re-query `get_git_auth_status`.

If your local account is compromised, an attacker with the same OS user privileges can read the keyring entry. Revoke the token on GitHub (`Settings → Developer settings → Personal access tokens`) and disconnect via the Git panel.

## Browser Preview Panel

The browser preview panel is a separate Tauri webview window, not an iframe within the host renderer.

- The relevant code is in `src-tauri/src/commands/browser.rs`.
- URLs are normalized by `normalize_browser_url` and accepted only if the URL scheme is `http://` or `https://` (`is_allowed_browser_url`). Local schemes (`file://`, `devtools://`), `javascript:`, and `data:` are not loaded.
- The default starting URL is `https://example.com`.
- The preview webview inherits the Tauri capability allowlist of the parent webview window. It is **not** a hardened browser; cookies, storage, and service workers persist for the lifetime of the webview window.
- Navigating to an untrusted URL is the user's choice. The preview can reach any host the user's machine can reach, including the local network.

## Modules

`v0.1.0` supports the bundled `base` module only. Anything else in `AT-modules/` is shipped but not started.

- A module's `startup_script_command` is run from the module directory under the Tauri process at startup. Treat any local addition of a module as trusted code with full local user permissions and full access to the host webview's `postMessage` and module-host APIs.
- The base module is the only module whose runtime is plumbed through the supervisor, healthcheck, and runtime-token pipeline (`BASE_MODULE_NAME` in `modules.rs`).
- `AT-modules/module_config.json` controls which modules are active; only `base` should be enabled in `v0.1.0`.

Before third-party modules ship, the project intends to add: module signing with a pinned public key, a module review pipeline, host ↔ module content sanitization at the iframe `postMessage` boundary, and stronger isolation for the host webview (separate process, OS-level sandboxing, or both).

## Known Beta Limitations (v0.1.0)

- `v0.1.0` ships the first-party `base` module only. External modules are not supported in this version.
- Binaries are unsigned / not notarized. macOS Gatekeeper and Windows SmartScreen will warn. Code signing is planned for `v0.2.0`. See the [Beta status](./README.md#beta-status) section of the README for workarounds.
- The Playwright E2E suite and a small number of lint warnings are red on the `v0.1.0` tag. They are tracked in [`docs/release-readiness-v0.1.0.md`](./docs/release-readiness-v0.1.0.md) and slated for `v0.1.1`.
- Session files are local application state. **Treat untrusted session files as unsafe** — opening one re-approves every `root_directory` it contains.
- Terminal panels execute commands as the current operating-system user. Module startup commands are trusted local code.
- Browser preview panels are convenience views, not a hardened web browser. They are not an isolation boundary.
- The base module runtime token is process-local and may appear in local development logs or debugging tools. Do not enable verbose logging in production environments.
- `CHANGELOG.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md` are not yet in the repo. Planned for `v0.2.0`.

## Versioning and Cadence

This file is updated per minor release. Notable security changes are called out in the release notes linked from the [Releases page](https://github.com/rushikeshvemuru/AT-Terminal/releases).
