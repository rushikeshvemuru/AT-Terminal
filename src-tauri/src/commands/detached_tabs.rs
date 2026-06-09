use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedWindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClaimResult {
    pub status: String,
    pub owner_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedTabWindowPayload {
    pub session_id: String,
    pub tab_id: String,
    pub owner_label: String,
    pub window_label: String,
}

#[derive(Debug, Clone)]
struct DetachedTabRuntime {
    session_id: String,
    tab_id: String,
    owner_label: String,
    window_label: String,
}

#[derive(Default)]
struct SessionWindowState {
    owners: HashMap<String, String>,
    detached_by_key: HashMap<String, DetachedTabRuntime>,
    detached_by_label: HashMap<String, String>,
}

#[derive(Clone, Default)]
pub struct SessionWindowManager {
    state: Arc<Mutex<SessionWindowState>>,
}

impl SessionWindowManager {
    pub fn remove_window_label(&self, label: &str) {
        let mut state = self
            .state
            .lock()
            .expect("session window state lock poisoned");

        state.owners.retain(|_, owner_label| owner_label != label);

        let Some(detached_key) = state.detached_by_label.remove(label) else {
            return;
        };
        state.detached_by_key.remove(&detached_key);
    }
}

#[tauri::command]
pub fn claim_session_window(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
) -> Result<SessionClaimResult, String> {
    let current_label = window.label().to_string();
    let mut state = manager
        .state
        .lock()
        .expect("session window state lock poisoned");

    if let Some(existing_label) = state.owners.get(&session_id).cloned() {
        if existing_label != current_label {
            if let Some(existing) = app.get_webview_window(&existing_label) {
                let _ = existing.set_focus();
                return Ok(SessionClaimResult {
                    status: "focusedExisting".to_string(),
                    owner_label: existing_label,
                });
            }
        }
    }

    state.owners.insert(session_id, current_label.clone());
    Ok(SessionClaimResult {
        status: "claimed".to_string(),
        owner_label: current_label,
    })
}

#[tauri::command]
pub fn release_session_window(
    window: WebviewWindow,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
) -> Result<(), String> {
    let current_label = window.label().to_string();
    let mut state = manager
        .state
        .lock()
        .expect("session window state lock poisoned");

    if state.owners.get(&session_id) == Some(&current_label) {
        state.owners.remove(&session_id);
    }

    Ok(())
}

#[tauri::command]
pub fn focus_session_owner(
    app: AppHandle,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
) -> Result<(), String> {
    let owner_label = {
        let state = manager
            .state
            .lock()
            .expect("session window state lock poisoned");
        state.owners.get(&session_id).cloned()
    }
    .ok_or_else(|| "Session owner window not found".to_string())?;

    let owner = app
        .get_webview_window(&owner_label)
        .ok_or_else(|| "Session owner window not found".to_string())?;
    owner.set_focus().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn open_detached_tab_window(
    app: AppHandle,
    window: WebviewWindow,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
    tab_id: String,
    tab_name: String,
    bounds: Option<DetachedWindowBounds>,
) -> Result<DetachedTabWindowPayload, String> {
    let owner_label = window.label().to_string();
    let window_label = detached_tab_label(&session_id, &tab_id);
    let key = detached_tab_key(&session_id, &tab_id);

    if let Some(existing) = app.get_webview_window(&window_label) {
        let _ = existing.set_focus();
        return Ok(DetachedTabWindowPayload {
            session_id,
            tab_id,
            owner_label,
            window_label,
        });
    }

    let runtime = DetachedTabRuntime {
        session_id: session_id.clone(),
        tab_id: tab_id.clone(),
        owner_label: owner_label.clone(),
        window_label: window_label.clone(),
    };

    {
        let mut state = manager
            .state
            .lock()
            .expect("session window state lock poisoned");
        state.detached_by_key.insert(key.clone(), runtime);
        state.detached_by_label.insert(window_label.clone(), key);
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        window_label.clone(),
        WebviewUrl::App("index.html#detachedTab".into()),
    )
    .title(format!("{} - AT-Terminal", tab_name))
    .decorations(false)
    .inner_size(
        bounds.as_ref().map(|entry| entry.width).unwrap_or(900.0),
        bounds.as_ref().map(|entry| entry.height).unwrap_or(650.0),
    );

    if let Some(bounds) = bounds {
        builder = builder.position(bounds.x, bounds.y);
    } else {
        builder = builder.center();
    }

    builder.build().map_err(|err| err.to_string())?;

    Ok(DetachedTabWindowPayload {
        session_id,
        tab_id,
        owner_label,
        window_label,
    })
}

#[tauri::command]
pub fn focus_detached_tab_window(
    app: AppHandle,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&detached_tab_label(&session_id, &tab_id))
        .ok_or_else(|| "Detached tab window not found".to_string())?;
    window.set_focus().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_detached_tab_window(
    app: AppHandle,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
    tab_id: String,
) -> Result<(), String> {
    let label = detached_tab_label(&session_id, &tab_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|err| err.to_string())?;
    }
    manager.remove_window_label(&label);
    Ok(())
}

#[tauri::command]
pub fn close_detached_tab_windows_for_session(
    app: AppHandle,
    manager: tauri::State<'_, SessionWindowManager>,
    session_id: String,
) -> Result<(), String> {
    let labels = {
        let state = manager
            .state
            .lock()
            .expect("session window state lock poisoned");
        state
            .detached_by_key
            .values()
            .filter(|entry| entry.session_id == session_id)
            .map(|entry| entry.window_label.clone())
            .collect::<Vec<_>>()
    };

    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
        manager.remove_window_label(&label);
    }

    Ok(())
}

#[tauri::command]
pub fn get_detached_tab_window_payload(
    window: WebviewWindow,
    manager: tauri::State<'_, SessionWindowManager>,
) -> Result<DetachedTabWindowPayload, String> {
    let label = window.label().to_string();
    let state = manager
        .state
        .lock()
        .expect("session window state lock poisoned");
    let key = state
        .detached_by_label
        .get(&label)
        .ok_or_else(|| "Detached tab payload not found".to_string())?;
    let runtime = state
        .detached_by_key
        .get(key)
        .ok_or_else(|| "Detached tab payload not found".to_string())?;

    Ok(DetachedTabWindowPayload {
        session_id: runtime.session_id.clone(),
        tab_id: runtime.tab_id.clone(),
        owner_label: runtime.owner_label.clone(),
        window_label: runtime.window_label.clone(),
    })
}

#[tauri::command]
pub fn update_detached_tab_bounds(
    _manager: tauri::State<'_, SessionWindowManager>,
    _session_id: String,
    _tab_id: String,
    _bounds: DetachedWindowBounds,
) -> Result<(), String> {
    Ok(())
}

fn detached_tab_key(session_id: &str, tab_id: &str) -> String {
    format!("{}::{}", session_id, tab_id)
}

fn detached_tab_label(session_id: &str, tab_id: &str) -> String {
    let suffix = format!("{}-{}", session_id, tab_id)
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("detached-tab-{}", suffix)
}
