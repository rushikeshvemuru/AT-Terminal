use crate::http::{parse_query, respond_json, respond_json_error, HttpRequest};
use crate::terminal::{lookup_terminal_session, TerminalSession};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const MODULE_VERSION: &str = "tmux-state-25";
const FIELD_SEPARATOR: &str = "|||";
const TMUX_STATE_FORMAT_SESSION: &str =
    "#{session_id}|||#{session_name}|||#{session_attached}|||#{session_windows}|||#{session_path}";
const TMUX_STATE_FORMAT_SESSION_PRE_32: &str =
    "#{session_id}|||#{session_name}|||#{session_attached}|||#{session_windows}";
const TMUX_STATE_FORMAT_SESSION_FALLBACK: &str = "#{session_id}|||#{session_name}";
const TMUX_STATE_FORMAT_CLIENT: &str =
    "#{client_tty}|||#{session_id}|||#{session_name}|||#{client_name}";
const TMUX_STATE_FORMAT_WINDOW: &str = "#{session_id}|||#{session_name}|||#{window_id}|||#{window_index}|||#{window_name}|||#{window_flags}|||#{window_active}|||#{window_zoomed_flag}|||#{window_linked}|||#{window_panes}";
const TMUX_STATE_FORMAT_PANE: &str = "#{session_id}|||#{session_name}|||#{window_id}|||#{window_index}|||#{pane_id}|||#{pane_index}|||#{pane_title}|||#{pane_current_command}|||#{pane_current_path}|||#{pane_active}|||#{pane_dead}|||#{pane_tty}|||#{pane_width}|||#{pane_height}|||#{pane_left}|||#{pane_top}";
const TMUX_STATE_FORMAT_SERVER: &str = "#{pid}|||#{socket_path}";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TmuxStateResponse {
    available: bool,
    server_running: bool,
    tmux_active: bool,
    mouse_mode: bool,
    panel_connected: bool,
    root_directory: String,
    sessions: Vec<TmuxSession>,
    error: Option<String>,
    version: Option<String>,
    match_mode: TmuxMatchMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_socket_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_session_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_client_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_command: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    diagnostics: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum TmuxMatchMode {
    ClientTty,
    ForegroundTmux,
    Socket,
    None,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTmuxPanelState {
    panel_id: String,
    root_directory: String,
    tmux_mode: bool,
    socket_path: Option<String>,
    session_name: Option<String>,
    updated_at_ms: u128,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TmuxSession {
    id: String,
    name: String,
    attached: usize,
    window_count: usize,
    path: String,
    associated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    socket_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_pid: Option<usize>,
    windows: Vec<TmuxWindow>,
}

#[derive(Clone)]
struct TmuxClient {
    tty: String,
    session_id: String,
    session_name: String,
    client_name: String,
}

#[derive(Clone, Default)]
struct TmuxTarget {
    socket_path: Option<String>,
    active_session_name: Option<String>,
}

struct TmuxServerSnapshot {
    target: TmuxTarget,
    resolved_socket_path: Option<String>,
    server_pid: Option<usize>,
    clients: Vec<TmuxClient>,
    sessions: Vec<TmuxSession>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TmuxWindow {
    id: String,
    index: usize,
    name: String,
    flags: String,
    active: bool,
    zoomed: bool,
    linked: bool,
    pane_count: usize,
    active_pane_id: Option<String>,
    panes: Vec<TmuxPane>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TmuxPane {
    id: String,
    index: usize,
    title: String,
    current_command: String,
    current_path: String,
    active: bool,
    dead: bool,
    tty: String,
    width: usize,
    height: usize,
    left: usize,
    top: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxCommandRequest {
    panel_id: String,
    command: String,
    socket_path: Option<String>,
}

pub(crate) fn handle_tmux_state_request(
    stream: &mut TcpStream,
    request: &HttpRequest,
) -> std::io::Result<()> {
    let params = parse_query(&request.path);
    let panel_id = params
        .get("panelId")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let Some(panel_id) = panel_id else {
        return respond_json_error(stream, 400, "panelId is required");
    };
    let debug = params
        .get("debug")
        .map(|value| matches!(value.trim(), "1" | "true" | "yes"))
        .unwrap_or(false);

    match lookup_terminal_session(panel_id) {
        Some(session) => respond_json(stream, 200, &build_tmux_state_response(&session, debug)),
        None => respond_json(
            stream,
            200,
            &disconnected_tmux_state_response(tmux_version()),
        ),
    }
}

pub(crate) fn handle_base_version_request(
    stream: &mut TcpStream,
    request: &HttpRequest,
) -> std::io::Result<()> {
    let params = parse_query(&request.path);
    if let Some(expected_version) = params
        .get("expectedVersion")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if expected_version != MODULE_VERSION {
            return respond_json(
                stream,
                409,
                &json!({
                    "module": "base",
                    "version": MODULE_VERSION,
                    "expectedVersion": expected_version,
                    "error": "base module version mismatch",
                }),
            );
        }
    }

    respond_json(
        stream,
        200,
        &json!({
            "module": "base",
            "version": MODULE_VERSION,
        }),
    )
}

pub(crate) fn handle_tmux_command_request(
    stream: &mut TcpStream,
    request: &HttpRequest,
) -> std::io::Result<()> {
    let payload: TmuxCommandRequest = match parse_json_body(&request.body) {
        Ok(value) => value,
        Err(message) => return respond_json_error(stream, 400, &message),
    };

    let session = match lookup_terminal_session(&payload.panel_id) {
        Some(value) => value,
        None => return respond_json_error(stream, 409, "terminal panel is not connected"),
    };

    let command = payload.command.trim();
    if command.is_empty() {
        return respond_json_error(stream, 400, "command is required");
    }

    let command = command
        .strip_prefix("tmux ")
        .unwrap_or(command)
        .trim()
        .to_string();
    let target = payload
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|socket_path| TmuxTarget {
            socket_path: Some(socket_path.to_string()),
            active_session_name: None,
        })
        .unwrap_or_else(|| resolve_tmux_target(&session));
    let mut shell_command = "tmux".to_string();
    if let Some(socket_path) = target
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        shell_command.push_str(" -S ");
        shell_command.push_str(&shell_escape(socket_path));
    }
    shell_command.push(' ');
    shell_command.push_str(&command);
    let output = Command::new("/bin/sh")
        .arg("-lc")
        .arg(shell_command)
        .current_dir(&session.root_dir)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE")
        .output()
        .map_err(std::io::Error::other)?;

    respond_json(
        stream,
        200,
        &json!({
            "ok": output.status.success(),
            "exitCode": output.status.code(),
            "stdout": stdout_text(&output),
            "stderr": stderr_text(&output),
            "socketPath": target.socket_path,
        }),
    )
}

/// Build state from tmux servers, not from the terminal screen.
/// The manager tree is the socket-level object graph; `tmux_active` is only
/// the separate fact that this terminal's PTY currently owns a tmux client.
fn build_tmux_state_response(session: &TerminalSession, debug: bool) -> TmuxStateResponse {
    let Some(version) = tmux_version() else {
        return missing_tmux_state_response(session);
    };

    let foreground_target = foreground_tmux_target(session.pty_master_fd);
    let saved_state = read_tmux_panel_state(&session.panel_id).filter(|saved| {
        saved.tmux_mode && saved.root_directory == session.root_dir.to_string_lossy()
    });
    let candidates = tmux_target_candidates(foreground_target.as_ref(), saved_state.as_ref());
    let mut diagnostics = Vec::new();
    let mut snapshots = Vec::new();
    let mut seen_servers = HashSet::new();

    let supports_session_path = parse_tmux_version(&version).map_or(true, |(major, minor)| {
        major > 3 || (major == 3 && minor >= 2)
    });
    let session_format = if supports_session_path {
        TMUX_STATE_FORMAT_SESSION
    } else {
        TMUX_STATE_FORMAT_SESSION_PRE_32
    };

    for target in candidates {
        match tmux_snapshot_for_target(
            &session.root_dir,
            target.clone(),
            session_format,
            &mut diagnostics,
        ) {
            Ok(snapshot) => {
                let identity = snapshot.identity_key();
                if !seen_servers.insert(identity.clone()) {
                    diagnostics.push(format!(
                        "socket={} duplicate server {} skipped",
                        target_socket_label(&target),
                        identity
                    ));
                    continue;
                }
                diagnostics.push(format!(
                    "socket={} resolved={} sessions={} clients={}",
                    target_socket_label(&target),
                    snapshot
                        .resolved_socket_path
                        .as_deref()
                        .unwrap_or("default"),
                    snapshot.sessions.len(),
                    snapshot.clients.len()
                ));
                snapshots.push(snapshot);
            }
            Err(err) => diagnostics.push(format!(
                "socket={} skipped: {}",
                target_socket_label(&target),
                err
            )),
        }
    }

    let mut selected_target = snapshots
        .first()
        .map(TmuxServerSnapshot::command_target)
        .or_else(|| foreground_target.clone())
        .unwrap_or_default();
    let mut selected_client_session_name = None;
    let mut selected_client_name = None;
    let mut match_mode = if snapshots.is_empty() {
        TmuxMatchMode::None
    } else {
        TmuxMatchMode::Socket
    };

    let all_sessions = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.sessions.iter().cloned())
        .collect::<Vec<_>>();

    for snapshot in &snapshots {
        if let Some(client) = matching_client(session.tty_path.as_deref(), &snapshot.clients) {
            selected_target = snapshot.command_target();
            let client_session_name = if client.session_name.trim().is_empty() {
                client.session_id.clone()
            } else {
                client.session_name.clone()
            };
            selected_target.active_session_name = Some(client_session_name.clone());
            selected_client_session_name = Some(client_session_name);
            selected_client_name = Some(client.client_name.clone());
            match_mode = TmuxMatchMode::ClientTty;
            break;
        }
    }

    if match_mode != TmuxMatchMode::ClientTty {
        if let Some(snapshot) = snapshots
            .iter()
            .find(|snapshot| foreground_target_matches(foreground_target.as_ref(), snapshot))
        {
            selected_target = snapshot.command_target();
            match_mode = TmuxMatchMode::ForegroundTmux;
        }
    }

    if snapshots.is_empty() {
        if let Some(saved) = saved_state.as_ref() {
            selected_target = TmuxTarget {
                socket_path: saved.socket_path.clone(),
                active_session_name: saved.session_name.clone(),
            };
        }
    }

    let tmux_active =
        match_mode == TmuxMatchMode::ClientTty || match_mode == TmuxMatchMode::ForegroundTmux;
    let active_session_name = selected_client_session_name
        .clone()
        .or_else(|| selected_target.active_session_name.clone());
    let associated_session_name = snapshots
        .iter()
        .find(|snapshot| snapshot_matches_target(snapshot, &selected_target))
        .and_then(|snapshot| unique_associated_session_name(&snapshot.sessions))
        .or_else(|| unique_associated_session_name(&all_sessions));
    let persisted_session_name = active_session_name
        .clone()
        .or(associated_session_name.clone())
        .or_else(|| {
            saved_state
                .as_ref()
                .and_then(|state| state.session_name.clone())
        });
    let start_command = Some(tmux_start_command(
        &session.root_dir,
        &selected_target,
        persisted_session_name.as_deref(),
    ));
    let tmux_restore_intent = tmux_active
        || saved_state
            .as_ref()
            .map(|state| state.tmux_mode)
            .unwrap_or(false);
    let mouse_mode = read_tmux_mouse_mode(&session.root_dir, &selected_target);
    persist_tmux_panel_state(
        &session.panel_id,
        &session.root_dir,
        tmux_restore_intent,
        &selected_target,
        persisted_session_name.as_deref(),
    );

    TmuxStateResponse {
        available: true,
        server_running: !all_sessions.is_empty() || tmux_active,
        tmux_active,
        mouse_mode,
        panel_connected: true,
        root_directory: session.root_dir.to_string_lossy().to_string(),
        sessions: all_sessions,
        error: None,
        version: Some(version),
        match_mode,
        target_socket_path: selected_target.socket_path,
        active_session_name,
        active_client_name: selected_client_name,
        start_command,
        diagnostics: if debug { diagnostics } else { Vec::new() },
    }
}

fn read_tmux_mouse_mode(root_dir: &Path, target: &TmuxTarget) -> bool {
    let Ok(output) = run_tmux_checked(
        Some(root_dir),
        target,
        vec![
            "show-options".to_string(),
            "-gv".to_string(),
            "mouse".to_string(),
        ],
    ) else {
        return false;
    };

    matches!(stdout_text(&output).trim(), "on" | "1" | "yes" | "true")
}

fn tmux_snapshot_for_target(
    root_dir: &Path,
    target: TmuxTarget,
    session_format: &str,
    diagnostics: &mut Vec<String>,
) -> Result<TmuxServerSnapshot, String> {
    let (server_pid, resolved_socket_path) = tmux_server_info(root_dir, &target);
    let sessions_output = run_tmux_checked(
        Some(root_dir),
        &target,
        vec![
            "list-sessions".to_string(),
            "-F".to_string(),
            session_format.to_string(),
        ],
    )?;
    let sessions_raw = stdout_text(&sessions_output);
    let clients = run_tmux_checked(
        Some(root_dir),
        &target,
        vec![
            "list-clients".to_string(),
            "-F".to_string(),
            TMUX_STATE_FORMAT_CLIENT.to_string(),
        ],
    )
    .ok()
    .map(|output| parse_client_rows(&stdout_text(&output)))
    .unwrap_or_default();
    let windows_output = run_tmux_checked(
        Some(root_dir),
        &target,
        vec![
            "list-windows".to_string(),
            "-a".to_string(),
            "-F".to_string(),
            TMUX_STATE_FORMAT_WINDOW.to_string(),
        ],
    )?;
    let panes_output = run_tmux_checked(
        Some(root_dir),
        &target,
        vec![
            "list-panes".to_string(),
            "-a".to_string(),
            "-F".to_string(),
            TMUX_STATE_FORMAT_PANE.to_string(),
        ],
    )?;
    let resolved_socket_path = resolved_socket_path.or_else(|| target.socket_path.clone());
    let mut sessions = parse_tmux_server_sessions(
        &sessions_raw,
        &stdout_text(&windows_output),
        &stdout_text(&panes_output),
        root_dir,
        resolved_socket_path.clone(),
        server_pid,
    );

    if sessions.is_empty() && !sessions_raw.trim().is_empty() {
        let first_line = sessions_raw.lines().next().unwrap_or("");
        let field_count = first_line.split(FIELD_SEPARATOR).count();
        diagnostics.push(format!(
            "sessions_parse_issue: {} lines, first_line_fields={}, expected_min=4, separator={:?}",
            sessions_raw.lines().count(),
            field_count,
            FIELD_SEPARATOR,
        ));
        if field_count == 1 {
            let fallback_output = run_tmux_checked(
                Some(root_dir),
                &target,
                vec![
                    "list-sessions".to_string(),
                    "-F".to_string(),
                    TMUX_STATE_FORMAT_SESSION_FALLBACK.to_string(),
                ],
            );
            if let Ok(fallback) = fallback_output {
                let fallback_raw = stdout_text(&fallback);
                let fallback_rows = parse_field_rows(&fallback_raw);
                let recovered = fallback_rows
                    .iter()
                    .filter(|fields| fields.len() >= 2)
                    .map(|fields| TmuxSession {
                        id: fields[0].clone(),
                        name: fields.get(1).cloned().unwrap_or_default(),
                        attached: fields
                            .get(2)
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0),
                        window_count: 0,
                        path: String::new(),
                        associated: false,
                        socket_path: resolved_socket_path.clone(),
                        server_pid,
                        windows: Vec::new(),
                    })
                    .collect::<Vec<_>>();
                if !recovered.is_empty() {
                    diagnostics.push(format!(
                        "sessions_parse_fallback: recovered {} sessions with fallback format",
                        recovered.len()
                    ));
                    sessions = recovered;
                }
            }
        }
    }

    Ok(TmuxServerSnapshot {
        target,
        resolved_socket_path,
        server_pid,
        clients,
        sessions,
    })
}

fn tmux_server_info(root_dir: &Path, target: &TmuxTarget) -> (Option<usize>, Option<String>) {
    let Ok(output) = run_tmux_checked(
        Some(root_dir),
        target,
        vec![
            "display-message".to_string(),
            "-p".to_string(),
            TMUX_STATE_FORMAT_SERVER.to_string(),
        ],
    ) else {
        return (None, target.socket_path.clone());
    };
    let row = parse_field_rows(&stdout_text(&output))
        .into_iter()
        .next()
        .unwrap_or_default();
    let server_pid = row
        .first()
        .map(|value| parse_usize(value))
        .filter(|pid| *pid > 0);
    let socket_path = row
        .get(1)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| target.socket_path.clone());
    (server_pid, socket_path)
}

