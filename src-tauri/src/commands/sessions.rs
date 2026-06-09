use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use home::home_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

use crate::commands::filesystem::run_fs_task;
use crate::commands::ApprovedRoots;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PanelMetadata {
    pub id: String,
    pub name: String,
    #[serde(default = "default_panel_type")]
    pub panel_type: String,
    #[serde(default)]
    pub panel_state: Option<serde_json::Value>,
    #[serde(default)]
    pub preview: bool,
    #[serde(default)]
    pub hidden: bool,
}

fn default_panel_type() -> String {
    "base.empty".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DetachedWindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TabMetadata {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub root_directory: String,
    #[serde(default)]
    pub panels: Vec<PanelMetadata>,
    #[serde(default)]
    pub active_panel_id: Option<String>,
    #[serde(default)]
    pub detached: bool,
    #[serde(default)]
    pub detached_window_bounds: Option<DetachedWindowBounds>,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TabState {
    pub tabs: Vec<TabMetadata>,
    pub active_tab_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionMetadata {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub last_accessed: DateTime<Utc>,
    pub session_content: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub tab_state: Option<TabState>,
}

fn default_schema_version() -> u32 {
    1
}

fn validate_session_id(id: &str) -> Result<()> {
    if id.trim().is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(anyhow!("Invalid session id"));
    }
    Ok(())
}

fn get_sessions_dir() -> Result<PathBuf> {
    let home = home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    let sessions_dir = home.join(".atterm").join("sessions");
    if !sessions_dir.exists() {
        fs::create_dir_all(&sessions_dir)?;
    }
    Ok(sessions_dir)
}

#[tauri::command]
pub async fn list_sessions(
    roots: State<'_, ApprovedRoots>,
) -> Result<Vec<SessionMetadata>, String> {
    let roots = roots.inner().clone();
    run_fs_task(move || list_sessions_impl(Some(&roots))).await
}

fn list_sessions_impl(roots: Option<&ApprovedRoots>) -> Result<Vec<SessionMetadata>, String> {
    let sessions_dir = get_sessions_dir().map_err(|e| e.to_string())?;
    let mut sessions = Vec::new();

    for entry in fs::read_dir(sessions_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if let Ok(meta) = serde_json::from_str::<SessionMetadata>(&content) {
                if let Some(roots) = roots {
                    approve_session_roots(roots, &meta);
                }
                sessions.push(meta);
            }
        }
    }

    // Sort by last accessed descending
    sessions.sort_by(|a, b| b.last_accessed.cmp(&a.last_accessed));

    Ok(sessions)
}

#[tauri::command]
pub async fn create_session(name: String) -> Result<SessionMetadata, String> {
    run_fs_task(move || create_session_impl(name)).await
}

fn create_session_impl(name: String) -> Result<SessionMetadata, String> {
    if name.trim().is_empty() {
        return Err("Session name cannot be empty".to_string());
    }
    if name.len() > 64 {
        return Err("Session name is too long (max 64 characters)".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Session name contains invalid characters".to_string());
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now();

    let metadata = SessionMetadata {
        id: id.clone(),
        name,
        created_at: now,
        last_accessed: now,
        session_content: String::new(),
        schema_version: default_schema_version(),
        tab_state: None,
    };

    let sessions_dir = get_sessions_dir().map_err(|e| e.to_string())?;
    let file_path = sessions_dir.join(format!("{}.json", id));

    write_session_metadata(&file_path, &metadata).map_err(|e| e.to_string())?;

    Ok(metadata)
}

#[tauri::command]
pub async fn open_session(
    roots: State<'_, ApprovedRoots>,
    id: String,
) -> Result<SessionMetadata, String> {
    let roots = roots.inner().clone();
    run_fs_task(move || open_session_impl(Some(&roots), id)).await
}

fn open_session_impl(roots: Option<&ApprovedRoots>, id: String) -> Result<SessionMetadata, String> {
    validate_session_id(&id).map_err(|e| e.to_string())?;
    let sessions_dir = get_sessions_dir().map_err(|e| e.to_string())?;
    let file_path = sessions_dir.join(format!("{}.json", id));

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut metadata =
        serde_json::from_str::<SessionMetadata>(&content).map_err(|e| e.to_string())?;

    metadata.last_accessed = Utc::now();
    write_session_metadata(&file_path, &metadata).map_err(|e| e.to_string())?;
    if let Some(roots) = roots {
        approve_session_roots(roots, &metadata);
    }

    Ok(metadata)
}

fn approve_session_roots(roots: &ApprovedRoots, metadata: &SessionMetadata) {
    let Some(tab_state) = metadata.tab_state.as_ref() else {
        return;
    };
    for tab in &tab_state.tabs {
        roots.approve_root_if_available(&tab.root_directory);
    }
}

#[tauri::command]
pub async fn save_tab_state(id: String, tab_state: TabState) -> Result<(), String> {
    run_fs_task(move || save_tab_state_impl(id, tab_state)).await
}

fn save_tab_state_impl(id: String, tab_state: TabState) -> Result<(), String> {
    validate_session_id(&id).map_err(|e| e.to_string())?;
    let sessions_dir = get_sessions_dir().map_err(|e| e.to_string())?;
    let file_path = sessions_dir.join(format!("{}.json", id));

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let mut metadata =
        serde_json::from_str::<SessionMetadata>(&content).map_err(|e| e.to_string())?;

    metadata.tab_state = Some(tab_state);

    write_session_metadata(&file_path, &metadata).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn delete_session(id: String) -> Result<(), String> {
    run_fs_task(move || delete_session_impl(id)).await
}

fn delete_session_impl(id: String) -> Result<(), String> {
    validate_session_id(&id).map_err(|e| e.to_string())?;
    let sessions_dir = get_sessions_dir().map_err(|e| e.to_string())?;
    let file_path = sessions_dir.join(format!("{}.json", id));

    if !file_path.exists() {
        return Err("Session not found".to_string());
    }

    let content = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let metadata = serde_json::from_str::<SessionMetadata>(&content).map_err(|e| e.to_string())?;

    let buffers_dir = get_buffers_dir().map_err(|e| e.to_string())?;
    if let Some(tab_state) = metadata.tab_state {
        for tab in tab_state.tabs {
            for panel in tab.panels {
                let Ok(buffer_path) = buffer_path(&buffers_dir, &panel.id) else {
                    continue;
                };
                if buffer_path.exists() {
                    fs::remove_file(buffer_path).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    fs::remove_file(&file_path).map_err(|e| e.to_string())?;

    let backup_path = file_path.with_extension("json.bak");
    if backup_path.exists() {
        fs::remove_file(backup_path).map_err(|e| e.to_string())?;
    }

    let tmp_path = file_path.with_extension("json.tmp");
    if tmp_path.exists() {
        fs::remove_file(tmp_path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn write_session_metadata(file_path: &PathBuf, metadata: &SessionMetadata) -> Result<()> {
    if file_path.exists() {
        let backup_path = file_path.with_extension("json.bak");
        let _ = fs::copy(file_path, backup_path);
    }

    let tmp_path = file_path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(metadata)?;
    fs::write(&tmp_path, json)?;
    fs::rename(tmp_path, file_path)?;
    Ok(())
}

fn get_buffers_dir() -> Result<PathBuf> {
    let home = home_dir().ok_or_else(|| anyhow!("Could not find home directory"))?;
    let buffers_dir = home.join(".atterm").join("buffers");
    if !buffers_dir.exists() {
        fs::create_dir_all(&buffers_dir)?;
    }
    Ok(buffers_dir)
}

fn validate_panel_id(panel_id: &str) -> Result<(), String> {
    if panel_id.is_empty() || panel_id.len() > 128 {
        return Err("Invalid panel id".to_string());
    }
    if !panel_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid panel id".to_string());
    }
    Ok(())
}

fn buffer_path(buffers_dir: &PathBuf, panel_id: &str) -> Result<PathBuf, String> {
    validate_panel_id(panel_id)?;
    Ok(buffers_dir.join(format!("{}.buf", panel_id)))
}

#[tauri::command]
pub async fn save_buffer(panel_id: String, data: String) -> Result<(), String> {
    run_fs_task(move || save_buffer_impl(panel_id, data)).await
}

fn save_buffer_impl(panel_id: String, data: String) -> Result<(), String> {
    let buffers_dir = get_buffers_dir().map_err(|e| e.to_string())?;
    let file_path = buffer_path(&buffers_dir, &panel_id)?;
    fs::write(file_path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_buffer(panel_id: String) -> Result<Option<String>, String> {
    run_fs_task(move || load_buffer_impl(panel_id)).await
}

fn load_buffer_impl(panel_id: String) -> Result<Option<String>, String> {
    let buffers_dir = get_buffers_dir().map_err(|e| e.to_string())?;
    let file_path = buffer_path(&buffers_dir, &panel_id)?;
    if !file_path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    Ok(Some(data))
}

#[tauri::command]
pub async fn delete_buffer(panel_id: String) -> Result<(), String> {
    run_fs_task(move || delete_buffer_impl(panel_id)).await
}

fn delete_buffer_impl(panel_id: String) -> Result<(), String> {
    let buffers_dir = get_buffers_dir().map_err(|e| e.to_string())?;
    let file_path = buffer_path(&buffers_dir, &panel_id)?;
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_id_rejects_path_traversal() {
        assert!(validate_panel_id("../secret").is_err());
        assert!(validate_panel_id("panel/secret").is_err());
        assert!(validate_panel_id("panel\\secret").is_err());
    }

    #[test]
    fn panel_id_accepts_generated_panel_ids() {
        assert!(validate_panel_id("panel-1710000000000-1").is_ok());
        assert!(validate_panel_id("panel_1710000000000_1").is_ok());
    }
}
