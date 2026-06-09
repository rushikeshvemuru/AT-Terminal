use crate::ServerConfig;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;

const HEADER_LIMIT: usize = 64 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub is_websocket: bool,
}

pub struct WsFrame {
    pub opcode: u8,
    pub payload: Vec<u8>,
}

pub fn read_http_request(stream: &mut TcpStream) -> std::io::Result<HttpRequest> {
    let mut data = Vec::new();
    let mut buf = [0u8; 4096];
    let mut header_end = None;

    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);

        if header_end.is_none() {
            header_end = find_header_end(&data);
        }
        if header_end.is_some() {
            break;
        }
        if data.len() > HEADER_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request headers too large",
            ));
        }
    }

    let header_end = header_end.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "incomplete HTTP headers")
    })?;

    let header_text = String::from_utf8_lossy(&data[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("GET").to_string();
    let path = request_parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();

    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;

    while data.len() < body_start + content_length {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
    }

    let mut body = Vec::new();
    if body_start < data.len() {
        let body_end = std::cmp::min(data.len(), body_start + content_length);
        body.extend_from_slice(&data[body_start..body_end]);
    }

    let is_websocket = headers
        .get("upgrade")
        .map(|value| value.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
        is_websocket,
    })
}

pub fn normalize_request_target(target: &str) -> String {
    if let Some(scheme_index) = target.find("://") {
        let after_scheme = &target[scheme_index + 3..];
        if let Some(path_offset) = after_scheme.find('/') {
            return after_scheme[path_offset..].to_string();
        }
        return "/".to_string();
    }

    target.to_string()
}

pub fn is_authorized_request(request: &HttpRequest, path: &str, config: &ServerConfig) -> bool {
    if config.token.trim().is_empty() {
        return true;
    }

    if path.starts_with("/assets/") {
        return true;
    }

    let has_token = query_value(&request.path, "atToken")
        .or_else(|| header_bearer_token(request))
        .or_else(|| header_value(request, "x-at-terminal-token"))
        .or_else(|| cookie_value(request, "at_terminal_token"))
        .is_some_and(|value| value == config.token);

    if !has_token {
        return false;
    }

    match header_value(request, "origin") {
        Some(origin) => origin_allowed(&origin, config),
        None => true,
    }
}

pub fn respond_text(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    respond_bytes(stream, status, "text/plain", body.as_bytes())
}

fn origin_allowed(origin: &str, config: &ServerConfig) -> bool {
    let trimmed = origin.trim();
    trimmed == config.origin
        || config
            .allowed_origin
            .as_deref()
            .is_some_and(|allowed| trimmed == allowed.trim())
        || matches!(
            trimmed,
            "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
        )
}

fn header_value(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers
        .get(&name.to_ascii_lowercase())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn header_bearer_token(request: &HttpRequest) -> Option<String> {
    let value = header_value(request, "authorization")?;
    value
        .strip_prefix("Bearer ")
        .map(str::trim)
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
}

fn cookie_value(request: &HttpRequest, name: &str) -> Option<String> {
    let cookie = header_value(request, "cookie")?;
    for part in cookie.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if key.trim() == name {
            return Some(percent_decode(value.trim()));
        }
    }
    None
}

fn query_value(path: &str, key: &str) -> Option<String> {
    let params = parse_query(path);
    params.get(key).cloned()
}

pub fn respond_empty(stream: &mut TcpStream, status: u16) -> std::io::Result<()> {
    respond_bytes(stream, status, "text/plain", &[])
}

pub fn respond_file(
    stream: &mut TcpStream,
    path: &Path,
    content_type: &str,
) -> std::io::Result<()> {
    match fs::read(path) {
        Ok(bytes) => respond_bytes(stream, 200, content_type, &bytes),
        Err(_) => respond_text(stream, 404, "not found\n"),
    }
}

pub fn respond_json<T: Serialize>(
    stream: &mut TcpStream,
    status: u16,
    value: &T,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    respond_bytes(stream, status, "application/json", &body)
}

pub fn respond_json_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> std::io::Result<()> {
    respond_json(stream, status, &json!({ "error": message }))
}