fn parse_tmux_server_sessions(
    sessions_output: &str,
    windows_output: &str,
    panes_output: &str,
    root_dir: &Path,
    socket_path: Option<String>,
    server_pid: Option<usize>,
) -> Vec<TmuxSession> {
    let mut sessions = Vec::new();
    let mut session_positions = HashMap::new();
    let mut window_positions = HashMap::new();

    for fields in parse_field_rows(sessions_output) {
        if fields.len() < 4 {
            continue;
        }
        let session_id = fields[0].clone();
        let position = sessions.len();
        session_positions.insert(session_id.clone(), position);
        sessions.push(TmuxSession {
            id: session_id,
            name: fields[1].clone(),
            attached: parse_usize(&fields[2]),
            window_count: parse_usize(&fields[3]),
            path: fields.get(4).cloned().unwrap_or_default(),
            associated: false,
            socket_path: socket_path.clone(),
            server_pid,
            windows: Vec::new(),
        });
    }

    for fields in parse_field_rows(windows_output) {
        if fields.len() < 10 {
            continue;
        }
        let session_id = fields[0].clone();
        let session_position = ensure_session_position(
            &mut sessions,
            &mut session_positions,
            &session_id,
            &fields[1],
            socket_path.clone(),
            server_pid,
        );
        let window_id = fields[2].clone();
        let window_position = sessions[session_position].windows.len();
        sessions[session_position].windows.push(TmuxWindow {
            id: window_id.clone(),
            index: parse_usize(&fields[3]),
            name: fields[4].clone(),
            flags: fields[5].clone(),
            active: parse_bool(&fields[6]),
            zoomed: parse_bool(&fields[7]),
            linked: parse_bool(&fields[8]),
            pane_count: parse_usize(&fields[9]),
            active_pane_id: None,
            panes: Vec::new(),
        });
        window_positions.insert((session_id, window_id), (session_position, window_position));
    }

    for fields in parse_field_rows(panes_output) {
        if fields.len() < 16 {
            continue;
        }
        let session_id = fields[0].clone();
        let session_position = ensure_session_position(
            &mut sessions,
            &mut session_positions,
            &session_id,
            &fields[1],
            socket_path.clone(),
            server_pid,
        );
        let window_id = fields[2].clone();
        let (session_position, window_position) = match window_positions
            .get(&(session_id.clone(), window_id.clone()))
            .copied()
        {
            Some(position) => position,
            None => {
                let window_position = sessions[session_position].windows.len();
                sessions[session_position].windows.push(TmuxWindow {
                    id: window_id.clone(),
                    index: parse_usize(&fields[3]),
                    name: String::new(),
                    flags: String::new(),
                    active: false,
                    zoomed: false,
                    linked: false,
                    pane_count: 0,
                    active_pane_id: None,
                    panes: Vec::new(),
                });
                window_positions.insert(
                    (session_id.clone(), window_id.clone()),
                    (session_position, window_position),
                );
                (session_position, window_position)
            }
        };
        let pane = TmuxPane {
            id: fields[4].clone(),
            index: parse_usize(&fields[5]),
            title: fields[6].clone(),
            current_command: fields[7].clone(),
            current_path: fields[8].clone(),
            active: parse_bool(&fields[9]),
            dead: parse_bool(&fields[10]),
            tty: fields[11].clone(),
            width: parse_usize(&fields[12]),
            height: parse_usize(&fields[13]),
            left: parse_usize(&fields[14]),
            top: parse_usize(&fields[15]),
        };
        if pane.active {
            sessions[session_position].windows[window_position].active_pane_id =
                Some(pane.id.clone());
        }
        sessions[session_position].windows[window_position]
            .panes
            .push(pane);
    }

    for session in &mut sessions {
        session.associated = session_matches_root(session, root_dir);
        for window in &mut session.windows {
            if window.pane_count == 0 {
                window.pane_count = window.panes.len();
            }
        }
    }

    sessions
}

