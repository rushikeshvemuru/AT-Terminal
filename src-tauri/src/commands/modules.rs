use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_RESTART_DELAY_SECS: u64 = 30;
const BASE_MODULE_NAME: &str = "base";
const BASE_MODULE_DEFAULT_PORT: u16 = 47831;
const BASE_MODULE_TOKEN_QUERY: &str = "atToken";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleMetadata {
    pub module_name: String,
    pub panel_types: Vec<String>,
    #[serde(default)]
    pub panel_display_names: HashMap<String, String>,
    #[serde(default)]
    pub panel_colors: HashMap<String, String>,
    #[serde(default)]
    pub panel_tool_bar: HashMap<String, ModulePanelToolbar>,
    #[serde(default)]
    pub startup_script_location: String,
    #[serde(default)]
    pub startup_script_command: String,
    #[serde(default)]
    pub panel_url_template: String,
    #[serde(default)]
    pub healthcheck_url: String,
    #[serde(default)]
    pub validation_urls: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModulePanelToolbar {
    #[serde(default)]
    pub items: Vec<ModulePanelToolbarItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModulePanelToolbarItem {
    pub id: String,
    #[serde(default = "default_panel_toolbar_kind")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub icon_path: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub tooltip: String,
    #[serde(default)]
    pub command: String,
    #[serde(default = "default_panel_toolbar_visible")]
    pub visible: bool,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default)]
    pub checked: bool,
    #[serde(default)]
    pub options: Vec<ModulePanelToolbarOption>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub show_value: bool,
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub indeterminate: bool,
    #[serde(default)]
    pub items: Vec<ModulePanelToolbarActionItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModulePanelToolbarOption {
    pub value: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModulePanelToolbarActionItem {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub icon_path: String,
    #[serde(default)]
    pub tooltip: String,
    #[serde(default)]
    pub command: String,
    #[serde(default = "default_panel_toolbar_visible")]
    pub visible: bool,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleConfig {
    pub active_modules: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePanelToolbar {
    pub items: Vec<RuntimePanelToolbarItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePanelToolbarItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub icon_path: String,
    pub color: String,
    pub tooltip: String,
    pub command: String,
    pub visible: bool,
    pub disabled: bool,
    pub value: Value,
    pub placeholder: String,
    pub checked: bool,
    pub options: Vec<RuntimePanelToolbarOption>,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub show_value: bool,
    pub tone: String,
    pub progress: f64,
    pub indeterminate: bool,
    pub items: Vec<RuntimePanelToolbarActionItem>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePanelToolbarOption {
    pub value: String,
    pub label: String,
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePanelToolbarActionItem {
    pub id: String,
    pub text: String,
    pub icon_path: String,
    pub tooltip: String,
    pub command: String,
    pub visible: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePanelType {
    pub r#type: String,
    pub local_type: String,
    pub module_name: String,
    pub display_name: String,
    pub color: String,
    pub panel_url_template: String,
    pub healthcheck_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel_toolbar: Option<RuntimePanelToolbar>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModule {
    pub module_name: String,
    pub module_dir: String,
    pub panel_types: Vec<RuntimePanelType>,
    pub healthcheck_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_port: Option<u16>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRegistrySnapshot {
    pub modules: Vec<RuntimeModule>,
    pub panel_types: Vec<RuntimePanelType>,
}

#[derive(Default)]
struct ModuleManagerState {
    initialized: bool,
    registry: ModuleRegistrySnapshot,
    base_runtime: Option<BaseModuleRuntime>,
    resource_dir: Option<PathBuf>,
}

/// Registry of per-module supervisor cancellation tokens. Owned by
/// `ModuleManager` so the Tauri app can cancel all supervisors on `RunEvent::Exit`.
#[derive(Default, Clone)]
pub struct ModuleSupervisors {
    inner: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl ModuleSupervisors {
    /// Insert (or replace) the cancellation token for `module_name`.
    pub fn register(&self, module_name: String, token: CancellationToken) {
        let mut map = self.inner.lock().expect("module supervisors lock poisoned");
        map.insert(module_name, token);
    }

    /// Remove the token for `module_name`. Idempotent.
    pub fn unregister(&self, module_name: &str) {
        let mut map = self.inner.lock().expect("module supervisors lock poisoned");
        map.remove(module_name);
    }

    /// Cancel every supervisor; intended for app shutdown.
    pub fn cancel_all(&self) {
        let map = self.inner.lock().expect("module supervisors lock poisoned");
        for token in map.values() {
            token.cancel();
        }
    }
}

#[derive(Debug, Clone)]
struct BaseModuleRuntime {
    port: u16,
    token: String,
    origin: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleDiagnostics {
    pub module_name: String,
    pub healthcheck_url: String,
    pub healthy: bool,
    pub runtime_port: Option<u16>,
    pub panel_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDiagnostics {
    pub modules: Vec<ModuleDiagnostics>,
}

#[derive(Clone, Default)]
pub struct ModuleManager {
    state: Arc<Mutex<ModuleManagerState>>,
    init_lock: Arc<TokioMutex<()>>,
}

impl ModuleManager {
    pub fn with_resource_dir(resource_dir: Option<PathBuf>) -> Self {
        let manager = Self::default();
        if let Ok(mut state) = manager.state.lock() {
            state.resource_dir = resource_dir;
        }
        manager
    }

    pub fn initialize_modules_at_startup(&self, supervisors: ModuleSupervisors) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = manager.initialize_async(supervisors).await {
                eprintln!("Failed to initialize modules: {}", err);
            }
        });
    }

    async fn initialize_async(&self, supervisors: ModuleSupervisors) -> Result<(), String> {
        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Module manager lock poisoned")?;
            if state.initialized {
                return Ok(());
            }
        }

        let _init_guard = self.init_lock.lock().await;
        {
            let state = self
                .state
                .lock()
                .map_err(|_| "Module manager lock poisoned")?;
            if state.initialized {
                return Ok(());
            }
        }

        let base_runtime = self.base_runtime()?;
        let resource_dir = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Module manager lock poisoned")?;
            state.resource_dir.clone()
        };
        let modules_dir = find_modules_dir(resource_dir.as_deref())
            .ok_or_else(|| "Could not find AT-modules directory".to_string())?;
        let project_root = modules_dir
            .parent()
            .ok_or_else(|| "Could not resolve project root from AT-modules".to_string())?
            .to_path_buf();
        let config = load_module_config_from(&modules_dir)?;
        let mut modules = Vec::new();
        let mut panel_types = Vec::new();

        for module_name in &config.active_modules {
            let module_dir = modules_dir.join(module_name);
            match load_module_metadata_from(&modules_dir, module_name) {
                Ok(mut metadata) => {
                    let runtime = if module_name == BASE_MODULE_NAME {
                        Some(base_runtime.clone())
                    } else {
                        None
                    };
                    if let Some(runtime) = runtime.as_ref() {
                        apply_base_runtime_to_metadata(&mut metadata, runtime);
                    }

                    let runtime_panels = metadata
                        .panel_types
                        .iter()
                        .map(|panel_type| {
                            let namespaced_type =
                                format!("{}.{}", metadata.module_name, panel_type);
                            RuntimePanelType {
                                r#type: namespaced_type,
                                local_type: panel_type.clone(),
                                module_name: metadata.module_name.clone(),
                                display_name: panel_display_name_for_type(&metadata, panel_type),
                                color: panel_color_for_type(&metadata, panel_type),
                                panel_url_template: metadata.panel_url_template.clone(),
                                healthcheck_url: metadata.healthcheck_url.clone(),
                                auth_token: runtime.as_ref().map(|entry| entry.token.clone()),
                                panel_toolbar: build_runtime_panel_toolbar(
                                    module_name,
                                    panel_type,
                                    &metadata.panel_tool_bar,
                                ),
                            }
                        })
                        .collect::<Vec<_>>();

                    panel_types.extend(runtime_panels.clone());
                    let healthcheck_url = metadata.healthcheck_url.clone();
                    let supervisors_for_task = supervisors.clone();
                    let module_name_owned = module_name.clone();
                    let module_dir_owned = module_dir.clone();
                    let metadata_owned = metadata.clone();
                    let runtime_owned = runtime.clone();
                    tauri::async_runtime::spawn(async move {
                        spawn_module_supervisor(
                            supervisors_for_task,
                            module_name_owned,
                            module_dir_owned,
                            metadata_owned,
                            runtime_owned,
                        )
                        .await;
                    });
                    modules.push(RuntimeModule {
                        module_name: module_name.clone(),
                        module_dir: module_dir.to_string_lossy().to_string(),
                        panel_types: runtime_panels,
                        healthcheck_url,
                        runtime_port: runtime.as_ref().map(|entry| entry.port),
                    });
                }
                Err(err) => {
                    eprintln!(
                        "[modules] Warning: failed to load metadata for module '{}': {}",
                        module_name, err
                    );
                }
            }
        }

        if let Err(err) = write_panel_types(&project_root, &panel_types) {
            eprintln!("[modules] Warning: {}", err);
        }

        let registry = ModuleRegistrySnapshot {
            modules,
            panel_types,
        };

        let mut state = self
            .state
            .lock()
            .map_err(|_| "Module manager lock poisoned")?;
        state.registry = registry;
        state.initialized = true;
        Ok(())
    }

    fn base_runtime(&self) -> Result<BaseModuleRuntime, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Module manager lock poisoned")?;
        if let Some(runtime) = state.base_runtime.clone() {
            return Ok(runtime);
        }

        let port = reserve_localhost_port().unwrap_or(BASE_MODULE_DEFAULT_PORT);
        let token = Uuid::new_v4().to_string();
        let runtime = BaseModuleRuntime {
            port,
            token,
            origin: format!("http://127.0.0.1:{}", port),
        };
        state.base_runtime = Some(runtime.clone());
        Ok(runtime)
    }

    async fn registry(
        &self,
        supervisors: &ModuleSupervisors,
    ) -> Result<ModuleRegistrySnapshot, String> {
        self.initialize_async(supervisors.clone()).await?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Module manager lock poisoned")?;
        Ok(state.registry.clone())
    }

    async fn diagnostics(&self, supervisors: &ModuleSupervisors) -> Result<AppDiagnostics, String> {
        self.initialize_async(supervisors.clone()).await?;
        let registry_modules = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Module manager lock poisoned")?;
            state.registry.modules.clone()
        };

        let mut modules = Vec::with_capacity(registry_modules.len());
        for module in registry_modules {
            modules.push(ModuleDiagnostics {
                module_name: module.module_name,
                healthcheck_url: module.healthcheck_url.clone(),
                healthy: is_module_healthy_async(&module.healthcheck_url, &[]).await,
                runtime_port: module.runtime_port,
                panel_count: module.panel_types.len(),
            });
        }

        Ok(AppDiagnostics { modules })
    }
}

fn reserve_localhost_port() -> Option<u16> {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|addr| addr.port())
}

fn find_modules_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = find_modules_dir_from_cwd() {
        return Some(dir);
    }

    #[cfg(debug_assertions)]
    if let Some(dir) = find_modules_dir_from_manifest_dir() {
        return Some(dir);
    }

    if let Some(resource_dir) = resource_dir {
        let dir = resource_dir.join("AT-modules");
        if dir.join("module_config.json").exists() {
            return Some(dir);
        }
    }

    #[cfg(not(debug_assertions))]
    if let Some(dir) = find_modules_dir_from_cwd() {
        return Some(dir);
    }

    None
}

#[cfg(debug_assertions)]
fn find_modules_dir_from_manifest_dir() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?;
    let modules = repo_root.join("AT-modules");
    if modules.join("module_config.json").exists() {
        Some(modules)
    } else {
        None
    }
}

fn find_modules_dir_from_cwd() -> Option<PathBuf> {
    if let Ok(cwd) = std::env::current_dir() {
        let dir = cwd.join("AT-modules");
        if dir.join("module_config.json").exists() {
            return Some(dir);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd;
        for _ in 0..5 {
            if let Some(parent) = dir.parent() {
                dir = parent.to_path_buf();
                let modules = dir.join("AT-modules");
                if modules.join("module_config.json").exists() {
                    return Some(modules);
                }
            } else {
                break;
            }
        }
    }

    None
}

fn load_module_config_from(modules_dir: &PathBuf) -> Result<ModuleConfig, String> {
    let config_path = modules_dir.join("module_config.json");
    let content = fs::read_to_string(&config_path)
        .map_err(|err| format!("Failed to read module config: {}", err))?;
    serde_json::from_str(&content).map_err(|err| format!("Failed to parse module config: {}", err))
}

fn load_module_metadata_from(
    modules_dir: &PathBuf,
    module_name: &str,
) -> Result<ModuleMetadata, String> {
    let metadata_path = modules_dir.join(module_name).join("metadata.json");
    let legacy_path = modules_dir.join(module_name).join("meta-data.json");
    let path = if metadata_path.exists() {
        metadata_path
    } else if legacy_path.exists() {
        legacy_path
    } else {
        return Err(format!(
            "Metadata file not found for module: {}",
            module_name
        ));
    };

    let content = fs::read_to_string(&path).map_err(|err| {
        format!(
            "Failed to read metadata for module {}: {}",
            module_name, err
        )
    })?;
    serde_json::from_str(&content).map_err(|err| {
        format!(
            "Failed to parse metadata for module {}: {}",
            module_name, err
        )
    })
}

fn write_panel_types(
    project_root: &PathBuf,
    panel_types: &[RuntimePanelType],
) -> Result<(), String> {
    let output_path = project_root.join("src").join("panel_types.json");
    let names = panel_types
        .iter()
        .map(|entry| entry.r#type.clone())
        .collect::<Vec<_>>();
    let json = serde_json::to_string_pretty(&names)
        .map_err(|err| format!("Failed to serialize panel types: {}", err))?;
    let next_content = format!("{}\n", json);
    if fs::read_to_string(&output_path).ok().as_deref() == Some(next_content.as_str()) {
        return Ok(());
    }

    fs::write(&output_path, next_content)
        .map_err(|err| format!("Failed to write {}: {}", output_path.display(), err))
}

fn display_name(panel_type: &str) -> String {
    if panel_type.eq_ignore_ascii_case("browser")
        || panel_type.eq_ignore_ascii_case("browser_preview")
    {
        return "Browser Preview".to_string();
    }

    let mut chars = panel_type.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Panel".to_string(),
    }
}

fn panel_display_name_for_type(metadata: &ModuleMetadata, panel_type: &str) -> String {
    metadata
        .panel_display_names
        .get(panel_type)
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| display_name(panel_type))
}

fn panel_color_for_type(metadata: &ModuleMetadata, panel_type: &str) -> String {
    metadata
        .panel_colors
        .get(panel_type)
        .map(|color| color.trim())
        .filter(|color| !color.is_empty())
        .unwrap_or("#ffffff")
        .to_string()
}

fn default_panel_toolbar_visible() -> bool {
    true
}

fn default_panel_toolbar_kind() -> String {
    "button".to_string()
}

fn normalize_panel_toolbar_kind(kind: &str) -> String {
    match kind.trim() {
        "" => "button".to_string(),
        "button" | "select" | "text" | "toggle" | "number" | "slider" | "segmented" | "menu"
        | "buttonGroup" | "status" | "progress" | "separator" | "label" | "spacer" => {
            kind.trim().to_string()
        }
        _ => "button".to_string(),
    }
}

fn normalize_toolbar_value(kind: &str, value: &Value) -> Value {
    match kind {
        "number" | "slider" => Value::from(number_from_value(value).unwrap_or(0.0)),
        "select" | "text" | "segmented" => Value::from(string_from_value(value)),
        _ => value.clone(),
    }
}

fn number_from_value(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        value
            .as_str()
            .and_then(|entry| entry.trim().parse::<f64>().ok())
            .filter(|entry| entry.is_finite())
    })
}

