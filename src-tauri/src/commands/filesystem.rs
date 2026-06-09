use crate::commands::ApprovedRoots;
use crate::file_watcher::FileWatcherState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, State};

const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// Run a blocking closure on the Tauri async runtime's blocking thread pool.
/// Mirrors `run_git_task` in `git.rs` so disk I/O never stalls the executor.
pub async fn run_fs_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("Filesystem task failed: {}", err))?
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub extension: Option<String>,
}

#[tauri::command]
pub async fn list_directory(
    roots: State<'_, ApprovedRoots>,
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    roots.ensure_path_within_approved_root(&path)?;
    run_fs_task(move || list_directory_impl(&path, include_hidden.unwrap_or(false))).await
}

fn list_directory_impl(path: &str, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    let dir_path = Path::new(path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let entries: Vec<DirEntry> = fs::read_dir(dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();

            // Skip hidden files/directories unless explicitly requested
            if !show_hidden && name.starts_with('.') {
                return None;
            }

            let metadata = entry.metadata().ok()?;
            let is_directory = metadata.is_dir();
            let full_path = entry.path().to_string_lossy().to_string();

            let extension = if is_directory {
                None
            } else {
                Path::new(&name)
                    .extension()
                    .map(|ext| ext.to_string_lossy().to_string())
            };

            Some(DirEntry {
                name,
                path: full_path,
                is_directory,
                extension,
            })
        })
        .collect();

    // Sort: directories first, then alphabetical (case-insensitive)
    let mut entries = entries;
    entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalPathConflict {
    pub source_path: String,
    pub destination_path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalPathFailure {
    pub source_path: String,
    pub destination_path: Option<String>,
    pub error: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportExternalPathsResult {
    pub imported_paths: Vec<String>,
    pub conflicts: Vec<ImportExternalPathConflict>,
    pub failures: Vec<ImportExternalPathFailure>,
}

#[tauri::command]
pub async fn read_text_file(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    path: String,
) -> Result<TextFile, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || read_text_file_impl(&root_directory, &path)).await
}

fn read_text_file_impl(root_directory: &str, path: &str) -> Result<TextFile, String> {
    let root = canonical_root(root_directory)?;
    let target = canonical_target(&root, path)?;
    let metadata = fs::metadata(&target).map_err(|e| format!("Failed to inspect file: {}", e))?;

    if !metadata.is_file() {
        return Err("Only regular files can be opened in the editor".to_string());
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("File is larger than the 10 MiB editor limit".to_string());
    }

    let bytes = fs::read(&target).map_err(|e| format!("Failed to read file: {}", e))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| "Only UTF-8 text files can be opened in the editor".to_string())?;

    Ok(TextFile {
        path: target.to_string_lossy().to_string(),
        content,
        size: metadata.len(),
        modified_ms: modified_ms(&metadata)?,
    })
}

#[tauri::command]
pub async fn write_text_file(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    path: String,
    content: String,
    expected_modified_ms: u64,
) -> Result<TextFile, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || {
        write_text_file_impl(&root_directory, &path, &content, expected_modified_ms)
    })
    .await
}

fn write_text_file_impl(
    root_directory: &str,
    path: &str,
    content: &str,
    expected_modified_ms: u64,
) -> Result<TextFile, String> {
    let root = canonical_root(root_directory)?;
    let target = canonical_target(&root, path)?;
    let metadata = fs::metadata(&target).map_err(|e| format!("Failed to inspect file: {}", e))?;

    if !metadata.is_file() {
        return Err("Only regular files can be saved from the editor".to_string());
    }

    let current_modified_ms = modified_ms(&metadata)?;
    if current_modified_ms != expected_modified_ms {
        return Err("The file changed on disk. Reload it before saving again.".to_string());
    }

    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err("File is larger than the 10 MiB editor limit".to_string());
    }

    fs::write(&target, content).map_err(|e| format!("Failed to write file: {}", e))?;
    let next_metadata =
        fs::metadata(&target).map_err(|e| format!("Failed to inspect saved file: {}", e))?;
    read_text_file_impl(&root.to_string_lossy(), &target.to_string_lossy()).map(|mut file| {
        file.size = next_metadata.len();
        file
    })
}

fn canonical_root(root_directory: &str) -> Result<PathBuf, String> {
    let root = Path::new(root_directory)
        .canonicalize()
        .map_err(|e| format!("Failed to resolve workspace folder: {}", e))?;
    if !root.is_dir() {
        return Err("Workspace folder is not a directory".to_string());
    }
    Ok(root)
}