fn ensure_session_position(
    sessions: &mut Vec<TmuxSession>,
    session_positions: &mut HashMap<String, usize>,
    session_id: &str,
    session_name: &str,
    socket_path: Option<String>,
    server_pid: Option<usize>,
) -> usize {
    if let Some(position) = session_positions.get(session_id).copied() {
        return position;
    }
    let position = sessions.len();
    session_positions.insert(session_id.to_string(), position);
    sessions.push(TmuxSession {
        id: session_id.to_string(),
        name: session_name.to_string(),
        attached: 0,
        window_count: 0,
        path: String::new(),
        associated: false,
        socket_path,
        server_pid,
        windows: Vec::new(),
    });
    position
}

fn matching_client<'a>(
    tty_path: Option<&str>,
    clients: &'a [TmuxClient],
) -> Option<&'a TmuxClient> {
    let tty_path = tty_path.map(str::trim).filter(|value| !value.is_empty())?;
    clients.iter().find(|client| client.tty.trim() == tty_path)
}

fn foreground_target_matches(
    foreground_target: Option<&TmuxTarget>,
    snapshot: &TmuxServerSnapshot,
) -> bool {
    let Some(foreground) = foreground_target else {
        return false;
    };
    match foreground.socket_path.as_deref() {
        Some(socket_path) => {
            snapshot.resolved_socket_path.as_deref() == Some(socket_path)
                || snapshot.target.socket_path.as_deref() == Some(socket_path)
        }
        None => snapshot.target.socket_path.is_none(),
    }
}

