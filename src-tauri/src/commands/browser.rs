use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const BROWSER_PANEL_EVENT: &str = "browser-panel-state-changed";
const DEFAULT_BROWSER_URL: &str = "https://example.com";
const BROWSER_WINDOW_CLOSED_MESSAGE: &str = "Browser window closed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPanelStatePayload {
    pub panel_id: String,
    pub current_url: String,
    pub history: Vec<String>,
    pub title: String,
    pub is_loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
struct BrowserPanelRuntimeState {
    current_url: String,
    title: String,
    is_loading: bool,
    last_error: Option<String>,
    back_stack: Vec<String>,
    forward_stack: Vec<String>,
    pending_action: Option<PendingAction>,
    is_open: bool,
}

impl BrowserPanelRuntimeState {
    fn new(url: String) -> Self {
        Self {
            current_url: url,
            title: String::new(),
            is_loading: true,
            last_error: None,
            back_stack: Vec::new(),
            forward_stack: Vec::new(),
            pending_action: None,
            is_open: true,
        }
    }

    fn payload(&self, panel_id: &str) -> BrowserPanelStatePayload {
        let mut history = self.back_stack.clone();
        history.push(self.current_url.clone());

        let mut forward_history = self.forward_stack.clone();
        forward_history.reverse();
        history.extend(forward_history);

        BrowserPanelStatePayload {
            panel_id: panel_id.to_string(),
            current_url: self.current_url.clone(),
            history,
            title: self.title.clone(),
            is_loading: self.is_loading,
            can_go_back: !self.back_stack.is_empty(),
            can_go_forward: !self.forward_stack.is_empty(),
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PendingAction {
    Navigate,
    Back,
    Forward,
    Reload,
}

#[derive(Clone, Default)]
pub struct BrowserPanelManager {
    state: Arc<Mutex<HashMap<String, BrowserPanelRuntimeState>>>,
}

impl BrowserPanelManager {
    fn ensure(&self, panel_id: &str, url: String) -> BrowserPanelStatePayload {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state
            .entry(panel_id.to_string())
            .or_insert_with(|| BrowserPanelRuntimeState::new(url.clone()));
        if entry.current_url.trim().is_empty() {
            entry.current_url = url;
        }
        entry.is_open = true;
        entry.last_error = None;
        entry.payload(panel_id)
    }

    fn snapshot(&self, panel_id: &str) -> Option<BrowserPanelStatePayload> {
        let state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        state.get(panel_id).map(|entry| entry.payload(panel_id))
    }

    fn sync_existing_window(
        &self,
        panel_id: &str,
        current_url: String,
        title: String,
    ) -> BrowserPanelStatePayload {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state
            .entry(panel_id.to_string())
            .or_insert_with(|| BrowserPanelRuntimeState::new(current_url.clone()));
        entry.current_url = current_url;
        entry.title = title;
        entry.is_loading = false;
        entry.last_error = None;
        entry.pending_action = None;
        entry.is_open = true;
        entry.payload(panel_id)
    }

    fn set_error(
        &self,
        panel_id: &str,
        message: impl Into<String>,
    ) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        entry.last_error = Some(message.into());
        entry.is_loading = false;
        entry.pending_action = None;
        Some(entry.payload(panel_id))
    }

    fn prepare_navigation(
        &self,
        panel_id: &str,
        url: String,
        action: PendingAction,
    ) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        if !entry.is_open {
            entry.last_error = Some(BROWSER_WINDOW_CLOSED_MESSAGE.to_string());
            entry.is_loading = false;
            return Some(entry.payload(panel_id));
        }

        match action {
            PendingAction::Navigate => {
                if !entry.current_url.is_empty() && entry.current_url != url {
                    entry.back_stack.push(entry.current_url.clone());
                }
                entry.forward_stack.clear();
            }
            PendingAction::Back => {
                if !entry.current_url.is_empty() {
                    entry.forward_stack.push(entry.current_url.clone());
                }
            }
            PendingAction::Forward => {
                if !entry.current_url.is_empty() {
                    entry.back_stack.push(entry.current_url.clone());
                }
            }
            PendingAction::Reload => {}
        }

        entry.current_url = url;
        entry.is_loading = true;
        entry.is_open = true;
        entry.last_error = None;
        entry.pending_action = Some(action);
        Some(entry.payload(panel_id))
    }

    fn pop_back_target(&self, panel_id: &str) -> Option<String> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        if !entry.is_open {
            return None;
        }
        entry.back_stack.pop()
    }