fn canonical_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    let requested_path = Path::new(path);
    let target = if requested_path.is_absolute() {
        requested_path.to_path_buf()
    } else {
        root.join(requested_path)
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve file: {}", e))?;
    if !target.starts_with(root) {
        return Err("File is outside the workspace folder".to_string());
    }
    Ok(target)
}

fn modified_ms(metadata: &fs::Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|e| format!("Failed to read modified time: {}", e))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Invalid modified time: {}", e))
        .and_then(|duration| {
            duration
                .as_millis()
                .try_into()
                .map_err(|_| "Modified time is too large".to_string())
        })
}

#[tauri::command]
pub async fn create_file(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || create_file_impl(&root_directory, &parent_path, &name)).await
}

fn create_file_impl(root_directory: &str, parent_path: &str, name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("File name cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("File name cannot contain path separators".to_string());
    }

    let root = canonical_root(root_directory)?;
    let parent = canonical_target(&root, parent_path)?;
    if !parent.exists() || !parent.is_dir() {
        return Err(format!("Parent directory does not exist: {}", parent_path));
    }

    let file_path = parent.join(name);
    if file_path.exists() {
        return Err(format!("File already exists: {}", name));
    }

    fs::write(&file_path, "").map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn create_directory(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || create_directory_impl(&root_directory, &parent_path, &name)).await
}

fn create_directory_impl(
    root_directory: &str,
    parent_path: &str,
    name: &str,
) -> Result<String, String> {
    if name.is_empty() {
        return Err("Directory name cannot be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("Directory name cannot contain path separators".to_string());
    }

    let root = canonical_root(root_directory)?;
    let parent = canonical_target(&root, parent_path)?;
    if !parent.exists() || !parent.is_dir() {
        return Err(format!("Parent directory does not exist: {}", parent_path));
    }

    let dir_path = parent.join(name);
    if dir_path.exists() {
        return Err(format!("Directory already exists: {}", name));
    }

    fs::create_dir(&dir_path).map_err(|e| format!("Failed to create directory: {}", e))?;
    Ok(dir_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn rename_path(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || rename_path_impl(&root_directory, &path, &new_name)).await
}

fn rename_path_impl(root_directory: &str, path: &str, new_name: &str) -> Result<String, String> {
    if new_name.is_empty() {
        return Err("New name cannot be empty".to_string());
    }
    if new_name.contains('/') || new_name.contains('\\') {
        return Err("New name cannot contain path separators".to_string());
    }

    let root = canonical_root(root_directory)?;
    let original = canonical_target(&root, path)?;
    if !original.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let parent = original
        .parent()
        .ok_or_else(|| "Cannot rename root path".to_string())?;
    let new_path = parent.join(new_name);

    if new_path.exists() {
        return Err(format!(
            "A file or folder named '{}' already exists",
            new_name
        ));
    }

    fs::rename(original, &new_path).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn move_path(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    source_path: String,
    dest_dir: String,
) -> Result<String, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || move_path_impl(&root_directory, &source_path, &dest_dir)).await
}

fn move_path_impl(
    root_directory: &str,
    source_path: &str,
    dest_dir: &str,
) -> Result<String, String> {
    let root = canonical_root(root_directory)?;
    let source = canonical_target(&root, source_path)?;
    if !source.exists() {
        return Err(format!("Source path does not exist: {}", source_path));
    }

    let source_canonical = canonical_target(&root, source_path)?;
    let dest_dir_canonical = canonical_target(&root, dest_dir)?;

    if !dest_dir_canonical.is_dir() {
        return Err(format!(
            "Destination path is not a directory: {}",
            dest_dir_canonical.to_string_lossy()
        ));
    }

    if source_canonical.is_dir() && dest_dir_canonical.starts_with(&source_canonical) {
        return Err("Cannot move a folder into itself or its descendants".to_string());
    }

    let file_name = source_canonical
        .file_name()
        .ok_or_else(|| "Cannot move root path".to_string())?;
    let destination = dest_dir_canonical.join(file_name);

    if destination == source_canonical {
        return Err("Source and destination are the same path".to_string());
    }

    if destination.exists() {
        return Err(format!(
            "Destination already exists: {}",
            destination.to_string_lossy()
        ));
    }

    fs::rename(&source_canonical, &destination).map_err(|e| format!("Failed to move: {}", e))?;

    let moved = destination
        .canonicalize()
        .unwrap_or(destination)
        .to_string_lossy()
        .to_string();
    Ok(moved)
}

#[tauri::command]
pub async fn import_external_paths(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    destination_dir: String,
    source_paths: Vec<String>,
    replace_existing: Option<bool>,
) -> Result<ImportExternalPathsResult, String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || {
        import_external_paths_impl(
            &root_directory,
            &destination_dir,
            &source_paths,
            replace_existing.unwrap_or(false),
        )
    })
    .await
}