fn snapshot_matches_target(snapshot: &TmuxServerSnapshot, target: &TmuxTarget) -> bool {
    match target.socket_path.as_deref() {
        Some(socket_path) => {
            snapshot.resolved_socket_path.as_deref() == Some(socket_path)
                || snapshot.target.socket_path.as_deref() == Some(socket_path)
        }
        None => snapshot.target.socket_path.is_none(),
    }
}

impl TmuxServerSnapshot {
    fn command_target(&self) -> TmuxTarget {
        TmuxTarget {
            socket_path: self
                .resolved_socket_path
                .clone()
                .or_else(|| self.target.socket_path.clone()),
            active_session_name: self.target.active_session_name.clone(),
        }
    }

    fn identity_key(&self) -> String {
        if let Some(socket_path) = self.resolved_socket_path.as_deref() {
            return format!("socket:{}", socket_path);
        }
        if let Some(pid) = self.server_pid {
            return format!("pid:{}", pid);
        }
        format!("target:{}", target_socket_label(&self.target))
    }
}

#[cfg(test)]
fn root_matched_sessions(sessions: &[TmuxSession], root_dir: &Path) -> Vec<TmuxSession> {
    sessions
        .iter()
        .filter(|session| session_matches_root(session, root_dir))
        .cloned()
        .collect()
}

fn session_matches_root(session: &TmuxSession, root_dir: &Path) -> bool {
    if path_is_equal_or_under_root(&session.path, root_dir) {
        return true;
    }
    session.windows.iter().any(|window| {
        window
            .panes
            .iter()
            .any(|pane| path_is_equal_or_under_root(&pane.current_path, root_dir))
    })
}

fn path_is_equal_or_under_root(path: &str, root_dir: &Path) -> bool {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return false;
    }
    path == root_dir || path.starts_with(root_dir)
}

fn target_socket_label(target: &TmuxTarget) -> String {
    target
        .socket_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("default")
        .to_string()
}

fn disconnected_tmux_state_response(version: Option<String>) -> TmuxStateResponse {
    TmuxStateResponse {
        available: version.is_some(),
        server_running: false,
        tmux_active: false,
        mouse_mode: false,
        panel_connected: false,
        root_directory: String::new(),
        sessions: Vec::new(),
        error: Some("terminal panel is not connected".to_string()),
        version,
        match_mode: TmuxMatchMode::None,
        target_socket_path: None,
        active_session_name: None,
        active_client_name: None,
        start_command: None,
        diagnostics: Vec::new(),
    }
}

fn missing_tmux_state_response(session: &TerminalSession) -> TmuxStateResponse {
    TmuxStateResponse {
        available: false,
        server_running: false,
        tmux_active: false,
        mouse_mode: false,
        panel_connected: true,
        root_directory: session.root_dir.to_string_lossy().to_string(),
        sessions: Vec::new(),
        error: Some("tmux is not installed".to_string()),
        version: None,
        match_mode: TmuxMatchMode::None,
        target_socket_path: None,
        active_session_name: None,
        active_client_name: None,
        start_command: None,
        diagnostics: Vec::new(),
    }
}