fn string_from_value(value: &Value) -> String {
    if let Some(entry) = value.as_str() {
        return entry.to_string();
    }

    if let Some(entry) = value.as_f64() {
        return entry.to_string();
    }

    String::new()
}

fn numeric_field(value: Option<f64>, fallback: f64) -> f64 {
    value.filter(|entry| entry.is_finite()).unwrap_or(fallback)
}

fn default_toolbar_max(kind: &str) -> f64 {
    match kind {
        "slider" | "progress" => 100.0,
        _ => 0.0,
    }
}

fn normalize_progress(value: Option<f64>) -> f64 {
    numeric_field(value, 0.0).clamp(0.0, 100.0)
}

fn build_runtime_panel_toolbar(
    module_name: &str,
    local_panel_type: &str,
    toolbar_map: &HashMap<String, ModulePanelToolbar>,
) -> Option<RuntimePanelToolbar> {
    let toolbar = toolbar_map.get(local_panel_type)?;
    let mut seen_ids = HashSet::new();
    let mut items = Vec::new();

    for item in &toolbar.items {
        let item_id = item.id.trim();
        if item_id.is_empty() {
            eprintln!(
                "[modules] Warning: ignoring panel toolbar item with empty id for module '{}' panel '{}'",
                module_name, local_panel_type
            );
            continue;
        }

        if !seen_ids.insert(item_id.to_string()) {
            eprintln!(
                "[modules] Warning: ignoring duplicate panel toolbar item id '{}' for module '{}' panel '{}'",
                item_id, module_name, local_panel_type
            );
            continue;
        }

        let kind = normalize_panel_toolbar_kind(&item.kind);

        items.push(RuntimePanelToolbarItem {
            id: item_id.to_string(),
            kind: kind.clone(),
            text: item.text.clone(),
            icon_path: item.icon_path.clone(),
            color: item.color.clone(),
            tooltip: item.tooltip.clone(),
            command: item.command.clone(),
            visible: item.visible,
            disabled: item.disabled,
            value: normalize_toolbar_value(&kind, &item.value),
            placeholder: item.placeholder.clone(),
            checked: item.checked,
            options: build_runtime_toolbar_options(&item.options),
            min: numeric_field(item.min, 0.0),
            max: numeric_field(item.max, default_toolbar_max(&kind)),
            step: numeric_field(item.step, 1.0),
            show_value: item.show_value,
            tone: item.tone.clone(),
            progress: normalize_progress(item.progress),
            indeterminate: item.indeterminate,
            items: build_runtime_toolbar_actions(&item.items),
        });
    }

    if items.is_empty() {
        None
    } else {
        Some(RuntimePanelToolbar { items })
    }
}