    fn pop_forward_target(&self, panel_id: &str) -> Option<String> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        if !entry.is_open {
            return None;
        }
        entry.forward_stack.pop()
    }

    fn on_navigation(&self, panel_id: &str, url: String) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;

        if entry.pending_action.take().is_none()
            && !entry.current_url.is_empty()
            && entry.current_url != url
        {
            entry.back_stack.push(entry.current_url.clone());
            entry.forward_stack.clear();
        }

        entry.current_url = url;
        entry.is_loading = true;
        entry.is_open = true;
        entry.last_error = None;
        Some(entry.payload(panel_id))
    }

    fn on_page_load(
        &self,
        panel_id: &str,
        url: String,
        is_loading: bool,
    ) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        entry.current_url = url;
        entry.is_loading = is_loading;
        entry.is_open = true;
        if !is_loading {
            entry.last_error = None;
        }
        Some(entry.payload(panel_id))
    }

    fn on_title_change(&self, panel_id: &str, title: String) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        entry.title = title;
        entry.is_open = true;
        Some(entry.payload(panel_id))
    }

    fn clear_loading(&self, panel_id: &str) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        entry.is_loading = false;
        entry.pending_action = None;
        Some(entry.payload(panel_id))
    }

    fn mark_closed(&self, panel_id: &str) -> Option<BrowserPanelStatePayload> {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        let entry = state.get_mut(panel_id)?;
        entry.is_open = false;
        entry.is_loading = false;
        entry.pending_action = None;
        entry.last_error = Some(BROWSER_WINDOW_CLOSED_MESSAGE.to_string());
        Some(entry.payload(panel_id))
    }

    fn remove(&self, panel_id: &str) {
        let mut state = self
            .state
            .lock()
            .expect("browser panel state lock poisoned");
        state.remove(panel_id);
    }
}

#[tauri::command]
pub async fn open_browser_panel_window(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
    url: Option<String>,
) -> Result<BrowserPanelStatePayload, String> {
    let normalized_url = normalize_browser_url(url.as_deref().unwrap_or(DEFAULT_BROWSER_URL))?;
    let panel_label = browser_panel_label(&panel_id);

    if let Some(existing) = app.get_webview_window(&panel_label) {
        let current_url = existing
            .url()
            .map(|entry| entry.to_string())
            .unwrap_or_else(|_| normalized_url.to_string());
        let title = existing.title().unwrap_or_default();
        let payload = manager.sync_existing_window(&panel_id, current_url, title);
        let _ = existing.set_focus();
        emit_browser_panel_state(&app, payload.clone());
        return Ok(payload);
    }

    let initial_state = manager.ensure(&panel_id, normalized_url.to_string());
    let navigation_panel_id = panel_id.clone();
    let navigation_app = app.clone();
    let navigation_manager = manager.inner().clone();

    let page_load_panel_id = panel_id.clone();
    let page_load_app = app.clone();
    let page_load_manager = manager.inner().clone();

    let title_panel_id = panel_id.clone();
    let title_app = app.clone();
    let title_manager = manager.inner().clone();

    let destroy_panel_id = panel_id.clone();
    let destroy_app = app.clone();
    let destroy_manager = manager.inner().clone();

    let window = WebviewWindowBuilder::new(
        &app,
        panel_label,
        WebviewUrl::External(normalized_url.clone()),
    )
    .center()
    .inner_size(1200.0, 800.0)
    .on_navigation(move |url| {
        if !is_allowed_browser_url(url) {
            if let Some(payload) = navigation_manager.set_error(
                &navigation_panel_id,
                "Only http:// and https:// URLs are supported",
            ) {
                emit_browser_panel_state(&navigation_app, payload);
            }
            return false;
        }

        if let Some(payload) =
            navigation_manager.on_navigation(&navigation_panel_id, url.to_string())
        {
            emit_browser_panel_state(&navigation_app, payload);
        }
        true
    })
    .on_page_load(move |_window, payload| {
        let is_loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
        if let Some(state) = page_load_manager.on_page_load(
            &page_load_panel_id,
            payload.url().to_string(),
            is_loading,
        ) {
            emit_browser_panel_state(&page_load_app, state);
        }
    })
    .on_document_title_changed(move |window, title| {
        let _ = window.set_title(&title);
        if let Some(state) = title_manager.on_title_change(&title_panel_id, title) {
            emit_browser_panel_state(&title_app, state);
        }
    })
    .build()
    .map_err(|err| err.to_string())?;

    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Some(state) = destroy_manager.mark_closed(&destroy_panel_id) {
                emit_browser_panel_state(&destroy_app, state);
            }
        }
    });

    emit_browser_panel_state(&app, initial_state.clone());
    Ok(initial_state)
}

