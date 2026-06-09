mod http;
mod terminal;
mod tmux;

use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 47831;

#[derive(Clone)]
pub(crate) struct ServerConfig {
    pub(crate) origin: String,
    pub(crate) token: String,
    pub(crate) allowed_origin: Option<String>,
}

fn main() -> std::io::Result<()> {
    let port = configured_port();
    let host = format!("{}:{}", DEFAULT_HOST, port);
    let listener = TcpListener::bind(&host)?;
    let base_dir = std::env::current_dir()?;
    let config = Arc::new(ServerConfig {
        origin: format!("http://{}", host),
        token: std::env::var("AT_BASE_TOKEN").unwrap_or_default(),
        allowed_origin: std::env::var("AT_BASE_ALLOWED_ORIGIN").ok(),
    });
    println!("[base-module] listening on http://{}", host);

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let base_dir = base_dir.clone();
                let config = Arc::clone(&config);
                thread::spawn(move || {
                    if let Err(err) = handle_client(stream, &base_dir, &config) {
                        eprintln!("[base-module] request failed: {}", err);
                    }
                });
            }
            Err(err) => eprintln!("[base-module] connection failed: {}", err),
        }
    }

    Ok(())
}

fn configured_port() -> u16 {
    std::env::var("AT_BASE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn handle_client(
    mut stream: TcpStream,
    base_dir: &Path,
    config: &ServerConfig,
) -> std::io::Result<()> {
    let request = http::read_http_request(&mut stream)?;
    let normalized_target = http::normalize_request_target(&request.path);
    let path = normalized_target.split('?').next().unwrap_or("/");

    if !http::is_authorized_request(&request, path, config) {
        return http::respond_text(&mut stream, 403, "forbidden\n");
    }

    if request.is_websocket && path == "/ws/terminal" {
        return terminal::handle_terminal_websocket(stream, request);
    }

    match (request.method.as_str(), path) {
        ("GET", "/health") => http::respond_text(&mut stream, 200, "ok\n"),
        ("GET", "/api/base/version") => tmux::handle_base_version_request(&mut stream, &request),
        ("GET", "/panels/empty") | ("GET", "/panels/empty/") => {
            http::respond_file(&mut stream, &base_dir.join("ui/empty.html"), "text/html")
        }
        ("GET", "/panels/popup-demo") | ("GET", "/panels/popup-demo/") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/popup-demo.html"),
            "text/html",
        ),
        ("GET", "/panels/terminal") | ("GET", "/panels/terminal/") => {
            http::respond_file(&mut stream, &base_dir.join("ui/terminal.html"), "text/html")
        }
        ("GET", "/panels/tmux-manager") | ("GET", "/panels/tmux-manager/") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/tmux-manager.html"),
            "text/html",
        ),
        ("GET", "/assets/base.css") => {
            http::respond_file(&mut stream, &base_dir.join("ui/base.css"), "text/css")
        }
        ("GET", "/assets/terminal.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/terminal.js"),
            "application/javascript",
        ),
        ("GET", "/assets/tmux-controller.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/tmux-controller.js"),
            "application/javascript",
        ),
        ("GET", "/assets/tmux-actions.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/tmux-actions.js"),
            "application/javascript",
        ),
        ("GET", "/assets/tmux-manager.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/tmux-manager.js"),
            "application/javascript",
        ),
        ("GET", "/assets/xterm.css") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/vendor/xterm.css"),
            "text/css",
        ),
        ("GET", "/assets/xterm.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/vendor/xterm.js"),
            "application/javascript",
        ),
        ("GET", "/assets/xterm-addon-fit.js") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/vendor/xterm-addon-fit.js"),
            "application/javascript",
        ),
        ("GET", "/assets/tmux-window-new.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-window-new.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-window-prev.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-window-prev.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-window-next.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-window-next.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-split-vertical.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-split-vertical.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-split-horizontal.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-split-horizontal.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-pin-panel.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-pin-panel.svg"),
            "image/svg+xml",
        ),
        ("GET", "/assets/tmux-mouse-on.svg") => http::respond_file(
            &mut stream,
            &base_dir.join("ui/assets/tmux-mouse-on.svg"),
            "image/svg+xml",
        ),
        ("GET", "/api/tmux/state") => tmux::handle_tmux_state_request(&mut stream, &request),
        ("POST", "/api/tmux/command") => tmux::handle_tmux_command_request(&mut stream, &request),
        ("OPTIONS", _) => http::respond_empty(&mut stream, 204),
        _ => http::respond_text(&mut stream, 404, "not found\n"),
    }
}
