use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

pub const TERMINAL_BLOCK_EVENT: &str = "terminal-block-event";
const LAUNCHER_SCOPE_ID: &str = "launcher";
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const MAX_BLOCKS_PER_SCOPE: usize = 100;
const INTERACTIVE_SEED_SEPARATOR: &str =
    "\r\n\x1b[90m--- previous output ---\x1b[0m\r\n";
const PRINT_STDIN_ERROR: &str =
    "Input must be provided either through stdin or as a prompt argument when using --print";
const PRINT_STDIN_HINT: &str = "\n[terminal blocks] This command ran without interactive stdin. For --print-style CLIs, pass a prompt argument or pipe input, for example: echo 'your prompt' | command --print\n";
const SHELL_ENV_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBlockSnapshot {
    pub id: String,
    pub scope_id: String,
    pub command: String,
    pub root_directory: String,
    pub tab_id: Option<String>,
    pub run_group_id: String,
    pub run_index: u32,
    pub status: String,
    pub execution_mode: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBlockEvent {
    pub kind: String,
    pub scope_id: String,
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<TerminalBlockSnapshot>,
}

#[derive(Default)]
struct TerminalBlockInner {
    blocks_by_scope: HashMap<String, Vec<TerminalBlockSnapshot>>,
    running_by_block: HashMap<String, CancellationToken>,
    interactive_by_block: HashMap<String, InteractiveBlockRuntime>,
}

#[derive(Clone, Default)]
pub struct TerminalBlockState {
    inner: Arc<Mutex<TerminalBlockInner>>,
}

#[derive(Clone)]
struct InteractiveBlockRuntime {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
}

#[tauri::command]
pub fn list_terminal_blocks(
    state: State<'_, TerminalBlockState>,
    scope_id: String,
) -> Result<Vec<TerminalBlockSnapshot>, String> {
    let scope_id = normalize_scope_id(scope_id);
    let inner = state
        .inner
        .lock()
        .map_err(|_| "terminal block state lock poisoned".to_string())?;
    Ok(inner
        .blocks_by_scope
        .get(&scope_id)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub fn cancel_terminal_block(
    state: State<'_, TerminalBlockState>,
    block_id: String,
) -> Result<(), String> {
    let token = {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "terminal block state lock poisoned".to_string())?;
        inner.running_by_block.get(&block_id).cloned()
    };

    if let Some(token) = token {
        token.cancel();
    }
    kill_interactive_runtime(&state, &block_id);

    Ok(())
}

#[tauri::command]
pub fn delete_terminal_block(
    app: AppHandle,
    state: State<'_, TerminalBlockState>,
    block_id: String,
) -> Result<(), String> {
    let (scope_id, token, runtime) = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "terminal block state lock poisoned".to_string())?;

        let mut deleted_scope_id = None;
        for (scope_id, blocks) in inner.blocks_by_scope.iter_mut() {
            if let Some(index) = blocks.iter().position(|block| block.id == block_id) {
                blocks.remove(index);
                deleted_scope_id = Some(scope_id.clone());
                break;
            }
        }

        let Some(scope_id) = deleted_scope_id else {
            return Ok(());
        };
        let token = inner.running_by_block.remove(&block_id);
        let runtime = inner.interactive_by_block.remove(&block_id);
        (scope_id, token, runtime)
    };

    if let Some(token) = token {
        token.cancel();
    }
    kill_runtime(runtime);

    emit_block_event(
        &app,
        TerminalBlockEvent {
            kind: "deleted".to_string(),
            scope_id,
            block_id,
            output: None,
            block: None,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn start_terminal_block(
    app: AppHandle,
    state: State<'_, TerminalBlockState>,
    scope_id: String,
    block_id: String,
    command: String,
    root_directory: Option<String>,
    tab_id: Option<String>,
    run_group_id: Option<String>,
    run_index: Option<u32>,
) -> Result<TerminalBlockSnapshot, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let scope_id = normalize_scope_id(scope_id);
    let block_id = block_id.trim().to_string();
    if block_id.is_empty() {
        return Err("Block id cannot be empty".to_string());
    }

    let run_group_id = run_group_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| block_id.clone());
    let run_index = run_index.filter(|value| *value > 0).unwrap_or(1);
    let cwd = valid_working_dir(root_directory).unwrap_or_else(default_home_dir);
    let snapshot = TerminalBlockSnapshot {
        id: block_id.clone(),
        scope_id: scope_id.clone(),
        command: command.clone(),
        root_directory: cwd.to_string_lossy().to_string(),
        tab_id,
        run_group_id,
        run_index,
        status: "running".to_string(),
        execution_mode: "captured".to_string(),
        output: String::new(),
        exit_code: None,
        started_at: now_millis(),
        finished_at: None,
        truncated: false,
        error: None,
    };
    let cancel_token = CancellationToken::new();

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "terminal block state lock poisoned".to_string())?;

        if inner.running_by_block.contains_key(&block_id)
            || inner
                .blocks_by_scope
                .values()
                .any(|blocks| blocks.iter().any(|block| block.id == block_id))
        {
            return Err("Block id already exists".to_string());
        }

        let blocks = inner.blocks_by_scope.entry(scope_id.clone()).or_default();
        blocks.push(snapshot.clone());
        while blocks.len() > MAX_BLOCKS_PER_SCOPE {
            let Some(index) = blocks.iter().position(|block| block.status != "running") else {
                break;
            };
            blocks.remove(index);
        }
        inner
            .running_by_block
            .insert(block_id.clone(), cancel_token.clone());
    }

    emit_block_event(
        &app,
        TerminalBlockEvent {
            kind: "started".to_string(),
            scope_id: scope_id.clone(),
            block_id: block_id.clone(),
            output: None,
            block: Some(snapshot.clone()),
        },
    );

    let state_clone = state.inner().clone();
    let task_snapshot = snapshot.clone();
    tauri::async_runtime::spawn(async move {
        run_terminal_block(app, state_clone, task_snapshot, cwd, cancel_token).await;
    });

    Ok(snapshot)
}

