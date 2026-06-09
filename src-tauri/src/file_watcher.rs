use home::home_dir;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const WATCHER_DEBOUNCE_MS: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeBatchEvent {
    pub changed_dirs: Vec<String>,
    pub changed_paths: Vec<String>,
    pub includes_git_metadata: bool,
    pub kind: String,
}

struct ActiveWatcher {
    _watcher: RecommendedWatcher,
    stop_tx: Sender<()>,
}

impl ActiveWatcher {
    fn stop(self) {
        let _ = self.stop_tx.send(());
    }
}

#[derive(Default)]
pub struct FileWatcherState {
    active: Mutex<Option<ActiveWatcher>>,
}

impl FileWatcherState {
    pub fn stop_active_watcher(&self) {
        if let Ok(mut lock) = self.active.lock() {
            if let Some(active) = lock.take() {
                active.stop();
            }
        }
    }

    pub fn set_root(&self, app_handle: AppHandle, root_path: String) -> Result<(), String> {
        let canonical_root = canonical_dir(&root_path)?;

        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            },
            notify::Config::default(),
        )
        .map_err(|e| format!("Failed to initialize watcher: {}", e))?;

        let recursive_mode = watch_mode_for_root(&canonical_root);
        watcher
            .watch(canonical_root.as_path(), recursive_mode)
            .map_err(|e| format!("Failed to watch root directory: {}", e))?;

        spawn_emitter_worker(app_handle, event_rx, stop_rx);

        let next = ActiveWatcher {
            _watcher: watcher,
            stop_tx,
        };

        let mut lock = self
            .active
            .lock()
            .map_err(|_| "File watcher lock poisoned".to_string())?;
        if let Some(active) = lock.take() {
            active.stop();
        }
        *lock = Some(next);
        Ok(())
    }
}

fn spawn_emitter_worker(app_handle: AppHandle, event_rx: Receiver<Event>, stop_rx: Receiver<()>) {
    thread::spawn(move || loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        let first = match event_rx.recv_timeout(Duration::from_millis(WATCHER_DEBOUNCE_MS)) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        let mut dirs = HashSet::<String>::new();
        let mut paths = HashSet::<String>::new();
        let mut kinds = Vec::<String>::new();
        let mut includes_git_metadata = false;
        collect_paths_dirs_and_kind(
            &first,
            &mut dirs,
            &mut paths,
            &mut kinds,
            &mut includes_git_metadata,
        );

        while let Ok(next_event) = event_rx.try_recv() {
            collect_paths_dirs_and_kind(
                &next_event,
                &mut dirs,
                &mut paths,
                &mut kinds,
                &mut includes_git_metadata,
            );
        }

        if dirs.is_empty() && paths.is_empty() {
            continue;
        }

        let mut changed_dirs = dirs.into_iter().collect::<Vec<_>>();
        changed_dirs.sort();
        let mut changed_paths = paths.into_iter().collect::<Vec<_>>();
        changed_paths.sort();
        let kind = kinds
            .last()
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        let payload = FileChangeBatchEvent {
            changed_dirs,
            changed_paths,
            includes_git_metadata,
            kind,
        };
        let _ = app_handle.emit("file-change", payload);
    });
}

fn collect_paths_dirs_and_kind(
    event: &Event,
    dirs: &mut HashSet<String>,
    paths: &mut HashSet<String>,
    kinds: &mut Vec<String>,
    includes_git_metadata: &mut bool,
) {
    kinds.push(format!("{:?}", event.kind));
    for path in &event.paths {
        paths.insert(normalized_path_string(path));
        if is_git_metadata_path(path) {
            *includes_git_metadata = true;
        }
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        dirs.insert(normalized_path_string(dir));
    }
}

fn is_git_metadata_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == OsStr::new(".git"))
}

fn canonical_dir(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    if !candidate.is_dir() {
        return Err("Watched root is not a directory".to_string());
    }
    Ok(candidate)
}

fn watch_mode_for_root(canonical_root: &Path) -> RecursiveMode {
    if canonical_root.parent().is_none() {
        return RecursiveMode::NonRecursive;
    }

    let Some(home) = home_dir().and_then(|path| path.canonicalize().ok()) else {
        return RecursiveMode::Recursive;
    };

    if canonical_root == home || canonical_root.parent() == home.parent() {
        return RecursiveMode::NonRecursive;
    }

    RecursiveMode::Recursive
}

fn normalized_path_string(path: &Path) -> String {
    path.to_string_lossy().to_string().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_path_is_watched_non_recursively() {
        let root = Path::new("/");
        assert!(matches!(
            watch_mode_for_root(root),
            RecursiveMode::NonRecursive
        ));
    }

    #[test]
    fn home_path_is_watched_non_recursively() {
        let Some(home) = home_dir().and_then(|path| path.canonicalize().ok()) else {
            return;
        };

        assert!(matches!(
            watch_mode_for_root(&home),
            RecursiveMode::NonRecursive
        ));
    }

    #[test]
    fn child_project_path_is_watched_recursively() {
        let Some(home) = home_dir().and_then(|path| path.canonicalize().ok()) else {
            return;
        };

        assert!(matches!(
            watch_mode_for_root(&home.join("project")),
            RecursiveMode::Recursive
        ));
    }
}