fn import_external_paths_impl(
    root_directory: &str,
    destination_dir: &str,
    source_paths: &[String],
    replace_existing: bool,
) -> Result<ImportExternalPathsResult, String> {
    let root = canonical_root(root_directory)?;
    let destination_dir = canonical_target(&root, destination_dir)?;

    if !destination_dir.is_dir() {
        return Err(format!(
            "Destination path is not a directory: {}",
            destination_dir.to_string_lossy()
        ));
    }

    let mut result = ImportExternalPathsResult::default();

    for source_path in source_paths {
        let source = Path::new(source_path);
        if !source.exists() {
            result.failures.push(ImportExternalPathFailure {
                source_path: source_path.clone(),
                destination_path: None,
                error: "Source path does not exist".to_string(),
            });
            continue;
        }

        let source_metadata = match fs::symlink_metadata(source) {
            Ok(metadata) => metadata,
            Err(err) => {
                result.failures.push(ImportExternalPathFailure {
                    source_path: source_path.clone(),
                    destination_path: None,
                    error: format!("Failed to inspect source path: {}", err),
                });
                continue;
            }
        };

        if source_metadata.file_type().is_symlink() {
            result.failures.push(ImportExternalPathFailure {
                source_path: source_path.clone(),
                destination_path: None,
                error: "Symlink sources are not supported".to_string(),
            });
            continue;
        }

        let source_canonical = match source.canonicalize() {
            Ok(path) => path,
            Err(err) => {
                result.failures.push(ImportExternalPathFailure {
                    source_path: source_path.clone(),
                    destination_path: None,
                    error: format!("Failed to resolve source path: {}", err),
                });
                continue;
            }
        };

        let Some(name) = source_canonical.file_name() else {
            result.failures.push(ImportExternalPathFailure {
                source_path: source_path.clone(),
                destination_path: None,
                error: "Cannot import a filesystem root".to_string(),
            });
            continue;
        };

        let target_path = destination_dir.join(name);
        ensure_destination_within_root(&root, &target_path)?;

        if target_path.exists() {
            if !replace_existing {
                result.conflicts.push(ImportExternalPathConflict {
                    source_path: source_path.clone(),
                    destination_path: target_path.to_string_lossy().to_string(),
                    name: name.to_string_lossy().to_string(),
                });
                continue;
            }

            if let Err(error) = remove_existing_target_if_compatible(&source_canonical, &target_path) {
                result.failures.push(ImportExternalPathFailure {
                    source_path: source_path.clone(),
                    destination_path: Some(target_path.to_string_lossy().to_string()),
                    error,
                });
                continue;
            }
        }

        let copy_result = if source_canonical.is_dir() {
            copy_directory_recursively(&root, &source_canonical, &target_path)
        } else {
            copy_file_into_workspace(&root, &source_canonical, &target_path)
        };

        match copy_result {
            Ok(imported_path) => result.imported_paths.push(imported_path),
            Err(error) => result.failures.push(ImportExternalPathFailure {
                source_path: source_path.clone(),
                destination_path: Some(target_path.to_string_lossy().to_string()),
                error,
            }),
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn delete_path(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let root_directory = roots
        .ensure_root_approved(&root_directory)?
        .to_string_lossy()
        .to_string();
    run_fs_task(move || delete_path_impl(&root_directory, &path, recursive.unwrap_or(false))).await
}

fn delete_path_impl(root_directory: &str, path: &str, force_recursive: bool) -> Result<(), String> {
    let root = canonical_root(root_directory)?;
    let target = canonical_target(&root, path)?;
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if target.is_dir() {
        if force_recursive {
            fs::remove_dir_all(target).map_err(|e| format!("Failed to delete directory: {}", e))?;
        } else {
            fs::remove_dir(target).map_err(|e| format!("Failed to delete directory: {}", e))?;
        }
    } else {
        fs::remove_file(target).map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_watched_root(
    app_handle: AppHandle,
    roots: State<'_, ApprovedRoots>,
    state: State<'_, FileWatcherState>,
    root_path: String,
) -> Result<(), String> {
    roots.ensure_root_approved(&root_path)?;
    state.set_root(app_handle, root_path)
}

#[tauri::command]
pub fn stop_watching_root(state: State<'_, FileWatcherState>) -> Result<(), String> {
    state.stop_active_watcher();
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_explorer(
    roots: State<'_, ApprovedRoots>,
    path: String,
) -> Result<(), String> {
    roots.ensure_path_within_approved_root(&path)?;
    run_fs_task(move || reveal_in_explorer_impl(&path)).await
}

fn reveal_in_explorer_impl(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    // For files, reveal the file in the file manager by opening its parent directory.
    // For directories, open the directory itself.
    let dir_to_open = if target.is_dir() {
        target.to_path_buf()
    } else {
        target
            .parent()
            .ok_or_else(|| "Cannot get parent directory".to_string())?
            .to_path_buf()
    };

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir_to_open)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = std::process::Command::new("explorer");
        if target.is_dir() {
            command.arg(&dir_to_open);
        } else {
            command.arg(format!("/select,{}", path));
        }
        command
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }

    Ok(())
}

fn ensure_destination_within_root(root: &Path, path: &Path) -> Result<(), String> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err("Destination path is outside the workspace folder".to_string())
    }
}

fn remove_existing_target_if_compatible(source: &Path, target: &Path) -> Result<(), String> {
    let target_metadata =
        fs::symlink_metadata(target).map_err(|e| format!("Failed to inspect destination: {}", e))?;

    if target_metadata.file_type().is_symlink() {
        return Err("Refusing to replace a symlink destination".to_string());
    }

    let source_is_dir = source.is_dir();
    let target_is_dir = target_metadata.is_dir();

    if source_is_dir != target_is_dir {
        return Err("Cannot replace a file with a folder or a folder with a file".to_string());
    }

    if target_is_dir {
        fs::remove_dir_all(target).map_err(|e| format!("Failed to replace destination folder: {}", e))
    } else {
        fs::remove_file(target).map_err(|e| format!("Failed to replace destination file: {}", e))
    }
}

fn copy_file_into_workspace(root: &Path, source: &Path, target: &Path) -> Result<String, String> {
    ensure_destination_within_root(root, target)?;

    let parent = target
        .parent()
        .ok_or_else(|| "Destination file has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to prepare destination directory: {}", e))?;
    fs::copy(source, target).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

fn copy_directory_recursively(root: &Path, source: &Path, target: &Path) -> Result<String, String> {
    ensure_destination_within_root(root, target)?;
    fs::create_dir(target).map_err(|e| format!("Failed to create destination folder: {}", e))?;

    copy_directory_contents(root, source, target)?;
    Ok(target.to_string_lossy().to_string())
}

fn copy_directory_contents(root: &Path, source: &Path, target: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| format!("Failed to read source folder: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read source folder entry: {}", e))?;
        let child_source = entry.path();
        let child_name = entry.file_name();
        let child_target = target.join(&child_name);
        ensure_destination_within_root(root, &child_target)?;

        let metadata = fs::symlink_metadata(&child_source)
            .map_err(|e| format!("Failed to inspect source entry: {}", e))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Symlink sources are not supported: {}",
                child_source.to_string_lossy()
            ));
        }

        if metadata.is_dir() {
            fs::create_dir(&child_target)
                .map_err(|e| format!("Failed to create destination folder: {}", e))?;
            copy_directory_contents(root, &child_source, &child_target)?;
            continue;
        }

        if metadata.is_file() {
            fs::copy(&child_source, &child_target)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
            continue;
        }

        return Err(format!(
            "Unsupported source entry type: {}",
            child_source.to_string_lossy()
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("at-terminal-{}-{}", name, unique))
    }

    #[test]
    fn delete_rejects_paths_outside_workspace_root() {
        let root = test_dir("root");
        let outside = test_dir("outside-file");
        fs::create_dir_all(&root).expect("create root");
        fs::write(&outside, "outside").expect("create outside file");

        let result = delete_path_impl(&root.to_string_lossy(), &outside.to_string_lossy(), false);

        assert!(result.is_err());
        assert!(outside.exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_file(outside);
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_symlink_escape_outside_workspace_root() {
        use std::os::unix::fs::symlink;

        let root = test_dir("root");
        let outside_dir = test_dir("outside-dir");
        let outside_file = outside_dir.join("secret.txt");
        let link_path = root.join("linked-secret.txt");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        fs::write(&outside_file, "outside").expect("create outside file");
        symlink(&outside_file, &link_path).expect("create symlink");

        let result = write_text_file_impl(
            &root.to_string_lossy(),
            &link_path.to_string_lossy(),
            "changed",
            0,
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&outside_file).expect("read outside file"),
            "outside"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside_dir);
    }

    #[test]
    fn import_external_paths_copies_files_and_folders() {
        let root = test_dir("import-root");
        let workspace = root.join("workspace");
        let source_root = root.join("external");
        let source_file = source_root.join("notes.txt");
        let source_dir = source_root.join("docs");
        let source_nested = source_dir.join("nested.txt");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&source_dir).expect("create external dir");
        fs::write(&source_file, "hello").expect("write source file");
        fs::write(&source_nested, "nested").expect("write nested file");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &workspace.to_string_lossy(),
            &[
                source_file.to_string_lossy().to_string(),
                source_dir.to_string_lossy().to_string(),
            ],
            false,
        )
        .expect("import paths");

        assert!(result.conflicts.is_empty());
        assert!(result.failures.is_empty());
        assert_eq!(result.imported_paths.len(), 2);
        assert_eq!(
            fs::read_to_string(workspace.join("notes.txt")).expect("read imported file"),
            "hello"
        );
        assert_eq!(
            fs::read_to_string(workspace.join("docs").join("nested.txt"))
                .expect("read imported nested file"),
            "nested"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_external_paths_reports_conflicts_before_replace() {
        let root = test_dir("import-conflict");
        let workspace = root.join("workspace");
        let source_root = root.join("external");
        let existing = workspace.join("notes.txt");
        let source_file = source_root.join("notes.txt");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&source_root).expect("create source root");
        fs::write(&existing, "existing").expect("write existing file");
        fs::write(&source_file, "incoming").expect("write incoming file");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &workspace.to_string_lossy(),
            &[source_file.to_string_lossy().to_string()],
            false,
        )
        .expect("import paths");

        assert!(result.imported_paths.is_empty());
        assert!(result.failures.is_empty());
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&existing).expect("read existing file"),
            "existing"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_external_paths_replaces_existing_files_when_confirmed() {
        let root = test_dir("import-replace");
        let workspace = root.join("workspace");
        let source_root = root.join("external");
        let existing = workspace.join("notes.txt");
        let source_file = source_root.join("notes.txt");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&source_root).expect("create source root");
        fs::write(&existing, "existing").expect("write existing file");
        fs::write(&source_file, "incoming").expect("write incoming file");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &workspace.to_string_lossy(),
            &[source_file.to_string_lossy().to_string()],
            true,
        )
        .expect("import paths");

        assert!(result.conflicts.is_empty());
        assert!(result.failures.is_empty());
        assert_eq!(result.imported_paths, vec![existing.to_string_lossy().to_string()]);
        assert_eq!(
            fs::read_to_string(&existing).expect("read replaced file"),
            "incoming"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_external_paths_rejects_incompatible_replace_types() {
        let root = test_dir("import-mismatch");
        let workspace = root.join("workspace");
        let source_root = root.join("external");
        let existing = workspace.join("docs");
        let source_file = source_root.join("docs");
        fs::create_dir_all(&existing).expect("create existing dir");
        fs::create_dir_all(&source_root).expect("create source root");
        fs::write(&source_file, "incoming").expect("write incoming file");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &workspace.to_string_lossy(),
            &[source_file.to_string_lossy().to_string()],
            true,
        )
        .expect("import paths");

        assert!(result.imported_paths.is_empty());
        assert!(result.conflicts.is_empty());
        assert_eq!(result.failures.len(), 1);
        assert!(existing.is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_external_paths_rejects_destination_outside_workspace_root() {
        let root = test_dir("import-outside");
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        let source_root = root.join("external");
        let source_file = source_root.join("notes.txt");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside");
        fs::create_dir_all(&source_root).expect("create source root");
        fs::write(&source_file, "incoming").expect("write incoming file");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &outside.to_string_lossy(),
            &[source_file.to_string_lossy().to_string()],
            false,
        );

        assert!(result.is_err());
        assert!(!outside.join("notes.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_external_paths_reports_missing_sources() {
        let root = test_dir("import-missing");
        let workspace = root.join("workspace");
        let missing = root.join("missing.txt");
        fs::create_dir_all(&workspace).expect("create workspace");

        let result = import_external_paths_impl(
            &workspace.to_string_lossy(),
            &workspace.to_string_lossy(),
            &[missing.to_string_lossy().to_string()],
            false,
        )
        .expect("import paths");

        assert!(result.imported_paths.is_empty());
        assert!(result.conflicts.is_empty());
        assert_eq!(result.failures.len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