#[tauri::command]
pub fn start_interactive_terminal_block(
    app: AppHandle,
    state: State<'_, TerminalBlockState>,
    scope_id: String,
    block_id: String,
    command: String,
    root_directory: Option<String>,
    tab_id: Option<String>,
    run_group_id: Option<String>,
    run_index: Option<u32>,
    cols: Option<u16>,
    rows: Option<u16>,
    seed_output: Option<String>,
) -> Result<TerminalBlockSnapshot, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let scope_id = normalize_scope_id(scope_id);
    let block_id = block_id.trim().to_string();
    if block_id.is_empty() {
        return Err("Block id cannot be empty".to_string());
    }

    let run_group_id = run_group_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| block_id.clone());
    let run_index = run_index.filter(|value| *value > 0).unwrap_or(1);
    let cwd = valid_working_dir(root_directory).unwrap_or_else(default_home_dir);
    let mut snapshot = TerminalBlockSnapshot {
        id: block_id.clone(),
        scope_id: scope_id.clone(),
        command: command.clone(),
        root_directory: cwd.to_string_lossy().to_string(),
        tab_id,
        run_group_id,
        run_index,
        status: "running".to_string(),
        execution_mode: "interactive".to_string(),
        output: String::new(),
        exit_code: None,
        started_at: now_millis(),
        finished_at: None,
        truncated: false,
        error: None,
    };
    if let Some(seed) = seed_output.filter(|value| !value.trim().is_empty()) {
        append_capped_output(&mut snapshot, INTERACTIVE_SEED_SEPARATOR);
        append_capped_output(&mut snapshot, &seed);
        append_capped_output(&mut snapshot, "\r\n\x1b[90m--- interactive rerun ---\x1b[0m\r\n");
    }

    let cancel_token = CancellationToken::new();

    {
        let mut inner = state
            .inner
            .lock()
            .map_err(|_| "terminal block state lock poisoned".to_string())?;

        if inner.running_by_block.contains_key(&block_id)
            || inner
                .blocks_by_scope
                .values()
                .any(|blocks| blocks.iter().any(|block| block.id == block_id))
        {
            return Err("Block id already exists".to_string());
        }

        let blocks = inner.blocks_by_scope.entry(scope_id.clone()).or_default();
        blocks.push(snapshot.clone());
        while blocks.len() > MAX_BLOCKS_PER_SCOPE {
            let Some(index) = blocks.iter().position(|block| block.status != "running") else {
                break;
            };
            blocks.remove(index);
        }
        inner
            .running_by_block
            .insert(block_id.clone(), cancel_token.clone());
    }

    emit_block_event(
        &app,
        TerminalBlockEvent {
            kind: "started".to_string(),
            scope_id: scope_id.clone(),
            block_id: block_id.clone(),
            output: None,
            block: Some(snapshot.clone()),
        },
    );

    let state_clone = state.inner().clone();
    let task_snapshot = snapshot.clone();
    tauri::async_runtime::spawn(async move {
        run_interactive_terminal_block(
            app,
            state_clone,
            task_snapshot,
            cwd,
            cols.unwrap_or(80),
            rows.unwrap_or(18),
            cancel_token,
        )
        .await;
    });

    Ok(snapshot)
}