fn build_runtime_toolbar_options(
    options: &[ModulePanelToolbarOption],
) -> Vec<RuntimePanelToolbarOption> {
    let mut seen_values = HashSet::new();

    options
        .iter()
        .filter_map(|option| {
            let value = option.value.trim();
            if value.is_empty() || !seen_values.insert(value.to_string()) {
                return None;
            }

            Some(RuntimePanelToolbarOption {
                value: value.to_string(),
                label: if option.label.trim().is_empty() {
                    value.to_string()
                } else {
                    option.label.clone()
                },
                disabled: option.disabled,
            })
        })
        .collect()
}

fn build_runtime_toolbar_actions(
    actions: &[ModulePanelToolbarActionItem],
) -> Vec<RuntimePanelToolbarActionItem> {
    let mut seen_ids = HashSet::new();

    actions
        .iter()
        .filter_map(|action| {
            let id = action.id.trim();
            if id.is_empty() || !seen_ids.insert(id.to_string()) {
                return None;
            }

            Some(RuntimePanelToolbarActionItem {
                id: id.to_string(),
                text: action.text.clone(),
                icon_path: action.icon_path.clone(),
                tooltip: action.tooltip.clone(),
                command: action.command.clone(),
                visible: action.visible,
                disabled: action.disabled,
            })
        })
        .collect()
}