fn parse_client_rows(output: &str) -> Vec<TmuxClient> {
    parse_field_rows(output)
        .into_iter()
        .filter_map(|fields| {
            if fields.is_empty() || fields[0].trim().is_empty() {
                return None;
            }
            Some(TmuxClient {
                tty: fields[0].clone(),
                session_id: fields.get(1).cloned().unwrap_or_default(),
                session_name: fields.get(2).cloned().unwrap_or_default(),
                client_name: fields.get(3).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn resolve_tmux_target(session: &TerminalSession) -> TmuxTarget {
    let foreground_target = foreground_tmux_target(session.pty_master_fd);
    let saved_state = read_tmux_panel_state(&session.panel_id).filter(|saved| {
        saved.tmux_mode && saved.root_directory == session.root_dir.to_string_lossy()
    });

    for target in tmux_target_candidates(foreground_target.as_ref(), saved_state.as_ref()) {
        let Ok(output) = run_tmux_checked(
            Some(&session.root_dir),
            &target,
            vec![
                "list-clients".to_string(),
                "-F".to_string(),
                TMUX_STATE_FORMAT_CLIENT.to_string(),
            ],
        ) else {
            continue;
        };
        let clients = parse_client_rows(&stdout_text(&output));
        if let Some(client) = clients.iter().find(|client| {
            session
                .tty_path
                .as_deref()
                .is_some_and(|tty| client.tty.trim() == tty)
        }) {
            let client_session_name = if client.session_name.trim().is_empty() {
                client.session_id.clone()
            } else {
                client.session_name.clone()
            };
            return TmuxTarget {
                socket_path: target.socket_path,
                active_session_name: Some(client_session_name),
            };
        }
    }

    for target in tmux_target_candidates(foreground_target.as_ref(), saved_state.as_ref()) {
        let Ok(snapshot) = tmux_snapshot_for_target(
            &session.root_dir,
            target.clone(),
            TMUX_STATE_FORMAT_SESSION,
            &mut Vec::new(),
        ) else {
            continue;
        };
        if snapshot.sessions.iter().any(|entry| entry.associated) {
            return snapshot.command_target();
        }
        if !snapshot.sessions.is_empty() {
            return snapshot.command_target();
        }
    }

    if let Some(target) = foreground_target {
        return target;
    }

    if let Some(saved) = saved_state {
        return TmuxTarget {
            socket_path: saved.socket_path,
            active_session_name: saved.session_name,
        };
    }

    TmuxTarget::default()
}

fn unique_associated_session_name(sessions: &[TmuxSession]) -> Option<String> {
    let mut names = sessions
        .iter()
        .filter(|session| session.associated)
        .map(|session| session.name.as_str())
        .collect::<Vec<_>>();
    names.sort_unstable();
    names.dedup();
    if names.len() == 1 {
        Some(names[0].to_string())
    } else {
        None
    }
}

fn tmux_start_command(
    root_dir: &Path,
    target: &TmuxTarget,
    preferred_session_name: Option<&str>,
) -> String {
    let socket_args = target
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|socket_path| format!(" -S {}", shell_escape(socket_path)))
        .unwrap_or_default();
    let session_name = preferred_session_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| target.active_session_name.clone())
        .unwrap_or_else(|| deterministic_session_name(root_dir));

    format!(
        "tmux{} new-session -A -s {} -c {}",
        socket_args,
        shell_escape(&session_name),
        shell_escape(&root_dir.to_string_lossy())
    )
}

fn deterministic_session_name(root_dir: &Path) -> String {
    let root = root_dir.to_string_lossy();
    let base = root_dir
        .file_name()
        .map(|name| sanitize_tmux_name(&name.to_string_lossy()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "workspace".to_string());
    format!("at-{}-{:08x}", base, stable_hash(root.as_bytes()))
}

fn sanitize_tmux_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn stable_hash(bytes: &[u8]) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for byte in bytes {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn tmux_target_candidates(
    foreground_target: Option<&TmuxTarget>,
    saved_state: Option<&PersistedTmuxPanelState>,
) -> Vec<TmuxTarget> {
    let mut targets = Vec::new();
    if let Some(target) = foreground_target {
        if target.socket_path.is_some() {
            push_unique_tmux_target(&mut targets, target.clone());
        }
    }
    if let Some(saved) = saved_state {
        if saved.socket_path.is_some() {
            push_unique_tmux_target(
                &mut targets,
                TmuxTarget {
                    socket_path: saved.socket_path.clone(),
                    active_session_name: saved.session_name.clone(),
                },
            );
        }
    }
    for socket_path in tmux_socket_path_candidates() {
        push_unique_tmux_target(
            &mut targets,
            TmuxTarget {
                socket_path: Some(socket_path),
                active_session_name: None,
            },
        );
    }
    if let Some(target) = foreground_target {
        if target.socket_path.is_none() {
            push_unique_tmux_target(&mut targets, target.clone());
        }
    }
    if let Some(saved) = saved_state {
        if saved.socket_path.is_none() && saved.session_name.is_some() {
            push_unique_tmux_target(
                &mut targets,
                TmuxTarget {
                    socket_path: None,
                    active_session_name: saved.session_name.clone(),
                },
            );
        }
    }
    push_unique_tmux_target(&mut targets, TmuxTarget::default());
    targets
}

fn push_unique_tmux_target(targets: &mut Vec<TmuxTarget>, target: TmuxTarget) {
    if targets
        .iter()
        .any(|existing| existing.socket_path == target.socket_path)
    {
        return;
    }
    targets.push(target);
}

#[cfg(test)]
fn tmux_client_matches_terminal(tty_path: Option<&str>, clients: &[TmuxClient]) -> bool {
    let Some(tty_path) = tty_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };

    clients.iter().any(|client| client.tty.trim() == tty_path)
}

#[cfg(unix)]
fn foreground_tmux_target(pty_master_fd: Option<i32>) -> Option<TmuxTarget> {
    let Some(pty_master_fd) = pty_master_fd else {
        return None;
    };
    let foreground_process_group = unsafe { libc::tcgetpgrp(pty_master_fd) };
    if foreground_process_group <= 0 {
        return None;
    }

    let tmux_pid = tmux_pid_in_process_group(foreground_process_group).or_else(|| {
        process_name_is_tmux(foreground_process_group).then_some(foreground_process_group)
    })?;
    Some(TmuxTarget {
        socket_path: tmux_socket_path_for_pid(tmux_pid),
        active_session_name: None,
    })
}

#[cfg(not(unix))]
fn foreground_tmux_target(_pty_master_fd: Option<i32>) -> Option<TmuxTarget> {
    None
}

#[cfg(unix)]
fn process_name_is_tmux(pid: i32) -> bool {
    let comm_path = format!("/proc/{}/comm", pid);
    if let Ok(name) = fs::read_to_string(comm_path) {
        if is_tmux_process_name(&name) {
            return true;
        }
    }

    let exe_path = format!("/proc/{}/exe", pid);
    fs::read_link(exe_path)
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .is_some_and(|name| is_tmux_process_name(&name))
}

#[cfg(any(unix, test))]
fn is_tmux_process_name(name: &str) -> bool {
    name.trim().starts_with("tmux")
}

#[cfg(unix)]
fn tmux_pid_in_process_group(process_group: i32) -> Option<i32> {
    for entry in fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if process_group_id(pid) == Some(process_group) && process_name_is_tmux(pid) {
            return Some(pid);
        }
    }
    None
}

#[cfg(unix)]
fn process_group_id(pid: i32) -> Option<i32> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    process_group_id_from_stat(&stat)
}

#[cfg(any(unix, test))]
fn process_group_id_from_stat(stat: &str) -> Option<i32> {
    let after_name = stat.rsplit_once(") ")?.1;
    after_name.split_whitespace().nth(2)?.parse().ok()
}

#[cfg(unix)]
fn tmux_socket_path_for_pid(pid: i32) -> Option<String> {
    let socket_inodes = socket_inodes_for_pid(pid);
    if socket_inodes.is_empty() {
        return None;
    }
    let socket_paths = unix_socket_paths_by_inode();
    socket_inodes
        .into_iter()
        .filter_map(|inode| socket_paths.get(&inode).cloned())
        .find(|path| looks_like_tmux_socket_path(path))
}

#[cfg(unix)]
fn socket_inodes_for_pid(pid: i32) -> HashSet<String> {
    let mut inodes = HashSet::new();
    let Ok(entries) = fs::read_dir(format!("/proc/{}/fd", pid)) else {
        return inodes;
    };
    for entry in entries.flatten() {
        let Ok(target) = fs::read_link(entry.path()) else {
            continue;
        };
        let target = target.to_string_lossy();
        if let Some(inode) = parse_socket_inode(&target) {
            inodes.insert(inode.to_string());
        }
    }
    inodes
}

#[cfg(any(unix, test))]
fn parse_socket_inode(value: &str) -> Option<&str> {
    value.strip_prefix("socket:[")?.strip_suffix(']')
}

#[cfg(unix)]
fn unix_socket_paths_by_inode() -> HashMap<String, String> {
    let mut sockets = HashMap::new();
    let Ok(contents) = fs::read_to_string("/proc/net/unix") else {
        return sockets;
    };
    for line in contents.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 8 {
            continue;
        }
        sockets.insert(fields[6].to_string(), fields[7].to_string());
    }
    sockets
}

#[cfg(any(unix, test))]
fn looks_like_tmux_socket_path(path: &str) -> bool {
    path.contains("/tmux-") || path.ends_with("/default")
}

fn tmux_socket_path_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    for base_dir in tmux_socket_base_dirs() {
        collect_tmux_socket_paths(&base_dir, &mut candidates);
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn tmux_socket_base_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(tmux_tmpdir) = std::env::var_os("TMUX_TMPDIR").map(PathBuf::from) {
        dirs.push(tmux_tmpdir);
    }
    dirs.push(std::env::temp_dir());
    dirs
}

fn collect_tmux_socket_paths(base_dir: &Path, candidates: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(base_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with("tmux-") {
            continue;
        }
        let Ok(socket_entries) = fs::read_dir(entry.path()) else {
            continue;
        };
        for socket_entry in socket_entries.flatten() {
            let path = socket_entry.path();
            if path.is_file() || path.file_name().is_some() {
                candidates.push(path.to_string_lossy().to_string());
            }
        }
    }
}

pub(crate) fn restored_tmux_startup_command(panel_id: &str, root_dir: &Path) -> Option<String> {
    let state = read_tmux_panel_state(panel_id)?;
    if !state.tmux_mode || state.root_directory != root_dir.to_string_lossy() {
        return None;
    }

    Some(restored_tmux_command_for_state(&state))
}

fn restored_tmux_command_for_state(state: &PersistedTmuxPanelState) -> String {
    let session_name = state
        .session_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| deterministic_session_name(Path::new(&state.root_directory)));
    let socket_args = state
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|socket_path| format!(" -S {}", shell_escape(socket_path)))
        .unwrap_or_default();

    format!(
        "tmux{} new-session -A -s {} -c {}",
        socket_args,
        shell_escape(&session_name),
        shell_escape(&state.root_directory)
    )
}

