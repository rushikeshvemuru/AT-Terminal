use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default, Clone)]
pub struct ApprovedRoots {
    roots: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRoot {
    pub path: String,
}

impl ApprovedRoots {
    pub fn approve_root_path(&self, path: impl AsRef<Path>) -> Result<PathBuf, String> {
        let root = canonical_existing_dir(path.as_ref())?;
        let mut roots = self
            .roots
            .lock()
            .map_err(|_| "Approved root state is unavailable".to_string())?;
        roots.insert(root.clone());
        Ok(root)
    }

    pub fn approve_root_if_available(&self, path: &str) {
        if path.trim().is_empty() {
            return;
        }
        let _ = self.approve_root_path(path);
    }

    pub fn ensure_root_approved(&self, root: impl AsRef<Path>) -> Result<PathBuf, String> {
        let root = canonical_existing_dir(root.as_ref())?;
        let roots = self
            .roots
            .lock()
            .map_err(|_| "Approved root state is unavailable".to_string())?;
        if roots.contains(&root) {
            return Ok(root);
        }
        Err("Workspace root has not been approved for this session".to_string())
    }

    pub fn ensure_path_within_approved_root(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<PathBuf, String> {
        let target = path
            .as_ref()
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {}", e))?;
        let roots = self
            .roots
            .lock()
            .map_err(|_| "Approved root state is unavailable".to_string())?;
        if roots.iter().any(|root| target.starts_with(root)) {
            return Ok(target);
        }
        Err("Path is outside approved workspace roots".to_string())
    }
}

fn canonical_existing_dir(path: &Path) -> Result<PathBuf, String> {
    let root = path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve workspace folder: {}", e))?;
    if !root.is_dir() {
        return Err("Workspace folder is not a directory".to_string());
    }
    Ok(root)
}

#[tauri::command]
pub async fn select_workspace_root(
    app_handle: AppHandle,
    roots: State<'_, ApprovedRoots>,
    title: Option<String>,
) -> Result<Option<ApprovedRoot>, String> {
    let dialog_title = title.unwrap_or_else(|| "Select Workspace Root".to_string());
    let selected = app_handle
        .dialog()
        .file()
        .set_title(dialog_title)
        .blocking_pick_folder();

    let Some(selected) = selected else {
        return Ok(None);
    };

    let path = selected
        .into_path()
        .map_err(|e| format!("Failed to read selected folder path: {}", e))?;
    let root = roots.approve_root_path(path)?;
    Ok(Some(ApprovedRoot {
        path: root.to_string_lossy().to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("at-terminal-roots-{}-{}", name, unique))
    }

    #[test]
    fn unapproved_root_is_rejected() {
        let root = test_dir("unapproved");
        fs::create_dir_all(&root).expect("create root");

        let roots = ApprovedRoots::default();
        let result = roots.ensure_root_approved(&root);

        assert!(result.is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn approved_root_allows_child_paths() {
        let root = test_dir("approved");
        let child = root.join("child");
        fs::create_dir_all(&child).expect("create child");

        let roots = ApprovedRoots::default();
        roots.approve_root_path(&root).expect("approve root");

        assert!(roots.ensure_root_approved(&root).is_ok());
        assert!(roots.ensure_path_within_approved_root(&child).is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