async fn spawn_module_supervisor(
    supervisors: ModuleSupervisors,
    module_name: String,
    module_dir: PathBuf,
    metadata: ModuleMetadata,
    runtime: Option<BaseModuleRuntime>,
) {
    let command = metadata.startup_script_command.trim().to_string();
    let healthcheck_url = metadata.healthcheck_url.trim().to_string();
    let validation_urls = collect_module_validation_urls(&metadata);
    let runtime_env = runtime_env(runtime.as_ref());
    if command.is_empty() {
        return;
    }

    let cancel = CancellationToken::new();
    supervisors.register(module_name.clone(), cancel.clone());

    let mut restart_attempt: u32 = 0;
    let mut health_ticker = tokio::time::interval(Duration::from_secs(2));
    health_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        if cancel.is_cancelled() {
            break;
        }

        match spawn_module_process(&module_name, &command, &module_dir, &runtime_env) {
            Ok(mut child) => {
                println!(
                    "[modules] Started script for module '{}': {}",
                    module_name, command
                );
                restart_attempt = 0;

                // Wait for the child to exit OR for a health check OR for shutdown.
                // The child.wait() future resolves on process exit; the health
                // ticker fires every 2s and lets us log a one-shot warning if
                // the module is alive but unhealthy. Cancellation tears it all
                // down immediately.
                let mut logged_unhealthy = false;
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            break;
                        }
                        exit_status = child.wait() => {
                            if let Err(err) = exit_status {
                                eprintln!(
                                    "[modules] Warning: module process wait failed: {}",
                                    err
                                );
                            }
                            break;
                        }
                        _ = health_ticker.tick(), if !healthcheck_url.is_empty() => {
                            let healthy = is_module_healthy_async(
                                &healthcheck_url,
                                &validation_urls,
                            )
                            .await;
                            if healthy {
                                restart_attempt = 0;
                                logged_unhealthy = false;
                            } else if !logged_unhealthy {
                                eprintln!(
                                    "[modules] Module '{}' is alive but not yet healthy",
                                    module_name
                                );
                                logged_unhealthy = true;
                            }
                        }
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "[modules] Warning: failed to start script for module '{}': {}",
                    module_name, err
                );
            }
        }

        if cancel.is_cancelled() {
            break;
        }

        restart_attempt = restart_attempt.saturating_add(1);
        let delay = restart_delay(restart_attempt);
        eprintln!(
            "[modules] Module '{}' exited; restarting in {}s",
            module_name, delay
        );

        // Cancellable sleep — exit early if the app is shutting down.
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
            _ = cancel.cancelled() => break,
        }
    }

    supervisors.unregister(&module_name);
}