fn persist_tmux_panel_state(
    panel_id: &str,
    root_dir: &Path,
    tmux_mode: bool,
    target: &TmuxTarget,
    client_session_name: Option<&str>,
) {
    let state = PersistedTmuxPanelState {
        panel_id: panel_id.to_string(),
        root_directory: root_dir.to_string_lossy().to_string(),
        tmux_mode,
        socket_path: target.socket_path.clone(),
        session_name: client_session_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| target.active_session_name.clone()),
        updated_at_ms: current_time_ms(),
    };

    let Some(path) = tmux_panel_state_path(panel_id) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(path, json);
    }
}

fn read_tmux_panel_state(panel_id: &str) -> Option<PersistedTmuxPanelState> {
    let path = tmux_panel_state_path(panel_id)?;
    let contents = fs::read_to_string(path).ok()?;
    serde_json::from_str(&contents).ok()
}

fn tmux_panel_state_path(panel_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    Some(
        home.join(".atterm")
            .join("tmux")
            .join("panels")
            .join(format!("{}.json", sanitize_panel_id(panel_id))),
    )
}

fn sanitize_panel_id(panel_id: &str) -> String {
    let value: String = panel_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if value.is_empty() {
        "panel".to_string()
    } else {
        value
    }
}

fn current_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
fn parse_pane_rows(output: &str) -> Vec<TmuxPane> {
    parse_field_rows(output)
        .into_iter()
        .filter_map(|fields| {
            if fields.len() < 12 {
                return None;
            }
            Some(TmuxPane {
                id: fields[0].clone(),
                index: parse_usize(&fields[1]),
                title: fields[2].clone(),
                current_command: fields[3].clone(),
                current_path: fields[4].clone(),
                active: parse_bool(&fields[5]),
                dead: parse_bool(&fields[6]),
                tty: fields[7].clone(),
                width: parse_usize(&fields[8]),
                height: parse_usize(&fields[9]),
                left: parse_usize(&fields[10]),
                top: parse_usize(&fields[11]),
            })
        })
        .collect()
}

fn parse_field_rows(output: &str) -> Vec<Vec<String>> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            line.split(FIELD_SEPARATOR)
                .map(|value| value.trim().to_string())
                .collect()
        })
        .collect()
}

fn parse_bool(value: &str) -> bool {
    matches!(value.trim(), "1" | "true" | "yes")
}