#[tauri::command]
pub fn write_interactive_terminal_block(
    state: State<'_, TerminalBlockState>,
    block_id: String,
    input: String,
) -> Result<(), String> {
    let runtime = interactive_runtime(&state, &block_id)?;
    let mut writer = runtime
        .writer
        .lock()
        .map_err(|_| "interactive terminal writer lock poisoned".to_string())?;
    writer
        .write_all(input.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn resize_interactive_terminal_block(
    state: State<'_, TerminalBlockState>,
    block_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let runtime = interactive_runtime(&state, &block_id)?;
    let size = PtySize {
        rows: rows.max(2),
        cols: cols.max(10),
        pixel_width: 0,
        pixel_height: 0,
    };
    let result = runtime
        .master
        .lock()
        .map_err(|_| "interactive terminal master lock poisoned".to_string())?
        .resize(size)
        .map_err(|error| error.to_string());
    result
}

async fn run_terminal_block(
    app: AppHandle,
    state: TerminalBlockState,
    snapshot: TerminalBlockSnapshot,
    cwd: PathBuf,
    cancel_token: CancellationToken,
) {
    let shell = default_shell();
    let shell_env = interactive_shell_environment(&shell).await;
    let mut command = shell_command(&shell, &snapshot.command);
    apply_shell_environment(&mut command, shell_env);
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_block(
                &app,
                &state,
                &snapshot.scope_id,
                &snapshot.id,
                "failed",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(stdout) = stdout {
        spawn_output_reader(
            app.clone(),
            state.clone(),
            snapshot.scope_id.clone(),
            snapshot.id.clone(),
            stdout,
        );
    }
    if let Some(stderr) = stderr {
        spawn_output_reader(
            app.clone(),
            state.clone(),
            snapshot.scope_id.clone(),
            snapshot.id.clone(),
            stderr,
        );
    }

    tokio::select! {
        _ = cancel_token.cancelled() => {
            kill_child_tree(&mut child).await;
            let _ = child.wait().await;
            finish_block(&app, &state, &snapshot.scope_id, &snapshot.id, "cancelled", None, None);
        }
        result = child.wait() => {
            match result {
                Ok(status) => {
                    let exit_code = status.code();
                    let status_label = if status.success() { "success" } else { "failed" };
                    finish_block(&app, &state, &snapshot.scope_id, &snapshot.id, status_label, exit_code, None);
                }
                Err(error) => {
                    finish_block(&app, &state, &snapshot.scope_id, &snapshot.id, "failed", None, Some(error.to_string()));
                }
            }
        }
    }
}

async fn run_interactive_terminal_block(
    app: AppHandle,
    state: TerminalBlockState,
    snapshot: TerminalBlockSnapshot,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
    cancel_token: CancellationToken,
) {
    let shell = default_shell();
    let shell_env = interactive_shell_environment(&shell).await;
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: rows.max(2),
        cols: cols.max(10),
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => {
            finish_block(
                &app,
                &state,
                &snapshot.scope_id,
                &snapshot.id,
                "failed",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };

    let mut command = pty_shell_command(&shell, &snapshot.command);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env_remove("TMUX");
    command.env_remove("TMUX_PANE");
    apply_pty_shell_environment(&mut command, shell_env);

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            finish_block(
                &app,
                &state,
                &snapshot.scope_id,
                &snapshot.id,
                "failed",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            finish_block(
                &app,
                &state,
                &snapshot.scope_id,
                &snapshot.id,
                "failed",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            finish_block(
                &app,
                &state,
                &snapshot.scope_id,
                &snapshot.id,
                "failed",
                None,
                Some(error.to_string()),
            );
            return;
        }
    };

    let runtime = InteractiveBlockRuntime {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        killer: Arc::new(Mutex::new(child.clone_killer())),
    };

    {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner
            .interactive_by_block
            .insert(snapshot.id.clone(), runtime.clone());
    }

    spawn_interactive_output_reader(
        app.clone(),
        state.clone(),
        snapshot.scope_id.clone(),
        snapshot.id.clone(),
        reader,
    );

    let cancel_runtime = runtime.clone();
    let cancel_token_clone = cancel_token.clone();
    tauri::async_runtime::spawn(async move {
        cancel_token_clone.cancelled().await;
        kill_runtime(Some(cancel_runtime));
    });

    let app_for_wait = app.clone();
    let state_for_wait = state.clone();
    let scope_id = snapshot.scope_id.clone();
    let block_id = snapshot.id.clone();
    thread::spawn(move || {
        let result = child.wait();
        remove_interactive_runtime(&state_for_wait, &block_id);
        if cancel_token.is_cancelled() {
            finish_block(
                &app_for_wait,
                &state_for_wait,
                &scope_id,
                &block_id,
                "cancelled",
                None,
                None,
            );
            return;
        }

        match result {
            Ok(status) => {
                let exit_code = i32::try_from(status.exit_code()).ok();
                let status_label = if status.success() { "success" } else { "failed" };
                finish_block(
                    &app_for_wait,
                    &state_for_wait,
                    &scope_id,
                    &block_id,
                    status_label,
                    exit_code,
                    None,
                );
            }
            Err(error) => {
                finish_block(
                    &app_for_wait,
                    &state_for_wait,
                    &scope_id,
                    &block_id,
                    "failed",
                    None,
                    Some(error.to_string()),
                );
            }
        }
    });
}

fn spawn_interactive_output_reader(
    app: AppHandle,
    state: TerminalBlockState,
    scope_id: String,
    block_id: String,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let output = String::from_utf8_lossy(&buffer[..size]).to_string();
                    append_interactive_output(&app, &state, &scope_id, &block_id, output);
                }
                Err(error) => {
                    append_interactive_output(
                        &app,
                        &state,
                        &scope_id,
                        &block_id,
                        format!("\n[interactive output stream error: {}]\n", error),
                    );
                    break;
                }
            }
        }
    });
}

