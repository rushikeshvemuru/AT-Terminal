#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod file_watcher;

use commands::ApprovedRoots;
use commands::BrowserPanelManager;
use commands::GitAuthState;
use commands::ModuleManager;
use commands::ModuleSupervisors;
use commands::SessionWindowManager;
use commands::TerminalBlockState;
use file_watcher::FileWatcherState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, RunEvent};

#[derive(Serialize, Deserialize, Debug)]
struct WindowMetadata {
    label: String,
    created_at: u64,
}

fn handle_window_open(label: &str) -> anyhow::Result<()> {
    let home = home::home_dir().ok_or_else(|| anyhow::anyhow!("Could not find home directory"))?;
    let config_dir = home.join(".atterm");

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)?;
    }

    let file_path = config_dir.join(format!("window_{}.json", label));
    let metadata = WindowMetadata {
        label: label.to_string(),
        created_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
    };

    let json = serde_json::to_string_pretty(&metadata)?;
    fs::write(file_path, json)?;
    Ok(())
}

fn handle_window_close(label: &str) -> anyhow::Result<()> {
    let home = home::home_dir().ok_or_else(|| anyhow::anyhow!("Could not find home directory"))?;
    let file_path = home.join(".atterm").join(format!("window_{}.json", label));

    if file_path.exists() {
        fs::remove_file(file_path)?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let module_manager = ModuleManager::with_resource_dir(resource_dir);
            let module_supervisors = ModuleSupervisors::default();
            app.manage(module_manager);
            app.manage(module_supervisors);
            if let (Some(manager), Some(supervisors)) = (
                app.try_state::<ModuleManager>(),
                app.try_state::<ModuleSupervisors>(),
            ) {
                manager
                    .inner()
                    .initialize_modules_at_startup(supervisors.inner().clone());
            }
            app.manage(BrowserPanelManager::default());
            app.manage(SessionWindowManager::default());
            app.manage(ApprovedRoots::default());
            app.manage(FileWatcherState::default());
            app.manage(GitAuthState::default());
            app.manage(TerminalBlockState::default());

            for (_, window) in app.webview_windows() {
                let label = window.label().to_string();
                if let Err(e) = handle_window_open(&label) {
                    eprintln!("Failed to create metadata for {}: {}", label, e);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sessions,
            commands::create_session,
            commands::open_session,
            commands::save_tab_state,
            commands::delete_session,
            commands::select_workspace_root,
            commands::claim_session_window,
            commands::release_session_window,
            commands::focus_session_owner,
            commands::open_detached_tab_window,
            commands::focus_detached_tab_window,
            commands::close_detached_tab_window,
            commands::close_detached_tab_windows_for_session,
            commands::get_detached_tab_window_payload,
            commands::update_detached_tab_bounds,
            commands::list_directory,
            commands::read_text_file,
            commands::write_text_file,
            commands::create_file,
            commands::create_directory,
            commands::rename_path,
            commands::move_path,
            commands::import_external_paths,
            commands::delete_path,
            commands::reveal_in_explorer,
            commands::set_watched_root,
            commands::stop_watching_root,
            commands::get_git_status,
            commands::get_git_auth_status,
            commands::launch_gh_auth_login,
            commands::run_gh_auth_setup_git,
            commands::get_gh_install_help,
            commands::start_github_oauth,
            commands::disconnect_github_auth,
            commands::list_git_branches,
            commands::checkout_git_branch,
            commands::create_git_branch,
            commands::pull_git_changes,
            commands::push_git_changes,
            commands::sync_git_changes,
            commands::stage_git_paths,
            commands::unstage_git_paths,
            commands::get_git_diff,
            commands::create_git_commit,
            commands::fetch_git_changes,
            commands::merge_git_branch_from_remote,
            commands::stage_git_all,
            commands::unstage_git_all,
            commands::discard_git_all_changes,
            commands::stash_git_changes,
            commands::pop_git_stash,
            commands::list_git_stashes,
            commands::add_git_remote,
            commands::remove_git_remote,
            commands::list_git_remotes,
            commands::list_git_worktrees,
            commands::create_git_worktree,
            commands::remove_git_worktree,
            commands::save_buffer,
            commands::load_buffer,
            commands::delete_buffer,
            commands::start_terminal_block,
            commands::start_interactive_terminal_block,
            commands::write_interactive_terminal_block,
            commands::resize_interactive_terminal_block,
            commands::cancel_terminal_block,
            commands::delete_terminal_block,
            commands::list_terminal_blocks,
            commands::open_browser_panel_window,
            commands::navigate_browser_panel,
            commands::browser_panel_go_back,
            commands::browser_panel_go_forward,
            commands::browser_panel_reload,
            commands::browser_panel_stop,
            commands::focus_browser_panel_window,
            commands::close_browser_panel_window,
            commands::get_browser_panel_state,
            commands::get_panel_types,
            commands::initialize_modules,
            commands::get_module_registry,
            commands::get_app_diagnostics,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let label = window.label().to_string();
                if let Err(e) = handle_window_close(&label) {
                    eprintln!("Failed to remove metadata for {}: {}", label, e);
                }
                if let Some(manager) = window.try_state::<SessionWindowManager>() {
                    manager.remove_window_label(&label);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(supervisors) = app_handle.try_state::<ModuleSupervisors>() {
                    supervisors.inner().cancel_all();
                }
            }
        });
}
