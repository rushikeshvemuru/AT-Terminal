use crate::http::{
    parse_query, read_ws_frame, respond_text, send_ws_frame, send_ws_text, websocket_accept_key,
    HttpRequest,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
#[cfg(unix)]
use std::ffi::CStr;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

static TERMINAL_SESSIONS: OnceLock<Arc<Mutex<HashMap<String, TerminalSession>>>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct TerminalSession {
    pub(crate) panel_id: String,
    pub(crate) root_dir: PathBuf,
    pub(crate) tty_path: Option<String>,
    pub(crate) pty_master_fd: Option<i32>,
}

pub(crate) fn lookup_terminal_session(panel_id: &str) -> Option<TerminalSession> {
    terminal_sessions()
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(panel_id).cloned())
}

pub(crate) fn handle_terminal_websocket(
    mut stream: TcpStream,
    request: HttpRequest,
) -> std::io::Result<()> {
    let Some(key) = request.headers.get("sec-websocket-key") else {
        return respond_text(&mut stream, 400, "missing websocket key\n");
    };

    let accept = websocket_accept_key(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        accept
    );
    stream.write_all(response.as_bytes())?;

    let params = parse_query(&request.path);
    let panel_id = params
        .get("panelId")
        .filter(|value| !value.trim().is_empty())
        .cloned();
    let root_dir = params
        .get("rootDirectory")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .and_then(valid_working_dir)
        .unwrap_or_else(default_home_dir);
    let cols = params
        .get("cols")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(80);
    let rows = params
        .get("rows")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(24);
    let startup_command = params
        .get("startupCommand")
        .filter(|value| !value.trim().is_empty())
        .cloned();

    run_pty_session(stream, panel_id, root_dir, cols, rows, startup_command)
}

fn terminal_sessions() -> &'static Arc<Mutex<HashMap<String, TerminalSession>>> {
    TERMINAL_SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn run_pty_session(
    mut stream: TcpStream,
    panel_id: Option<String>,
    root_dir: PathBuf,
    cols: u16,
    rows: u16,
    startup_command: Option<String>,
) -> std::io::Result<()> {
    let shell = default_shell();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(std::io::Error::other)?;
    let tty_path = pty_slave_name(pair.master.as_ref());
    let pty_master_fd = pty_master_fd(pair.master.as_ref());

    if let Some(panel_id) = panel_id.as_ref() {
        register_terminal_session(panel_id, root_dir.clone(), tty_path, pty_master_fd);
    }

    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(root_dir.clone());
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("TMUX");
    cmd.env_remove("TMUX_PANE");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(std::io::Error::other)?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(std::io::Error::other)?;
    let mut pty_writer = pair.master.take_writer().map_err(std::io::Error::other)?;
    let master = pair.master;
    let mut output_stream = stream.try_clone()?;

    if let Some(command) = startup_command.filter(|value| !value.trim().is_empty()) {
        pty_writer.write_all(command.as_bytes())?;
        pty_writer.write_all(b"\n")?;
        pty_writer.flush()?;
    } else if let Some(panel_id) = panel_id.as_deref() {
        if let Some(command) = crate::tmux::restored_tmux_startup_command(panel_id, &root_dir) {
            pty_writer.write_all(command.as_bytes())?;
            pty_writer.write_all(b"\n")?;
            pty_writer.flush()?;
        }
    }

    let output_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]);
                    if send_ws_text(&mut output_stream, data.as_bytes()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    loop {
        let frame = match read_ws_frame(&mut stream) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(_) => break,
        };

        match frame.opcode {
            0x1 | 0x2 => {
                let message = String::from_utf8_lossy(&frame.payload);
                if let Some(input) = message.strip_prefix('i') {
                    pty_writer.write_all(input.as_bytes())?;
                    pty_writer.flush()?;
                } else if let Some(command) = message.strip_prefix('c') {
                    pty_writer.write_all(command.as_bytes())?;
                    pty_writer.write_all(b"\n")?;
                    pty_writer.flush()?;
                } else if let Some(size) = message.strip_prefix("r:") {
                    if let Some((cols, rows)) = parse_resize(size) {
                        let _ = master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
            }
            0x8 => break,
            0x9 => {
                let _ = send_ws_frame(&mut stream, 0xA, &frame.payload);
            }
            _ => {}
        }
    }

    if let Some(panel_id) = panel_id.as_ref() {
        unregister_terminal_session(panel_id);
    }

    let _ = child.kill();
    drop(pty_writer);
    drop(master);
    let _ = output_thread.join();
    let _ = child.wait();
    Ok(())
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                std::env::var("SystemRoot").ok().map(|root| {
                    format!(
                        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
                        root
                    )
                })
            })
            .unwrap_or_else(|| "cmd.exe".to_string())
    }

    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn register_terminal_session(
    panel_id: &str,
    root_dir: PathBuf,
    tty_path: Option<String>,
    pty_master_fd: Option<i32>,
) {
    if let Ok(mut sessions) = terminal_sessions().lock() {
        sessions.insert(
            panel_id.to_string(),
            TerminalSession {
                panel_id: panel_id.to_string(),
                root_dir,
                tty_path,
                pty_master_fd,
            },
        );
    }
}

fn unregister_terminal_session(panel_id: &str) {
    if let Ok(mut sessions) = terminal_sessions().lock() {
        sessions.remove(panel_id);
    }
}

fn parse_resize(value: &str) -> Option<(u16, u16)> {
    let (cols, rows) = value.split_once(':')?;
    Some((cols.parse().ok()?, rows.parse().ok()?))
}

fn valid_working_dir(path: PathBuf) -> Option<PathBuf> {
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

fn default_home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(path) = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .and_then(valid_working_dir)
        {
            return path;
        }

        if let (Some(drive), Some(path)) =
            (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH"))
        {
            let mut home = PathBuf::from(drive);
            home.push(path);
            if let Some(path) = valid_working_dir(home) {
                return path;
            }
        }
    }

    std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(valid_working_dir)
        .or_else(|| std::env::current_dir().ok().and_then(valid_working_dir))
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

#[cfg(unix)]
fn pty_slave_name(master: &dyn portable_pty::MasterPty) -> Option<String> {
    let fd = master.as_raw_fd()?;
    let mut buffer = [0 as libc::c_char; 128];
    let result = unsafe { libc::ptsname_r(fd, buffer.as_mut_ptr(), buffer.len()) };
    if result != 0 {
        return None;
    }

    unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

#[cfg(not(unix))]
fn pty_slave_name(_master: &dyn portable_pty::MasterPty) -> Option<String> {
    None
}

#[cfg(unix)]
fn pty_master_fd(master: &dyn portable_pty::MasterPty) -> Option<i32> {
    master.as_raw_fd()
}

#[cfg(not(unix))]
fn pty_master_fd(_master: &dyn portable_pty::MasterPty) -> Option<i32> {
    None
}