fn parse_usize(value: &str) -> usize {
    value.trim().parse::<usize>().unwrap_or(0)
}

fn tmux_version() -> Option<String> {
    let output = Command::new("tmux").arg("-V").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = stdout_text(&output).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn parse_tmux_version(version_str: &str) -> Option<(u32, u32)> {
    let version_part = version_str.trim().strip_prefix("tmux")?.trim();
    let version_part = version_part.strip_prefix("next-").unwrap_or(version_part);
    let mut parts = version_part.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor_str = parts.next().unwrap_or("0");
    let minor: u32 = minor_str
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor))
}

fn run_tmux_checked(
    cwd: Option<&Path>,
    target: &TmuxTarget,
    args: Vec<String>,
) -> Result<Output, String> {
    let output = run_tmux_raw(cwd, target, args).map_err(|err| err.to_string())?;
    if output.status.success() {
        return Ok(output);
    }

    if tmux_no_server(&output) {
        Err("tmux server is not running".to_string())
    } else {
        let stderr = stderr_text(&output);
        if stderr.trim().is_empty() {
            Err("tmux command failed".to_string())
        } else {
            Err(stderr)
        }
    }
}

fn run_tmux_raw<I, S>(cwd: Option<&Path>, target: &TmuxTarget, args: I) -> std::io::Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("tmux");
    command.env_remove("TMUX");
    command.env_remove("TMUX_PANE");
    if let Some(socket_path) = target
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("-S").arg(socket_path);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.args(args).output()
}

fn tmux_no_server(output: &Output) -> bool {
    stderr_text(output).contains("no server running")
}

fn stdout_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string()
}

fn stderr_text(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .trim_end()
        .to_string()
}