fn spawn_output_reader<R>(
    app: AppHandle,
    state: TerminalBlockState,
    scope_id: String,
    block_id: String,
    mut reader: R,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(size) => {
                    let output = String::from_utf8_lossy(&buffer[..size]).to_string();
                    append_output(&app, &state, &scope_id, &block_id, output);
                }
                Err(error) => {
                    append_output(
                        &app,
                        &state,
                        &scope_id,
                        &block_id,
                        format!("\n[output stream error: {}]\n", error),
                    );
                    break;
                }
            }
        }
    });
}

fn append_output(
    app: &AppHandle,
    state: &TerminalBlockState,
    scope_id: &str,
    block_id: &str,
    output: String,
) {
    let (event_output, block) = {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let Some(block) = inner
            .blocks_by_scope
            .get_mut(scope_id)
            .and_then(|blocks| blocks.iter_mut().find(|block| block.id == block_id))
        else {
            return;
        };

        let remaining = MAX_OUTPUT_BYTES.saturating_sub(block.output.len());
        let event_output = if remaining == 0 {
            if block.truncated {
                return;
            }
            block.truncated = true;
            None
        } else {
            let capped = truncate_to_boundary(&output, remaining);
            if capped.len() < output.len() {
                block.truncated = true;
            }
            block.output.push_str(&capped);
            Some(capped)
        };

        (event_output, block.clone())
    };

    emit_block_event(
        app,
        TerminalBlockEvent {
            kind: "output".to_string(),
            scope_id: scope_id.to_string(),
            block_id: block_id.to_string(),
            output: event_output,
            block: Some(block),
        },
    );
}