#[tauri::command]
pub fn navigate_browser_panel(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
    url: String,
) -> Result<BrowserPanelStatePayload, String> {
    let normalized_url = normalize_browser_url(&url)?;
    let window = get_browser_panel_window(&app, &panel_id)?;
    let payload = manager
        .prepare_navigation(
            &panel_id,
            normalized_url.to_string(),
            PendingAction::Navigate,
        )
        .ok_or_else(|| "Browser panel is not initialized".to_string())?;
    window
        .navigate(normalized_url)
        .map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    emit_browser_panel_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn browser_panel_go_back(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<BrowserPanelStatePayload, String> {
    let Some(target) = manager.pop_back_target(&panel_id) else {
        return manager
            .snapshot(&panel_id)
            .ok_or_else(|| "Browser panel is not initialized".to_string());
    };

    let url = normalize_browser_url(&target)?;
    let window = get_browser_panel_window(&app, &panel_id)?;
    let payload = manager
        .prepare_navigation(&panel_id, url.to_string(), PendingAction::Back)
        .ok_or_else(|| "Browser panel is not initialized".to_string())?;
    window.navigate(url).map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    emit_browser_panel_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn browser_panel_go_forward(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<BrowserPanelStatePayload, String> {
    let Some(target) = manager.pop_forward_target(&panel_id) else {
        return manager
            .snapshot(&panel_id)
            .ok_or_else(|| "Browser panel is not initialized".to_string());
    };

    let url = normalize_browser_url(&target)?;
    let window = get_browser_panel_window(&app, &panel_id)?;
    let payload = manager
        .prepare_navigation(&panel_id, url.to_string(), PendingAction::Forward)
        .ok_or_else(|| "Browser panel is not initialized".to_string())?;
    window.navigate(url).map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    emit_browser_panel_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn browser_panel_reload(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<BrowserPanelStatePayload, String> {
    let window = get_browser_panel_window(&app, &panel_id)?;
    let current_url = window.url().map_err(|err| err.to_string())?;
    let payload = manager
        .prepare_navigation(&panel_id, current_url.to_string(), PendingAction::Reload)
        .ok_or_else(|| "Browser panel is not initialized".to_string())?;
    window.reload().map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    emit_browser_panel_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn browser_panel_stop(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<BrowserPanelStatePayload, String> {
    let window = get_browser_panel_window(&app, &panel_id)?;
    window
        .eval("window.stop();")
        .map_err(|err| err.to_string())?;
    let payload = manager
        .clear_loading(&panel_id)
        .ok_or_else(|| "Browser panel is not initialized".to_string())?;
    emit_browser_panel_state(&app, payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn focus_browser_panel_window(app: AppHandle, panel_id: String) -> Result<(), String> {
    let window = get_browser_panel_window(&app, &panel_id)?;
    window.set_focus().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_browser_panel_window(
    app: AppHandle,
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&browser_panel_label(&panel_id)) {
        window.close().map_err(|err| err.to_string())?;
    }
    manager.remove(&panel_id);
    Ok(())
}

#[tauri::command]
pub fn get_browser_panel_state(
    manager: State<'_, BrowserPanelManager>,
    panel_id: String,
) -> Result<BrowserPanelStatePayload, String> {
    manager
        .snapshot(&panel_id)
        .ok_or_else(|| "Browser panel is not initialized".to_string())
}

fn get_browser_panel_window(app: &AppHandle, panel_id: &str) -> Result<WebviewWindow, String> {
    app.get_webview_window(&browser_panel_label(panel_id))
        .ok_or_else(|| "Browser panel window not found".to_string())
}

fn browser_panel_label(panel_id: &str) -> String {
    let suffix = panel_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    format!("browser-panel-{}", suffix)
}

fn emit_browser_panel_state(app: &AppHandle, payload: BrowserPanelStatePayload) {
    let _ = app.emit(BROWSER_PANEL_EVENT, payload);
}

fn is_allowed_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn normalize_browser_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty".to_string());
    }

    let parsed = Url::parse(trimmed).or_else(|_| Url::parse(&format!("https://{}", trimmed)));
    let url = parsed.map_err(|_| format!("Invalid URL: {}", trimmed))?;
    if !is_allowed_browser_url(&url) {
        return Err("Only http:// and https:// URLs are supported".to_string());
    }
    Ok(url)
}