fn parse_json_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, String> {
    serde_json::from_slice(body).map_err(|err| format!("invalid JSON body: {}", err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_session() -> TerminalSession {
        TerminalSession {
            panel_id: "panel-test".to_string(),
            root_dir: PathBuf::from("/tmp"),
            tty_path: Some("/dev/pts/83".to_string()),
            pty_master_fd: None,
        }
    }

    fn test_tmux_session(name: &str, pane_path: &str) -> TmuxSession {
        TmuxSession {
            id: format!("${}", name),
            name: name.to_string(),
            attached: 0,
            window_count: 1,
            path: pane_path.to_string(),
            associated: false,
            socket_path: Some("/tmp/tmux-1000/default".to_string()),
            server_pid: Some(123),
            windows: vec![TmuxWindow {
                id: format!("@{}", name),
                index: 0,
                name: "shell".to_string(),
                flags: String::new(),
                active: true,
                zoomed: false,
                linked: false,
                pane_count: 1,
                active_pane_id: Some(format!("%{}", name)),
                panes: vec![TmuxPane {
                    id: format!("%{}", name),
                    index: 0,
                    title: String::new(),
                    current_command: "bash".to_string(),
                    current_path: pane_path.to_string(),
                    active: true,
                    dead: false,
                    tty: "/dev/pts/83".to_string(),
                    width: 120,
                    height: 30,
                    left: 0,
                    top: 0,
                }],
            }],
        }
    }

    #[test]
    fn parses_pipe_separated_tmux_pane_rows() {
        let rows = parse_pane_rows(
            "%62|||0|||bash|||bash|||/home/user|||1|||0|||/dev/pts/10|||120|||30|||0|||0\n",
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "%62");
        assert_eq!(rows[0].index, 0);
        assert_eq!(rows[0].current_command, "bash");
        assert_eq!(rows[0].current_path, "/home/user");
        assert!(rows[0].active);
        assert!(!rows[0].dead);
        assert_eq!(rows[0].tty, "/dev/pts/10");
        assert_eq!(rows[0].width, 120);
        assert_eq!(rows[0].height, 30);
    }

    #[test]
    fn parses_pipe_separated_tmux_client_rows() {
        let rows = parse_client_rows(
            "/dev/pts/83|||$1|||work|||/dev/pts/83\n/dev/pts/90|||$2|||other|||/dev/pts/90\n",
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].tty, "/dev/pts/83");
        assert_eq!(rows[0].session_id, "$1");
        assert_eq!(rows[0].session_name, "work");
        assert_eq!(rows[0].client_name, "/dev/pts/83");
        assert_eq!(rows[1].tty, "/dev/pts/90");
        assert_eq!(rows[1].session_id, "$2");
        assert_eq!(rows[1].session_name, "other");
        assert_eq!(rows[1].client_name, "/dev/pts/90");
    }

    #[test]
    fn tmux_active_requires_matching_client_tty() {
        let clients = parse_client_rows(
            "/dev/pts/83|||$1|||work|||/dev/pts/83\n/dev/pts/90|||$2|||other|||/dev/pts/90\n",
        );

        assert!(tmux_client_matches_terminal(Some("/dev/pts/83"), &clients));
        assert!(!tmux_client_matches_terminal(Some("/dev/pts/10"), &clients));
        assert!(!tmux_client_matches_terminal(None, &clients));
    }

    #[test]
    fn tmux_process_names_match_tmux_clients() {
        assert!(is_tmux_process_name("tmux\n"));
        assert!(is_tmux_process_name("tmux: client"));
        assert!(!is_tmux_process_name("bash"));
    }

    #[test]
    fn parses_linux_process_group_from_proc_stat() {
        let stat = "12345 (tmux: client) S 12344 12345 12345 34816 12345 4194304";

        assert_eq!(process_group_id_from_stat(stat), Some(12345));
    }

    #[test]
    fn parses_socket_inode_symlink_targets() {
        assert_eq!(parse_socket_inode("socket:[98765]"), Some("98765"));
        assert_eq!(parse_socket_inode("/tmp/tmux-1000/default"), None);
    }

    #[test]
    fn restored_tmux_command_uses_saved_socket_and_session() {
        let command = restored_tmux_command_for_state(&PersistedTmuxPanelState {
            panel_id: "panel-test".to_string(),
            root_directory: "/tmp".to_string(),
            tmux_mode: true,
            socket_path: Some("/tmp/tmux-1000/default".to_string()),
            session_name: Some("work".to_string()),
            updated_at_ms: 1,
        });

        assert_eq!(
            command,
            "tmux -S '/tmp/tmux-1000/default' new-session -A -s 'work' -c '/tmp'"
        );
    }

    #[test]
    fn parses_socket_level_server_snapshot_without_root_filtering() {
        let root = PathBuf::from("/work/project");
        let sessions_output = "$1|||work|||0|||1|||/work/project\n$2|||other|||0|||1|||/tmp\n";
        let windows_output = "$1|||work|||@1|||0|||shell|||*|||1|||0|||0|||1\n$2|||other|||@2|||0|||shell|||*|||1|||0|||0|||1\n";
        let panes_output = "$1|||work|||@1|||0|||%1|||0|||bash|||bash|||/work/project/src|||1|||0|||/dev/pts/1|||120|||30|||0|||0\n$2|||other|||@2|||0|||%2|||0|||bash|||bash|||/tmp|||1|||0|||/dev/pts/2|||120|||30|||0|||0\n";

        let sessions = parse_tmux_server_sessions(
            sessions_output,
            windows_output,
            panes_output,
            &root,
            Some("/tmp/tmux-1000/default".to_string()),
            Some(42),
        );

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].name, "work");
        assert!(sessions[0].associated);
        assert_eq!(
            sessions[0].socket_path.as_deref(),
            Some("/tmp/tmux-1000/default")
        );
        assert_eq!(sessions[0].server_pid, Some(42));
        assert_eq!(sessions[0].windows[0].panes[0].id, "%1");
        assert_eq!(sessions[1].name, "other");
        assert!(!sessions[1].associated);
    }

    #[test]
    fn root_matching_includes_equal_and_child_paths() {
        let root = PathBuf::from("/work/project");
        let sessions = vec![
            test_tmux_session("equal", "/work/project"),
            test_tmux_session("child", "/work/project/src"),
            test_tmux_session("sibling", "/work/project-old"),
            test_tmux_session("outside", "/tmp"),
        ];

        let matched = root_matched_sessions(&sessions, &root);

        assert_eq!(
            matched
                .iter()
                .map(|session| session.name.as_str())
                .collect::<Vec<_>>(),
            vec!["equal", "child"]
        );
    }

    #[test]
    fn root_matched_sessions_do_not_imply_client_active() {
        let root = PathBuf::from("/work/project");
        let sessions = vec![test_tmux_session("detached", "/work/project")];
        let clients = Vec::new();

        assert!(!root_matched_sessions(&sessions, &root).is_empty());
        assert!(!tmux_client_matches_terminal(Some("/dev/pts/83"), &clients));
    }

    #[test]
    fn sessions_alone_do_not_imply_tmux_active() {
        let sessions = vec![TmuxSession {
            id: "$1".to_string(),
            name: "work".to_string(),
            attached: 1,
            window_count: 1,
            path: "/home".to_string(),
            associated: false,
            socket_path: None,
            server_pid: None,
            windows: vec![TmuxWindow {
                id: "@1".to_string(),
                index: 0,
                name: "bash".to_string(),
                flags: String::new(),
                active: true,
                zoomed: false,
                linked: false,
                pane_count: 1,
                active_pane_id: Some("%1".to_string()),
                panes: vec![TmuxPane {
                    id: "%1".to_string(),
                    index: 0,
                    title: String::new(),
                    current_command: "bash".to_string(),
                    current_path: "/home".to_string(),
                    active: true,
                    dead: false,
                    tty: "/dev/pts/83".to_string(),
                    width: 120,
                    height: 30,
                    left: 0,
                    top: 0,
                }],
            }],
        }];

        assert!(!sessions.is_empty());
        assert!(!tmux_client_matches_terminal(Some("/dev/pts/10"), &[]));
    }

    #[test]
    fn missing_tmux_state_is_explicit() {
        let response = missing_tmux_state_response(&test_session());

        assert!(!response.available);
        assert!(!response.server_running);
        assert!(!response.tmux_active);
        assert!(response.panel_connected);
        assert_eq!(response.error.as_deref(), Some("tmux is not installed"));
        assert!(response.version.is_none());
    }

    #[test]
    fn disconnected_tmux_state_is_explicit() {
        let response = disconnected_tmux_state_response(Some("tmux test".to_string()));

        assert!(response.available);
        assert!(!response.server_running);
        assert!(!response.tmux_active);
        assert!(!response.panel_connected);
        assert!(response.sessions.is_empty());
        assert_eq!(
            response.error.as_deref(),
            Some("terminal panel is not connected")
        );
    }

    #[test]
    fn parse_field_rows_splits_on_triple_pipe() {
        let rows = parse_field_rows("a|||b|||c\nd|||e|||f\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a", "b", "c"]);
        assert_eq!(rows[1], vec!["d", "e", "f"]);
    }

    #[test]
    fn parse_field_rows_handles_malformed_input() {
        let rows = parse_field_rows("single-field-line\n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], vec!["single-field-line"]);
    }

    #[test]
    fn parse_field_rows_ignores_empty_lines() {
        let rows = parse_field_rows("a|||b\n\nc|||d\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a", "b"]);
        assert_eq!(rows[1], vec!["c", "d"]);
    }

    #[test]
    fn parse_field_rows_trims_fields() {
        let rows = parse_field_rows("  a  |||  b  |||  c  \n");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0], vec!["a", "b", "c"]);
    }

    #[test]
    fn parses_tmux_version_strings() {
        assert_eq!(parse_tmux_version("tmux 3.6"), Some((3, 6)));
        assert_eq!(parse_tmux_version("tmux 3.2"), Some((3, 2)));
        assert_eq!(parse_tmux_version("tmux 3.1c"), Some((3, 1)));
        assert_eq!(parse_tmux_version("tmux next-3.6"), Some((3, 6)));
        assert_eq!(parse_tmux_version("tmux 2.9a"), Some((2, 9)));
        assert_eq!(parse_tmux_version("tmux 4.0"), Some((4, 0)));
        assert_eq!(parse_tmux_version("invalid"), None);
        assert_eq!(parse_tmux_version(""), None);
    }

    #[test]
    fn version_check_enables_session_path_for_32_and_later() {
        assert!(
            parse_tmux_version("tmux 3.2").map_or(true, |(major, minor)| major > 3
                || (major == 3 && minor >= 2))
        );
        assert!(
            parse_tmux_version("tmux 3.6").map_or(true, |(major, minor)| major > 3
                || (major == 3 && minor >= 2))
        );
        assert!(
            parse_tmux_version("tmux 4.0").map_or(true, |(major, minor)| major > 3
                || (major == 3 && minor >= 2))
        );
        assert!(
            !parse_tmux_version("tmux 3.1").map_or(true, |(major, minor)| major > 3
                || (major == 3 && minor >= 2))
        );
        assert!(
            !parse_tmux_version("tmux 2.9").map_or(true, |(major, minor)| major > 3
                || (major == 3 && minor >= 2))
        );
    }
}