fn append_interactive_output(
    app: &AppHandle,
    state: &TerminalBlockState,
    scope_id: &str,
    block_id: &str,
    output: String,
) {
    let (event_output, block) = {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let Some(block) = inner
            .blocks_by_scope
            .get_mut(scope_id)
            .and_then(|blocks| blocks.iter_mut().find(|block| block.id == block_id))
        else {
            return;
        };

        let remaining = MAX_OUTPUT_BYTES.saturating_sub(block.output.len());
        let event_output = if remaining == 0 {
            if block.truncated {
                return;
            }
            block.truncated = true;
            None
        } else {
            let capped = truncate_to_boundary(&output, remaining);
            if capped.len() < output.len() {
                block.truncated = true;
            }
            block.output.push_str(&capped);
            Some(capped)
        };

        (event_output, block.clone())
    };

    emit_block_event(
        app,
        TerminalBlockEvent {
            kind: "interactiveOutput".to_string(),
            scope_id: scope_id.to_string(),
            block_id: block_id.to_string(),
            output: event_output,
            block: Some(block),
        },
    );
}

fn finish_block(
    app: &AppHandle,
    state: &TerminalBlockState,
    scope_id: &str,
    block_id: &str,
    status: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    let block = {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.running_by_block.remove(block_id);
        inner.interactive_by_block.remove(block_id);
        let Some(block) = inner
            .blocks_by_scope
            .get_mut(scope_id)
            .and_then(|blocks| blocks.iter_mut().find(|block| block.id == block_id))
        else {
            return;
        };

        block.status = status.to_string();
        block.exit_code = exit_code;
        block.finished_at = Some(now_millis());
        block.error = error;
        if block.execution_mode == "interactive" {
            block.output = strip_terminal_control_sequences(&block.output);
        }
        if status == "failed" && block.output.contains(PRINT_STDIN_ERROR) {
            append_capped_output(block, PRINT_STDIN_HINT);
        }
        block.clone()
    };

    emit_block_event(
        app,
        TerminalBlockEvent {
            kind: "finished".to_string(),
            scope_id: scope_id.to_string(),
            block_id: block_id.to_string(),
            output: None,
            block: Some(block),
        },
    );
}

fn emit_block_event(app: &AppHandle, event: TerminalBlockEvent) {
    let _ = app.emit(TERMINAL_BLOCK_EVENT, event);
}

fn normalize_scope_id(scope_id: String) -> String {
    let scope_id = scope_id.trim();
    if scope_id.is_empty() {
        LAUNCHER_SCOPE_ID.to_string()
    } else {
        scope_id.to_string()
    }
}

fn valid_working_dir(path: Option<String>) -> Option<PathBuf> {
    path.map(PathBuf::from).filter(|path| path.is_dir())
}

fn default_home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
        {
            return path;
        }
    }

    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok().filter(|path| path.is_dir()))
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                PathBuf::from(r"C:\")
            }
            #[cfg(not(windows))]
            {
                PathBuf::from("/")
            }
        })
}

fn shell_command(shell: &str, command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new(shell);
        cmd.arg("/C").arg(command);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(shell);
        cmd.arg("-c").arg(command);
        cmd
    }
}

fn pty_shell_command(shell: &str, command: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    #[cfg(windows)]
    {
        cmd.arg("/C");
        cmd.arg(command);
    }
    #[cfg(not(windows))]
    {
        cmd.arg("-lc");
        cmd.arg(command);
    }
    cmd
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string())
    }

    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

async fn interactive_shell_environment(shell: &str) -> HashMap<String, String> {
    #[cfg(windows)]
    {
        let _ = shell;
        HashMap::new()
    }

    #[cfg(not(windows))]
    {
        let shell_path = PathBuf::from(shell);
        let shell_name = shell_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let args: &[&str] = match shell_name {
            "bash" | "zsh" => &["-lic", "env -0"],
            "fish" => &["-ic", "env -0"],
            _ => return HashMap::new(),
        };

        let mut probe = Command::new(shell);
        probe
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let output = match tokio::time::timeout(SHELL_ENV_PROBE_TIMEOUT, probe.output()).await {
            Ok(Ok(output)) => output,
            _ => return HashMap::new(),
        };

        parse_env_output(&output.stdout)
    }
}