pub fn read_ws_frame(stream: &mut TcpStream) -> std::io::Result<Option<WsFrame>> {
    let mut header = [0u8; 2];
    if let Err(err) = stream.read_exact(&mut header) {
        return if err.kind() == std::io::ErrorKind::UnexpectedEof {
            Ok(None)
        } else {
            Err(err)
        };
    }

    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut len = (header[1] & 0x7f) as u64;

    if len == 126 {
        let mut buf = [0u8; 2];
        stream.read_exact(&mut buf)?;
        len = u16::from_be_bytes(buf) as u64;
    } else if len == 127 {
        let mut buf = [0u8; 8];
        stream.read_exact(&mut buf)?;
        len = u64::from_be_bytes(buf);
    }

    if len > 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "websocket frame too large",
        ));
    }

    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }

    let mut payload = vec![0u8; len as usize];
    stream.read_exact(&mut payload)?;

    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }

    Ok(Some(WsFrame { opcode, payload }))
}

pub fn send_ws_text(stream: &mut TcpStream, payload: &[u8]) -> std::io::Result<()> {
    send_ws_frame(stream, 0x1, payload)
}

pub fn send_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut header = vec![0x80 | opcode];
    if payload.len() < 126 {
        header.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        header.push(126);
        header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    stream.write_all(payload)
}

pub fn parse_query(path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let Some((_, query)) = path.split_once('?') else {
        return params;
    };

    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(percent_decode(key), percent_decode(value));
    }

    params
}

pub fn websocket_accept_key(key: &str) -> String {
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(WS_GUID.as_bytes());
    base64_encode(&sha1(&input))
}

fn find_header_end(data: &[u8]) -> Option<usize> {
    data.windows(4).position(|window| window == b"\r\n\r\n")
}

fn respond_bytes(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let label = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n",
        status,
        label,
        content_type,
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    output.push(byte);
                    index += 3;
                } else {
                    output.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&output).to_string()
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    let mut index = 0;

    while index < bytes.len() {
        let b0 = bytes[index];
        let b1 = *bytes.get(index + 1).unwrap_or(&0);
        let b2 = *bytes.get(index + 2).unwrap_or(&0);
        let triple = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;

        output.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
        if index + 2 < bytes.len() {
            output.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }

        index += 3;
    }

    output
}

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xefcdab89;
    let mut h2: u32 = 0x98badcfe;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xc3d2e1f0;

    let bit_len = (data.len() as u64) * 8;
    let mut message = data.to_vec();
    message.push(0x80);
    while (message.len() % 64) != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 80];
        for index in 0..16 {
            let start = index * 4;
            w[index] = u32::from_be_bytes([
                chunk[start],
                chunk[start + 1],
                chunk[start + 2],
                chunk[start + 3],
            ]);
        }
        for index in 16..80 {
            w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for index in 0..80 {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(w[index]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut digest = [0u8; 20];
    digest[..4].copy_from_slice(&h0.to_be_bytes());
    digest[4..8].copy_from_slice(&h1.to_be_bytes());
    digest[8..12].copy_from_slice(&h2.to_be_bytes());
    digest[12..16].copy_from_slice(&h3.to_be_bytes());
    digest[16..20].copy_from_slice(&h4.to_be_bytes());
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, origin: Option<&str>) -> HttpRequest {
        let mut headers = HashMap::new();
        if let Some(origin) = origin {
            headers.insert("origin".to_string(), origin.to_string());
        }
        HttpRequest {
            method: "GET".to_string(),
            path: path.to_string(),
            headers,
            body: Vec::new(),
            is_websocket: false,
        }
    }

    #[test]
    fn protected_routes_require_runtime_token() {
        let config = ServerConfig {
            origin: "http://127.0.0.1:49152".to_string(),
            token: "secret".to_string(),
            allowed_origin: None,
        };

        assert!(!is_authorized_request(
            &request("/api/tmux/state?panelId=p1", None),
            "/api/tmux/state",
            &config
        ));
        assert!(is_authorized_request(
            &request("/api/tmux/state?panelId=p1&atToken=secret", None),
            "/api/tmux/state",
            &config
        ));
    }

    #[test]
    fn protected_routes_reject_unexpected_origins() {
        let config = ServerConfig {
            origin: "http://127.0.0.1:49152".to_string(),
            token: "secret".to_string(),
            allowed_origin: None,
        };

        assert!(!is_authorized_request(
            &request(
                "/api/tmux/state?panelId=p1&atToken=secret",
                Some("https://example.invalid")
            ),
            "/api/tmux/state",
            &config
        ));
    }
}