fn spawn_module_process(
    module_name: &str,
    command: &str,
    module_dir: &PathBuf,
    runtime_env: &HashMap<String, String>,
) -> Result<tokio::process::Child, String> {
    #[cfg(debug_assertions)]
    {
        if module_name == BASE_MODULE_NAME {
            if let Some(binary_path) = debug_module_binary(module_dir) {
                let mut cmd = TokioCommand::new(binary_path);
                configure_hidden_module_process(&mut cmd);
                cmd.current_dir(module_dir)
                    .envs(runtime_env)
                    .stdout(module_stdout())
                    .stderr(module_stderr())
                    .kill_on_drop(true);
                return cmd.spawn().map_err(|err| err.to_string());
            }
        }
    }

    #[cfg(not(debug_assertions))]
    {
        if let Some(binary_path) = bundled_module_binary(module_dir) {
            let mut cmd = TokioCommand::new(binary_path);
            configure_hidden_module_process(&mut cmd);
            cmd.current_dir(module_dir)
                .envs(runtime_env)
                .stdout(module_stdout())
                .stderr(module_stderr())
                .kill_on_drop(true);
            return cmd.spawn().map_err(|err| err.to_string());
        }

        if module_name == BASE_MODULE_NAME {
            return Err(format!(
                "bundled base module server is missing: {}",
                bundled_module_binary_path(module_dir).display()
            ));
        }
    }

    let mut cmd = shell_command(command);
    configure_hidden_module_process(&mut cmd);
    cmd.current_dir(module_dir)
        .envs(runtime_env)
        .stdout(module_stdout())
        .stderr(module_stderr())
        .kill_on_drop(true);
    cmd.spawn().map_err(|err| err.to_string())
}