fn apply_shell_environment(command: &mut Command, env: HashMap<String, String>) {
    for (key, value) in env {
        if should_apply_shell_env(&key) {
            command.env(key, value);
        }
    }
}

fn apply_pty_shell_environment(command: &mut CommandBuilder, env: HashMap<String, String>) {
    for (key, value) in env {
        if should_apply_shell_env(&key) {
            command.env(key, value);
        }
    }
}

fn interactive_runtime(
    state: &TerminalBlockState,
    block_id: &str,
) -> Result<InteractiveBlockRuntime, String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "terminal block state lock poisoned".to_string())?;
    inner
        .interactive_by_block
        .get(block_id)
        .cloned()
        .ok_or_else(|| "Interactive terminal block is not running".to_string())
}

fn remove_interactive_runtime(state: &TerminalBlockState, block_id: &str) {
    if let Ok(mut inner) = state.inner.lock() {
        inner.interactive_by_block.remove(block_id);
    }
}

fn kill_interactive_runtime(state: &TerminalBlockState, block_id: &str) {
    let runtime = {
        let mut inner = match state.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        inner.interactive_by_block.remove(block_id)
    };
    kill_runtime(runtime);
}

fn kill_runtime(runtime: Option<InteractiveBlockRuntime>) {
    if let Some(runtime) = runtime {
        if let Ok(mut killer) = runtime.killer.lock() {
            let _ = killer.kill();
        }
    }
}

fn should_apply_shell_env(key: &str) -> bool {
    !matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "_" | "TERM")
}

fn parse_env_output(output: &[u8]) -> HashMap<String, String> {
    output
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let text = String::from_utf8_lossy(entry);
            let (key, value) = text.split_once('=')?;
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

async fn kill_child_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
            return;
        }
    }

    let _ = child.kill().await;
}

fn truncate_to_boundary(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn append_capped_output(block: &mut TerminalBlockSnapshot, output: &str) {
    let remaining = MAX_OUTPUT_BYTES.saturating_sub(block.output.len());
    if remaining == 0 {
        block.truncated = true;
        return;
    }

    let capped = truncate_to_boundary(output, remaining);
    if capped.len() < output.len() {
        block.truncated = true;
    }
    block.output.push_str(&capped);
}

fn strip_terminal_control_sequences(value: &str) -> String {
    let mut plain = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => {
                match chars.peek().copied() {
                    Some('[') => {
                        chars.next();
                        for next in chars.by_ref() {
                            if ('@'..='~').contains(&next) {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        chars.next();
                        let mut previous_was_escape = false;
                        for next in chars.by_ref() {
                            if next == '\x07' || (previous_was_escape && next == '\\') {
                                break;
                            }
                            previous_was_escape = next == '\x1b';
                        }
                    }
                    Some(_) => {
                        chars.next();
                    }
                    None => {}
                }
            }
            '\r' => {
                if chars.peek().copied() != Some('\n') {
                    plain.push('\n');
                }
            }
            '\x08' => {
                plain.pop();
            }
            '\t' | '\n' => plain.push(ch),
            ch if !ch.is_control() => plain.push(ch),
            _ => {}
        }
    }

    plain
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nul_separated_environment_output() {
        let env = parse_env_output(b"PATH=/user/node/bin:/usr/bin\0NVM_DIR=/home/me/.nvm\0\0");

        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/user/node/bin:/usr/bin")
        );
        assert_eq!(
            env.get("NVM_DIR").map(String::as_str),
            Some("/home/me/.nvm")
        );
    }

    #[test]
    fn skips_shell_bookkeeping_environment_keys() {
        assert!(!should_apply_shell_env("PWD"));
        assert!(!should_apply_shell_env("OLDPWD"));
        assert!(!should_apply_shell_env("SHLVL"));
        assert!(!should_apply_shell_env("_"));
        assert!(!should_apply_shell_env("TERM"));
        assert!(should_apply_shell_env("PATH"));
        assert!(should_apply_shell_env("NVM_DIR"));
    }
}