#[cfg(debug_assertions)]
fn debug_module_binary(module_dir: &Path) -> Option<PathBuf> {
    let repo_root = module_dir.parent()?.parent()?;
    let binary_name = if cfg!(target_os = "windows") {
        "at-terminal-base-module.exe"
    } else {
        "at-terminal-base-module"
    };
    let binary_path = repo_root.join("target").join("debug").join(binary_name);
    binary_path.exists().then_some(binary_path)
}

#[cfg(target_os = "windows")]
fn configure_hidden_module_process(cmd: &mut TokioCommand) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_hidden_module_process(_cmd: &mut TokioCommand) {}

#[cfg(target_os = "windows")]
fn module_stdout() -> Stdio {
    Stdio::null()
}

#[cfg(not(target_os = "windows"))]
fn module_stdout() -> Stdio {
    Stdio::inherit()
}

#[cfg(target_os = "windows")]
fn module_stderr() -> Stdio {
    Stdio::null()
}

#[cfg(not(target_os = "windows"))]
fn module_stderr() -> Stdio {
    Stdio::inherit()
}

#[cfg(target_os = "windows")]
fn shell_command(command: &str) -> TokioCommand {
    let mut cmd = TokioCommand::new("cmd");
    cmd.arg("/C").arg(command);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn shell_command(command: &str) -> TokioCommand {
    let mut cmd = TokioCommand::new("sh");
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(not(debug_assertions))]
fn bundled_module_binary(module_dir: &Path) -> Option<PathBuf> {
    let binary_path = bundled_module_binary_path(module_dir);
    binary_path.exists().then_some(binary_path)
}

#[cfg(not(debug_assertions))]
fn bundled_module_binary_path(module_dir: &Path) -> PathBuf {
    let binary_name = if cfg!(target_os = "windows") {
        "at-terminal-base-module.exe"
    } else {
        "at-terminal-base-module"
    };
    module_dir.join("server").join("bin").join(binary_name)
}

fn runtime_env(runtime: Option<&BaseModuleRuntime>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(runtime) = runtime {
        env.insert("AT_BASE_PORT".to_string(), runtime.port.to_string());
        env.insert("AT_BASE_TOKEN".to_string(), runtime.token.clone());
        env.insert("AT_BASE_ALLOWED_ORIGIN".to_string(), runtime.origin.clone());
    }
    env
}

async fn is_module_healthy_async(healthcheck_url: &str, validation_urls: &[String]) -> bool {
    if !http_status_async(healthcheck_url).await {
        return false;
    }

    for url in validation_urls {
        if !http_status_async(url).await {
            return false;
        }
    }
    true
}

/// Returns true if the URL responds with HTTP 200. Uses a short timeout so
/// health checks never block the supervisor for long.
async fn http_status_async(url: &str) -> bool {
    if url.trim().is_empty() {
        return false;
    }
    // Drop the request on a dedicated blocking thread so a hung TCP connection
    // does not stall the runtime. The probe is tiny; the spawn_blocking cost
    // is negligible compared to the actual network round-trip.
    let url_owned = url.to_string();
    tauri::async_runtime::spawn_blocking(move || http_status_blocking(&url_owned))
        .await
        .unwrap_or(false)
}

fn http_status_blocking(url: &str) -> bool {
    let (host, path) = match parse_http_url(url) {
        Some(parsed) => parsed,
        None => return false,
    };
    let addr = match host.parse::<std::net::SocketAddr>() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        == Some(200)
}

fn collect_module_validation_urls(metadata: &ModuleMetadata) -> Vec<String> {
    let Some(base_origin) = get_http_origin(&metadata.panel_url_template)
        .or_else(|| get_http_origin(&metadata.healthcheck_url))
    else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut urls = Vec::new();

    for toolbar in metadata.panel_tool_bar.values() {
        for item in &toolbar.items {
            push_module_asset_url(&base_origin, &item.icon_path, &mut seen, &mut urls);
            for action in &item.items {
                push_module_asset_url(&base_origin, &action.icon_path, &mut seen, &mut urls);
            }
        }
    }

    for validation_url in &metadata.validation_urls {
        let normalized_url = validation_url.trim();
        if normalized_url.is_empty() {
            continue;
        }

        let Some(url) = resolve_module_asset_url(&base_origin, normalized_url) else {
            continue;
        };

        if seen.insert(url.clone()) {
            urls.push(url);
        }
    }

    urls
}

fn push_module_asset_url(
    base_origin: &str,
    asset_path: &str,
    seen: &mut HashSet<String>,
    urls: &mut Vec<String>,
) {
    let normalized_path = asset_path.trim();
    if normalized_path.is_empty() {
        return;
    }

    let Some(url) = resolve_module_asset_url(base_origin, normalized_path) else {
        return;
    };

    if seen.insert(url.clone()) {
        urls.push(url);
    }
}

fn get_http_origin(url: &str) -> Option<String> {
    let (host, _) = parse_http_url(url)?;
    Some(format!("http://{}", host))
}

fn resolve_module_asset_url(base_origin: &str, asset_path: &str) -> Option<String> {
    if asset_path.starts_with("http://") {
        return Some(asset_path.to_string());
    }

    if asset_path.starts_with("https://") {
        return None;
    }

    if asset_path.starts_with('/') {
        return Some(format!("{}{}", base_origin, asset_path));
    }

    Some(format!(
        "{}/{}",
        base_origin.trim_end_matches('/'),
        asset_path
    ))
}

fn apply_base_runtime_to_metadata(metadata: &mut ModuleMetadata, runtime: &BaseModuleRuntime) {
    metadata.panel_url_template = append_auth_token(
        &replace_base_origin(&metadata.panel_url_template, runtime),
        &runtime.token,
    );
    metadata.healthcheck_url = append_auth_token(
        &replace_base_origin(&metadata.healthcheck_url, runtime),
        &runtime.token,
    );
    metadata.validation_urls = metadata
        .validation_urls
        .iter()
        .map(|url| append_auth_token(&replace_base_origin(url, runtime), &runtime.token))
        .collect();
}

fn replace_base_origin(url: &str, runtime: &BaseModuleRuntime) -> String {
    url.replace(
        &format!("http://127.0.0.1:{}", BASE_MODULE_DEFAULT_PORT),
        &runtime.origin,
    )
}

fn append_auth_token(url: &str, token: &str) -> String {
    if url.trim().is_empty() || url.contains(&format!("{}=", BASE_MODULE_TOKEN_QUERY)) {
        return url.to_string();
    }

    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{}{}{}={}", url, separator, BASE_MODULE_TOKEN_QUERY, token)
}

fn parse_http_url(url: &str) -> Option<(String, String)> {
    if url.trim().is_empty() {
        return None;
    }
    let rest = url.strip_prefix("http://")?;
    let (host, path) = match rest.split_once('/') {
        Some((host, path)) => (host.to_string(), format!("/{}", path)),
        None => (rest.to_string(), "/".to_string()),
    };
    Some((host, path))
}

fn restart_delay(attempt: u32) -> u64 {
    let exponent = attempt.saturating_sub(1).min(5);
    (1u64 << exponent).min(MAX_RESTART_DELAY_SECS)
}

#[tauri::command]
pub async fn initialize_modules(
    manager: State<'_, ModuleManager>,
    supervisors: State<'_, ModuleSupervisors>,
) -> Result<(), String> {
    manager.initialize_async(supervisors.inner().clone()).await
}

#[tauri::command]
pub async fn get_module_registry(
    manager: State<'_, ModuleManager>,
    supervisors: State<'_, ModuleSupervisors>,
) -> Result<ModuleRegistrySnapshot, String> {
    manager.registry(supervisors.inner()).await
}

#[tauri::command]
pub async fn get_panel_types(
    manager: State<'_, ModuleManager>,
    supervisors: State<'_, ModuleSupervisors>,
) -> Result<Vec<String>, String> {
    let registry = manager.registry(supervisors.inner()).await?;
    Ok(registry
        .panel_types
        .into_iter()
        .map(|entry| entry.r#type)
        .collect())
}

#[tauri::command]
pub async fn get_app_diagnostics(
    manager: State<'_, ModuleManager>,
    supervisors: State<'_, ModuleSupervisors>,
) -> Result<AppDiagnostics, String> {
    manager.diagnostics(supervisors.inner()).await
}

#[cfg(test)]
mod tests {
    use super::{panel_display_name_for_type, ModuleMetadata};
    use std::collections::HashMap;

    fn metadata_with_display_name(panel_type: &str, display_name: &str) -> ModuleMetadata {
        let mut panel_display_names = HashMap::new();
        panel_display_names.insert(panel_type.to_string(), display_name.to_string());
        ModuleMetadata {
            module_name: "test".to_string(),
            panel_types: vec![panel_type.to_string()],
            panel_display_names,
            panel_colors: HashMap::new(),
            panel_tool_bar: HashMap::new(),
            startup_script_location: String::new(),
            startup_script_command: String::new(),
            panel_url_template: String::new(),
            healthcheck_url: String::new(),
            validation_urls: Vec::new(),
        }
    }

    #[test]
    fn uses_panel_display_name_override_when_present() {
        let metadata = metadata_with_display_name("monaco", "Editor");
        assert_eq!(panel_display_name_for_type(&metadata, "monaco"), "Editor");
    }

    #[test]
    fn falls_back_when_panel_display_name_is_blank() {
        let metadata = metadata_with_display_name("monaco", "   ");
        assert_eq!(panel_display_name_for_type(&metadata, "monaco"), "Monaco");
    }
}
