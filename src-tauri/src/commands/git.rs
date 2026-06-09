use chrono::{Duration, Utc};
use keyring::Entry as KeyringEntry;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::commands::ApprovedRoots;

const GITHUB_HOST: &str = "github.com";
const GITHUB_KEYRING_SERVICE: &str = "at-terminal.github-auth";
const GITHUB_AUTH_EVENT: &str = "git-auth-updated";
const GITHUB_SCOPE: &str = "repo";

#[derive(Default, Clone)]
pub struct GitAuthState {
    attempts: Arc<Mutex<HashMap<String, GitHubAuthAttempt>>>,
}

#[derive(Debug, Clone)]
struct GitHubAuthAttempt {
    state_token: String,
    host: String,
    expires_at: chrono::DateTime<Utc>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusPayload {
    pub is_repo: bool,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub is_clean: bool,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub kind: String,
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPayload {
    pub path: String,
    pub staged: bool,
    pub patch: String,
    pub original_content: String,
    pub modified_content: String,
    pub original_path: String,
    pub modified_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub commit_hash: String,
    pub summary: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListPayload {
    pub current_branch: Option<String>,
    pub branches: Vec<GitBranchRef>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchRef {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_branch: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutResult {
    pub branch: String,
    pub repo_root: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncResult {
    pub branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub summary: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthStatus {
    pub remote_kind: String,
    pub gh_installed: bool,
    pub gh_authenticated: bool,
    pub git_credential_helper_configured: bool,
    pub username: Option<String>,
    pub message: Option<String>,
    pub next_action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gh_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gh_path_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gh_error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubOAuthStartResult {
    pub auth_attempt_id: String,
    pub browser_url: String,
    pub callback_url: String,
    pub expires_at: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhLaunchResult {
    pub started: bool,
    pub launched_in_terminal: bool,
    pub command: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhSetupGitResult {
    pub configured: bool,
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhInstallHelpPlatform {
    pub os: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GhInstallHelp {
    pub docs_url: String,
    pub platforms: Vec<GhInstallHelpPlatform>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashResult {
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    pub index: u32,
    pub branch: Option<String>,
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStashListResult {
    pub stashes: Vec<GitStashEntry>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteListResult {
    pub remotes: Vec<GitRemoteInfo>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_current: bool,
    pub is_main: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    pub is_prunable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable_reason: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeListResult {
    pub worktrees: Vec<GitWorktreeEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGitWorktreeRequest {
    pub branch_name: String,
    pub path: String,
    pub create_branch: Option<bool>,
    pub start_point: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResult {
    pub path: String,
    pub branch: String,
    pub repo_root: String,
    pub created_branch: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRemoveResult {
    pub path: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitAuthEventPayload {
    pub auth_attempt_id: String,
    pub status: String,
    pub username: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredGitHubCredential {
    username: String,
    token: String,
}

#[derive(Debug, Clone)]
struct GitHubOAuthConfig {
    client_id: String,
    client_secret: String,
}

#[derive(Debug, Clone)]
struct RemoteInfo {
    kind: RemoteKind,
    host: Option<String>,
}

#[derive(Debug, Clone)]
struct GhResolution {
    executable: OsString,
    path: Option<PathBuf>,
    source: &'static str,
    found: bool,
}

impl GhResolution {
    fn display_path(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
    }

    fn display_source(&self) -> Option<String> {
        self.found.then(|| self.source.to_string())
    }
}

#[derive(Debug, Default)]
struct ParsedGitWorktree {
    path: Option<String>,
    branch: Option<String>,
    head: Option<String>,
    is_detached: bool,
    is_locked: bool,
    is_prunable: bool,
    lock_reason: Option<String>,
    prunable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RemoteKind {
    None,
    GitHubHttps,
    GitHubSsh,
    OtherHttps,
    OtherSsh,
}

impl RemoteKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::GitHubHttps => "github_https",
            Self::GitHubSsh => "github_ssh",
            Self::OtherHttps => "other_https",
            Self::OtherSsh => "other_ssh",
        }
    }
}

#[derive(Debug, Deserialize)]
struct GitHubTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
}

#[tauri::command]
pub async fn get_git_status(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitStatusPayload, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || get_git_status_impl(root_directory)).await
}

#[tauri::command]
pub async fn get_git_auth_status(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitAuthStatus, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || get_git_auth_status_impl(root_directory)).await
}

#[tauri::command]
pub async fn launch_gh_auth_login(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GhLaunchResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || launch_gh_auth_login_impl(root_directory)).await
}

#[tauri::command]
pub async fn run_gh_auth_setup_git(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GhSetupGitResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || run_gh_auth_setup_git_impl(root_directory)).await
}

#[tauri::command]
pub async fn get_gh_install_help() -> Result<GhInstallHelp, String> {
    Ok(get_gh_install_help_impl())
}

#[tauri::command]
pub async fn start_github_oauth(
    app: AppHandle,
    roots: State<'_, ApprovedRoots>,
    auth_state: State<'_, GitAuthState>,
    root_directory: String,
) -> Result<GitHubOAuthStartResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    if remote_info.kind != RemoteKind::GitHubHttps {
        return Err("Browser auth is only available for github.com HTTPS remotes.".to_string());
    }

    let config = load_github_oauth_config()?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|err| format!("Failed to start GitHub auth callback server: {}", err))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to read GitHub auth callback port: {}", err))?
        .port();

    let auth_attempt_id = Uuid::new_v4().to_string();
    let state_token = Uuid::new_v4().to_string();
    let callback_url = format!("http://127.0.0.1:{}/github/callback", port);
    let expires_at = Utc::now() + Duration::minutes(10);
    let browser_url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope={}&state={}",
        percent_encode(&config.client_id),
        percent_encode(&callback_url),
        percent_encode(GITHUB_SCOPE),
        percent_encode(&state_token),
    );

    {
        let mut attempts = auth_state
            .attempts
            .lock()
            .map_err(|_| "Failed to prepare GitHub auth session.".to_string())?;
        attempts.insert(
            auth_attempt_id.clone(),
            GitHubAuthAttempt {
                state_token: state_token.clone(),
                host: GITHUB_HOST.to_string(),
                expires_at,
            },
        );
    }

    let shared_state = Arc::new(auth_state.inner().clone());
    let app_handle = app.clone();
    let attempt_id_for_thread = auth_attempt_id.clone();
    let callback_url_for_thread = callback_url.clone();
    let (tx, rx) = oneshot::channel::<()>();
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_for_thread = Arc::clone(&shutdown);
    let attempt_id_for_timeout = auth_attempt_id.clone();
    let app_handle_for_timeout = app.clone();
    let shared_state_for_timeout = Arc::clone(&shared_state);

    // The listener runs on a dedicated blocking thread with a true blocking
    // `accept()`. A shared `AtomicBool` is the only signal it polls between
    // iterations; we set it from the async side when the 10-minute expiry
    // elapses. The listener signals completion via the oneshot.
    let listener_join = tauri::async_runtime::spawn_blocking(move || {
        run_github_oauth_listener(
            listener,
            shared_state,
            app_handle,
            config,
            attempt_id_for_thread,
            callback_url_for_thread,
            expires_at,
            shutdown_for_thread,
            tx,
        );
    });

    // Wait for the callback to arrive or the 10-minute expiry to elapse.
    let timeout = tokio::time::Duration::from_secs(600);
    let timed_out = match tokio::time::timeout(timeout, rx).await {
        Ok(_) => false,
        Err(_) => {
            // Signal the listener thread to stop. If it has already exited
            // (callback completed and the oneshot sender was dropped), this
            // is a no-op.
            shutdown.store(true, Ordering::Relaxed);
            wake_github_oauth_listener(port);
            true
        }
    };

    // Always join the listener thread to make sure resources are cleaned up.
    let _ = listener_join.await;

    if timed_out {
        emit_auth_event(
            &app_handle_for_timeout,
            GitAuthEventPayload {
                auth_attempt_id: attempt_id_for_timeout.clone(),
                status: "error".to_string(),
                username: None,
                message: Some("GitHub login timed out. Try again.".to_string()),
            },
        );
        remove_auth_attempt(&shared_state_for_timeout, &attempt_id_for_timeout);
    }

    Ok(GitHubOAuthStartResult {
        auth_attempt_id,
        browser_url,
        callback_url,
        expires_at: expires_at.to_rfc3339(),
    })
}

#[tauri::command]
pub async fn disconnect_github_auth(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || disconnect_github_auth_impl(root_directory)).await
}

#[tauri::command]
pub async fn list_git_branches(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitBranchListPayload, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || list_git_branches_impl(root_directory)).await
}

#[tauri::command]
pub async fn checkout_git_branch(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    branch_name: String,
) -> Result<GitCheckoutResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || checkout_git_branch_impl(root_directory, branch_name)).await
}

#[tauri::command]
pub async fn create_git_branch(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    branch_name: String,
    checkout: Option<bool>,
    start_point: Option<String>,
) -> Result<GitCheckoutResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || create_git_branch_impl(root_directory, branch_name, checkout, start_point))
        .await
}

#[tauri::command]
pub async fn pull_git_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitSyncResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || pull_git_changes_impl(root_directory)).await
}

#[tauri::command]
pub async fn push_git_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitSyncResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || push_git_changes_impl(root_directory)).await
}

#[tauri::command]
pub async fn sync_git_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitSyncResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || sync_git_changes_impl(root_directory)).await
}

#[tauri::command]
pub async fn stage_git_paths(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || stage_git_paths_impl(root_directory, paths)).await
}

#[tauri::command]
pub async fn unstage_git_paths(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || unstage_git_paths_impl(root_directory, paths)).await
}

#[tauri::command]
pub async fn get_git_diff(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    path: String,
    staged: Option<bool>,
) -> Result<GitDiffPayload, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || get_git_diff_impl(root_directory, path, staged)).await
}

#[tauri::command]
pub async fn create_git_commit(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    message: String,
) -> Result<CommitResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || create_git_commit_impl(root_directory, message)).await
}

#[tauri::command]
pub async fn fetch_git_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitSyncResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || fetch_git_changes_impl(root_directory)).await
}

#[tauri::command]
pub async fn merge_git_branch_from_remote(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    remote: String,
    branch: String,
) -> Result<GitSyncResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || merge_git_branch_from_remote_impl(root_directory, remote, branch)).await
}

#[tauri::command]
pub async fn stage_git_all(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || stage_git_all_impl(root_directory)).await
}

#[tauri::command]
pub async fn unstage_git_all(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || unstage_git_all_impl(root_directory)).await
}

#[tauri::command]
pub async fn discard_git_all_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || discard_git_all_changes_impl(root_directory)).await
}

#[tauri::command]
pub async fn stash_git_changes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    message: Option<String>,
) -> Result<GitStashResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || stash_git_changes_impl(root_directory, message)).await
}

#[tauri::command]
pub async fn pop_git_stash(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    index: Option<u32>,
) -> Result<GitStashResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || pop_git_stash_impl(root_directory, index)).await
}

#[tauri::command]
pub async fn list_git_stashes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitStashListResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || list_git_stashes_impl(root_directory)).await
}

#[tauri::command]
pub async fn add_git_remote(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    name: String,
    url: String,
) -> Result<GitRemoteInfo, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || add_git_remote_impl(root_directory, name, url)).await
}

#[tauri::command]
pub async fn remove_git_remote(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    name: String,
) -> Result<(), String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || remove_git_remote_impl(root_directory, name)).await
}

#[tauri::command]
pub async fn list_git_remotes(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitRemoteListResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || list_git_remotes_impl(root_directory)).await
}

#[tauri::command]
pub async fn list_git_worktrees(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
) -> Result<GitWorktreeListResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || list_git_worktrees_impl(root_directory)).await
}

#[tauri::command]
pub async fn create_git_worktree(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    options: CreateGitWorktreeRequest,
) -> Result<GitWorktreeCreateResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    let result = run_git_task(move || create_git_worktree_impl(root_directory, options)).await?;
    roots.approve_root_path(&result.path)?;
    Ok(result)
}

#[tauri::command]
pub async fn remove_git_worktree(
    roots: State<'_, ApprovedRoots>,
    root_directory: String,
    worktree_path: String,
) -> Result<GitWorktreeRemoveResult, String> {
    let root_directory = approved_root_string(&roots, root_directory)?;
    run_git_task(move || remove_git_worktree_impl(root_directory, worktree_path)).await
}

fn get_git_status_impl(root_directory: String) -> Result<GitStatusPayload, String> {
    let root = canonical_root(&root_directory)?;
    let Some(repo_root) = detect_repo_root(&root)? else {
        return Ok(GitStatusPayload {
            is_repo: false,
            repo_root: None,
            branch: None,
            ahead: 0,
            behind: 0,
            is_clean: true,
            entries: Vec::new(),
        });
    };

    collect_git_status(&repo_root)
}

fn get_git_auth_status_impl(root_directory: String) -> Result<GitAuthStatus, String> {
    let root = canonical_root(&root_directory)?;
    let Some(repo_root) = detect_repo_root(&root)? else {
        return Ok(GitAuthStatus {
            remote_kind: RemoteKind::None.as_str().to_string(),
            gh_installed: false,
            gh_authenticated: false,
            git_credential_helper_configured: false,
            username: None,
            message: Some("Open a Git repository to connect GitHub auth.".to_string()),
            next_action: "none".to_string(),
            gh_path: None,
            gh_path_source: None,
            gh_error: None,
        });
    };

    let remote_info = resolve_remote_info(&repo_root)?;
    build_git_auth_status(&repo_root, &remote_info)
}

fn build_git_auth_status(
    repo_root: &Path,
    remote_info: &RemoteInfo,
) -> Result<GitAuthStatus, String> {
    match remote_info.kind {
        RemoteKind::GitHubHttps => {
            let gh_resolution = resolve_gh_executable();
            let gh_path = gh_resolution.display_path();
            let gh_path_source = gh_resolution.display_source();
            let gh_installed = is_gh_installed_with_resolution(&gh_resolution);
            let (gh_authenticated, username, gh_error) = if gh_installed {
                read_gh_auth_identity()
            } else {
                (
                    false,
                    None,
                    Some("GitHub CLI was not found in PATH or common install locations.".to_string()),
                )
            };
            let git_credential_helper_configured = if gh_installed {
                git_credential_helper_configured(repo_root)?
            } else {
                false
            };

            let (next_action, message) = if !gh_installed {
                (
                    "install-gh".to_string(),
                    Some("Install GitHub CLI to push and pull GitHub HTTPS remotes from AT-Terminal.".to_string()),
                )
            } else if !gh_authenticated {
                (
                    "login-gh".to_string(),
                    Some("Sign in with GitHub CLI to enable GitHub HTTPS push and pull.".to_string()),
                )
            } else if !git_credential_helper_configured {
                (
                    "setup-git".to_string(),
                    Some("Finish GitHub CLI Git setup so Git can use your GitHub CLI session.".to_string()),
                )
            } else {
                (
                    "ready".to_string(),
                    Some("GitHub CLI is ready for GitHub HTTPS push and pull.".to_string()),
                )
            };

            Ok(GitAuthStatus {
                remote_kind: remote_info.kind.as_str().to_string(),
                gh_installed,
                gh_authenticated,
                git_credential_helper_configured,
                username,
                message,
                next_action,
                gh_path,
                gh_path_source,
                gh_error,
            })
        }
        RemoteKind::GitHubSsh => Ok(GitAuthStatus {
            remote_kind: remote_info.kind.as_str().to_string(),
            gh_installed: is_gh_installed(),
            gh_authenticated: false,
            git_credential_helper_configured: false,
            username: None,
            message: Some(
                "This repo uses GitHub SSH. GitHub CLI HTTPS auth is not needed; use your SSH keys."
                    .to_string(),
            ),
            next_action: "unsupported".to_string(),
            gh_path: resolve_gh_executable().display_path(),
            gh_path_source: resolve_gh_executable().display_source(),
            gh_error: None,
        }),
        RemoteKind::OtherHttps => Ok(GitAuthStatus {
            remote_kind: remote_info.kind.as_str().to_string(),
            gh_installed: is_gh_installed(),
            gh_authenticated: false,
            git_credential_helper_configured: false,
            username: None,
            message: Some(
                "This repo uses a non-GitHub HTTPS remote. GitHub CLI setup in AT-Terminal currently supports github.com only."
                    .to_string(),
            ),
            next_action: "unsupported".to_string(),
            gh_path: resolve_gh_executable().display_path(),
            gh_path_source: resolve_gh_executable().display_source(),
            gh_error: None,
        }),
        RemoteKind::OtherSsh => Ok(GitAuthStatus {
            remote_kind: remote_info.kind.as_str().to_string(),
            gh_installed: is_gh_installed(),
            gh_authenticated: false,
            git_credential_helper_configured: false,
            username: None,
            message: Some(
                "This repo uses a non-GitHub SSH remote. Manage SSH credentials outside AT-Terminal."
                    .to_string(),
            ),
            next_action: "unsupported".to_string(),
            gh_path: resolve_gh_executable().display_path(),
            gh_path_source: resolve_gh_executable().display_source(),
            gh_error: None,
        }),
        RemoteKind::None => Ok(GitAuthStatus {
            remote_kind: remote_info.kind.as_str().to_string(),
            gh_installed: is_gh_installed(),
            gh_authenticated: false,
            git_credential_helper_configured: false,
            username: None,
            message: Some("No Git remote is configured for this repository.".to_string()),
            next_action: "none".to_string(),
            gh_path: resolve_gh_executable().display_path(),
            gh_path_source: resolve_gh_executable().display_source(),
            gh_error: None,
        }),
    }
}

fn disconnect_github_auth_impl(root_directory: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    let host = remote_info.host.unwrap_or_else(|| GITHUB_HOST.to_string());
    clear_github_credential(&host)
}

fn launch_gh_auth_login_impl(root_directory: String) -> Result<GhLaunchResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    if remote_info.kind != RemoteKind::GitHubHttps {
        return Err(
            "GitHub CLI sign-in is only available for github.com HTTPS remotes.".to_string(),
        );
    }
    if !is_gh_installed() {
        return Err("GitHub CLI is not installed.".to_string());
    }

    let fallback_command = gh_login_command();
    let mut command = gh_command();
    command.args([
        "auth",
        "login",
        "--web",
        "--hostname",
        GITHUB_HOST,
        "--git-protocol",
        "https",
    ]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match command.spawn() {
        Ok(_) => Ok(GhLaunchResult {
            started: true,
            launched_in_terminal: false,
            command: fallback_command,
            message: "GitHub CLI sign-in started. Complete the browser flow, then check again."
                .to_string(),
            fallback_reason: None,
        }),
        Err(err) => Ok(GhLaunchResult {
            started: false,
            launched_in_terminal: false,
            command: fallback_command,
            message: "GitHub CLI could not be started automatically. Run the copied fallback command in a terminal, then check again.".to_string(),
            fallback_reason: Some(err.to_string()),
        }),
    }
}

fn run_gh_auth_setup_git_impl(root_directory: String) -> Result<GhSetupGitResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    if remote_info.kind != RemoteKind::GitHubHttps {
        return Err(
            "GitHub CLI Git setup is only available for github.com HTTPS remotes.".to_string(),
        );
    }
    if !is_gh_installed() {
        return Err("Install GitHub CLI before finishing Git setup.".to_string());
    }
    let (authenticated, _, auth_error) = read_gh_auth_identity();
    if !authenticated {
        return Err(auth_error
            .unwrap_or_else(|| "Sign in with GitHub CLI before finishing Git setup.".to_string()));
    }

    let mut command = gh_command();
    command.args(["auth", "setup-git", "--hostname", GITHUB_HOST]);
    let output = run_process_output(
        &mut command,
        "GitHub CLI is not installed or is not available on PATH.",
    )?;
    if !output.status.success() {
        return Err(output_message(
            output,
            "Failed to configure Git with GitHub CLI.",
        ));
    }

    if !git_credential_helper_configured(&repo_root)? {
        return Err("GitHub CLI did not finish configuring Git credentials.".to_string());
    }

    Ok(GhSetupGitResult {
        configured: true,
        message: "GitHub CLI is now configured for Git in this repo.".to_string(),
    })
}

fn get_gh_install_help_impl() -> GhInstallHelp {
    GhInstallHelp {
        docs_url: "https://github.com/cli/cli#installation".to_string(),
        platforms: vec![
            GhInstallHelpPlatform {
                os: "macos".to_string(),
                title: "macOS".to_string(),
                recommended_command: Some("brew install gh".to_string()),
                notes: None,
                docs_url: None,
            },
            GhInstallHelpPlatform {
                os: "windows".to_string(),
                title: "Windows".to_string(),
                recommended_command: Some("winget install --id GitHub.cli --source winget".to_string()),
                notes: None,
                docs_url: None,
            },
            GhInstallHelpPlatform {
                os: "linux".to_string(),
                title: "Linux".to_string(),
                recommended_command: None,
                notes: Some("Install steps vary by distro. Open the official GitHub CLI install docs for the recommended package source.".to_string()),
                docs_url: Some("https://github.com/cli/cli/blob/trunk/docs/install_linux.md".to_string()),
            },
        ],
    }
}

fn list_git_branches_impl(root_directory: String) -> Result<GitBranchListPayload, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let status = collect_git_status(&repo_root)?;
    let branches = collect_branch_refs(&repo_root, status.branch.as_deref())?;

    Ok(GitBranchListPayload {
        current_branch: status.branch,
        branches,
    })
}

fn checkout_git_branch_impl(
    root_directory: String,
    branch_name: String,
) -> Result<GitCheckoutResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let branch_name = normalized_branch_name(&branch_name)?;

    let mut command = git_command(&repo_root);
    command.args(["checkout", &branch_name]);
    ensure_success(run_git_output(&mut command)?, "Failed to switch branches")?;

    Ok(GitCheckoutResult {
        branch: branch_name,
        repo_root: repo_root.to_string_lossy().to_string(),
    })
}

fn create_git_branch_impl(
    root_directory: String,
    branch_name: String,
    checkout: Option<bool>,
    start_point: Option<String>,
) -> Result<GitCheckoutResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let branch_name = normalized_branch_name(&branch_name)?;
    let start_point = start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let checkout = checkout.unwrap_or(true);
    let use_no_track = start_point
        .as_deref()
        .and_then(|value| {
            remote_start_point_local_name(&repo_root, value).map(|name| (value, name))
        })
        .is_some_and(|(_, remote_branch_name)| remote_branch_name != branch_name);

    let mut command = git_command(&repo_root);
    if checkout {
        command.arg("checkout");
        if use_no_track {
            command.arg("--no-track");
        }
        command.args(["-b", &branch_name]);
    } else {
        command.arg("branch");
        if use_no_track {
            command.arg("--no-track");
        }
        command.arg(&branch_name);
    }
    if let Some(start_point) = start_point.as_deref() {
        command.arg(start_point);
    }

    ensure_success(run_git_output(&mut command)?, "Failed to create branch")?;

    Ok(GitCheckoutResult {
        branch: branch_name,
        repo_root: repo_root.to_string_lossy().to_string(),
    })
}

fn pull_git_changes_impl(root_directory: String) -> Result<GitSyncResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    let mut command = git_command(&repo_root);
    command.args(["pull", "--ff-only"]);

    ensure_network_command_success(
        run_network_git_output(&repo_root, &remote_info, &mut command)?,
        "Pull failed",
        &remote_info,
    )?;
    build_sync_result(&repo_root, "Pull complete")
}

fn push_git_changes_impl(root_directory: String) -> Result<GitSyncResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let (remote_info, mut command, summary) = prepare_push_command(&repo_root)?;

    ensure_network_command_success(
        run_network_git_output(&repo_root, &remote_info, &mut command)?,
        "Push failed",
        &remote_info,
    )?;
    build_sync_result(&repo_root, &summary)
}

fn prepare_push_command(repo_root: &Path) -> Result<(RemoteInfo, Command, String), String> {
    let status = collect_git_status(repo_root)?;
    let current_branch = status.branch.clone();

    if let Some(branch_name) = current_branch.as_deref() {
        let (upstream_remote, upstream_branch) = branch_upstream_details(repo_root, branch_name)?;
        let publish_remote = upstream_remote
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty());
        let upstream_matches_current = upstream_branch
            .as_deref()
            .map(str::trim)
            .is_some_and(|name| name == branch_name);

        if let Some(remote_name) = publish_remote.filter(|_| upstream_matches_current) {
            let remote_info = resolve_remote_info_for_name(repo_root, &remote_name)?;
            let mut command = git_command(repo_root);
            command.arg("push");
            return Ok((remote_info, command, "Push complete".to_string()));
        }

        let remote_name = publish_remote
            .map(ToOwned::to_owned)
            .unwrap_or(select_default_remote_name(repo_root)?);
        let remote_info = resolve_remote_info_for_name(repo_root, &remote_name)?;
        let mut command = git_command(repo_root);
        command.args(["push", "--set-upstream", &remote_name, branch_name]);
        return Ok((
            remote_info,
            command,
            format!("Published {} to {}.", branch_name, remote_name),
        ));
    }

    let remote_info = resolve_remote_info(repo_root)?;
    let mut command = git_command(repo_root);
    command.arg("push");
    Ok((remote_info, command, "Push complete".to_string()))
}

fn sync_git_changes_impl(root_directory: String) -> Result<GitSyncResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;

    let mut pull_command = git_command(&repo_root);
    pull_command.args(["pull", "--ff-only"]);
    ensure_network_command_success(
        run_network_git_output(&repo_root, &remote_info, &mut pull_command)?,
        "Sync failed during pull",
        &remote_info,
    )?;

    let (push_remote_info, mut push_command, push_summary) = prepare_push_command(&repo_root)?;
    ensure_network_command_success(
        run_network_git_output(&repo_root, &push_remote_info, &mut push_command)?,
        "Sync failed during push",
        &push_remote_info,
    )?;

    let summary = if push_summary.starts_with("Published ") {
        format!("Sync complete. {}", push_summary)
    } else {
        "Sync complete".to_string()
    };
    build_sync_result(&repo_root, &summary)
}

fn stage_git_paths_impl(root_directory: String, paths: Vec<String>) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let relative_paths = relative_git_paths(&repo_root, &paths)?;

    let mut command = git_command(&repo_root);
    command
        .arg("add")
        .arg("--")
        .args(relative_paths.iter().map(String::as_str));
    ensure_success(run_git_output(&mut command)?, "Failed to stage files")
}

fn unstage_git_paths_impl(root_directory: String, paths: Vec<String>) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let relative_paths = relative_git_paths(&repo_root, &paths)?;

    if git_has_head(&repo_root)? {
        let mut command = git_command(&repo_root);
        command
            .arg("reset")
            .arg("-q")
            .arg("HEAD")
            .arg("--")
            .args(relative_paths.iter().map(String::as_str));
        ensure_success(run_git_output(&mut command)?, "Failed to unstage files")
    } else {
        let mut command = git_command(&repo_root);
        command
            .arg("rm")
            .arg("--cached")
            .arg("-r")
            .arg("--")
            .args(relative_paths.iter().map(String::as_str));
        ensure_success(run_git_output(&mut command)?, "Failed to unstage files")
    }
}

fn get_git_diff_impl(
    root_directory: String,
    path: String,
    staged: Option<bool>,
) -> Result<GitDiffPayload, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let staged = staged.unwrap_or(false);
    let relative_path = relative_git_path(&repo_root, &path)?;
    let absolute_path = repo_root.join(&relative_path);

    let mut command = git_command(&repo_root);
    command.arg("diff").arg("--no-ext-diff");
    if staged {
        command.arg("--cached");
    }
    command.arg("--").arg(&relative_path);

    let output = run_git_output(&mut command)?;
    let mut patch = if output.status.success() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        return Err(output_message(output, "Failed to load git diff"));
    };

    if patch.trim().is_empty() && !staged && is_untracked(&repo_root, &relative_path)? {
        let absolute_path = repo_root.join(&relative_path);
        let mut no_index_command = git_command(&repo_root);
        no_index_command
            .arg("diff")
            .arg("--no-index")
            .arg("--no-ext-diff")
            .arg("--")
            .arg("/dev/null")
            .arg(&absolute_path);
        let output = run_git_output(&mut no_index_command)?;
        if output.status.success() || output.status.code() == Some(1) {
            patch = String::from_utf8_lossy(&output.stdout).to_string();
        } else {
            return Err(output_message(output, "Failed to load untracked file diff"));
        }
    }

    if patch.trim().is_empty() {
        return Err("Git returned no textual diff for this file.".to_string());
    }

    let status_entry = collect_git_status(&repo_root)?
        .entries
        .into_iter()
        .find(|entry| entry.path == absolute_path.to_string_lossy() && entry.staged == staged);
    let old_path = status_entry
        .as_ref()
        .and_then(|entry| entry.old_path.clone());
    let original_path = old_path
        .clone()
        .unwrap_or_else(|| absolute_path.to_string_lossy().to_string());
    let modified_path = absolute_path.to_string_lossy().to_string();
    let kind = status_entry
        .as_ref()
        .map(|entry| entry.kind.as_str())
        .unwrap_or("modified");
    let has_head = git_has_head(&repo_root)?;
    let original_content = read_git_diff_side(
        &repo_root,
        GitDiffSide {
            relative_path: old_path
                .as_deref()
                .map(|value| relative_git_path(&repo_root, value))
                .transpose()?
                .unwrap_or_else(|| relative_path.clone()),
            current_relative_path: relative_path.clone(),
            staged,
            kind: kind.to_string(),
            side: DiffSideKind::Original,
            has_head,
        },
    )?;
    let modified_content = read_git_diff_side(
        &repo_root,
        GitDiffSide {
            relative_path: relative_path.clone(),
            current_relative_path: relative_path.clone(),
            staged,
            kind: kind.to_string(),
            side: DiffSideKind::Modified,
            has_head,
        },
    )?;

    Ok(GitDiffPayload {
        path: modified_path.clone(),
        staged,
        patch,
        original_content,
        modified_content,
        original_path,
        modified_path,
        old_path,
    })
}

#[derive(Clone, Copy)]
enum DiffSideKind {
    Original,
    Modified,
}

struct GitDiffSide {
    relative_path: String,
    current_relative_path: String,
    staged: bool,
    kind: String,
    side: DiffSideKind,
    has_head: bool,
}

fn read_git_diff_side(repo_root: &Path, request: GitDiffSide) -> Result<String, String> {
    match (request.staged, request.kind.as_str(), request.side) {
        (false, "untracked", DiffSideKind::Original) => Ok(String::new()),
        (false, "untracked", DiffSideKind::Modified) => {
            read_working_tree_file(repo_root, &request.current_relative_path)
        }
        (false, "deleted", DiffSideKind::Original) => {
            read_git_revision_file(repo_root, &request.relative_path, GitFileSource::Index)
        }
        (false, "deleted", DiffSideKind::Modified) => Ok(String::new()),
        (false, _, DiffSideKind::Original) => {
            read_git_revision_file(repo_root, &request.relative_path, GitFileSource::Index)
        }
        (false, _, DiffSideKind::Modified) => {
            read_working_tree_file(repo_root, &request.current_relative_path)
        }
        (true, "added", DiffSideKind::Original) => Ok(String::new()),
        (true, "untracked", DiffSideKind::Original) => Ok(String::new()),
        (true, "deleted", DiffSideKind::Modified) => Ok(String::new()),
        (true, _, DiffSideKind::Original) if !request.has_head => Ok(String::new()),
        (true, _, DiffSideKind::Original) => {
            read_git_revision_file(repo_root, &request.relative_path, GitFileSource::Head)
        }
        (true, _, DiffSideKind::Modified) => read_git_revision_file(
            repo_root,
            &request.current_relative_path,
            GitFileSource::Index,
        ),
    }
}

enum GitFileSource {
    Head,
    Index,
}

fn read_git_revision_file(
    repo_root: &Path,
    relative_path: &str,
    source: GitFileSource,
) -> Result<String, String> {
    let spec = match source {
        GitFileSource::Head => format!("HEAD:{relative_path}"),
        GitFileSource::Index => format!(":{relative_path}"),
    };
    let mut command = git_command(repo_root);
    command.args(["show", &spec]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn read_working_tree_file(repo_root: &Path, relative_path: &str) -> Result<String, String> {
    let path = repo_root.join(relative_path);
    match fs::read(&path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!(
            "Failed to read working tree file {}: {}",
            path.to_string_lossy(),
            err
        )),
    }
}

fn create_git_commit_impl(root_directory: String, message: String) -> Result<CommitResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    let status = collect_git_status(&repo_root)?;
    if !status.entries.iter().any(|entry| entry.staged) {
        return Err("Stage at least one change before committing.".to_string());
    }

    let mut command = git_command(&repo_root);
    command.arg("commit").arg("-m").arg(trimmed);
    ensure_success(run_git_output(&mut command)?, "Failed to create commit")?;

    let commit_hash = read_git_stdout(
        &repo_root,
        ["rev-parse", "HEAD"],
        "Failed to read commit hash",
    )?;
    let summary = read_git_stdout(
        &repo_root,
        ["log", "-1", "--pretty=%s"],
        "Failed to read commit summary",
    )?;

    Ok(CommitResult {
        commit_hash,
        summary,
    })
}

fn fetch_git_changes_impl(root_directory: String) -> Result<GitSyncResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    let mut command = git_command(&repo_root);
    command.arg("fetch");

    ensure_network_command_success(
        run_network_git_output(&repo_root, &remote_info, &mut command)?,
        "Fetch failed",
        &remote_info,
    )?;
    build_sync_result(&repo_root, "Fetch complete")
}

fn merge_git_branch_from_remote_impl(
    root_directory: String,
    remote: String,
    branch: String,
) -> Result<GitSyncResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let remote_info = resolve_remote_info(&repo_root)?;
    let trimmed_remote = remote.trim().to_string();
    let normalized_branch = normalize_pull_branch_arg(&branch, &trimmed_remote);
    if normalized_branch.trim().is_empty() {
        return Err("Choose a branch to merge into the current branch.".to_string());
    }

    let mut fetch_command = git_command(&repo_root);
    fetch_command
        .arg("fetch")
        .arg(&trimmed_remote)
        .arg(&normalized_branch);

    ensure_network_command_success(
        run_network_git_output(&repo_root, &remote_info, &mut fetch_command)?,
        "Failed to fetch the branch to merge",
        &remote_info,
    )?;

    let mut merge_command = git_command(&repo_root);
    merge_command.args(["merge", "--no-edit", "FETCH_HEAD"]);
    let merge_output = run_git_output(&mut merge_command)?;
    if !merge_output.status.success() {
        return Err(classify_merge_failure(
            &repo_root,
            merge_output,
            "Failed to merge the selected branch into the current branch.",
        ));
    }

    build_sync_result(
        &repo_root,
        &format!(
            "Merged {} from {} into the current branch.",
            normalized_branch, trimmed_remote
        ),
    )
}

fn normalize_pull_branch_arg(branch: &str, remote: &str) -> String {
    let trimmed_branch = branch.trim();
    let remote_prefix = format!("{}/", remote.trim());
    trimmed_branch
        .strip_prefix(&remote_prefix)
        .unwrap_or(trimmed_branch)
        .to_string()
}

fn classify_merge_failure(repo_root: &Path, output: Output, fallback: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = if stdout.is_empty() {
        stderr.clone()
    } else if stderr.is_empty() {
        stdout.clone()
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    if combined.contains("CONFLICT") || git_status_has_conflicts(repo_root).unwrap_or(false) {
        return "Merge resulted in conflicts. Resolve the conflicts, commit the result, then push if needed.".to_string();
    }

    if git_merge_in_progress(repo_root).unwrap_or(false) {
        return "Merge stopped before completion. Finish resolving the merge in this checkout, then commit or abort it before continuing.".to_string();
    }

    if !stderr.is_empty() {
        return stderr;
    }

    if !stdout.is_empty() {
        return stdout;
    }

    fallback.to_string()
}

fn git_status_has_conflicts(repo_root: &Path) -> Result<bool, String> {
    Ok(collect_git_status(repo_root)?
        .entries
        .iter()
        .any(|entry| entry.kind == "conflicted"))
}

fn git_merge_in_progress(repo_root: &Path) -> Result<bool, String> {
    git_ref_exists(repo_root, "MERGE_HEAD")
}

fn git_ref_exists(repo_root: &Path, ref_name: &str) -> Result<bool, String> {
    let mut command = git_command(repo_root);
    command.args(["rev-parse", "--verify", "-q", ref_name]);
    let output = run_git_output(&mut command)?;
    Ok(output.status.success())
}

fn stage_git_all_impl(root_directory: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let mut command = git_command(&repo_root);
    command.args(["add", "-A"]);
    ensure_success(run_git_output(&mut command)?, "Failed to stage all files")
}

fn unstage_git_all_impl(root_directory: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;

    if git_has_head(&repo_root)? {
        let mut command = git_command(&repo_root);
        command.args(["reset", "-q", "HEAD"]);
        ensure_success(run_git_output(&mut command)?, "Failed to unstage all files")
    } else {
        let mut command = git_command(&repo_root);
        command.args(["rm", "--cached", "-r", "."]);
        ensure_success(run_git_output(&mut command)?, "Failed to unstage all files")
    }
}

fn discard_git_all_changes_impl(root_directory: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;

    // Discard all tracked changes
    let mut checkout_command = git_command(&repo_root);
    checkout_command.args(["checkout", "--", "."]);
    let checkout_output = run_git_output(&mut checkout_command)?;
    // checkout may return non-zero if there are no tracked changes to discard,
    // but we still want to clean untracked files, so don't fail here.

    // Remove untracked files and directories
    let mut clean_command = git_command(&repo_root);
    clean_command.args(["clean", "-fd"]);
    ensure_success(
        run_git_output(&mut clean_command)?,
        "Failed to clean untracked files",
    )?;

    // Verify checkout succeeded if there were tracked changes
    if !checkout_output.status.success() {
        let stderr = String::from_utf8_lossy(&checkout_output.stderr)
            .trim()
            .to_string();
        if !stderr.is_empty() && !stderr.contains("did not match any file") {
            return Err(format!("Failed to discard tracked changes: {}", stderr));
        }
    }

    Ok(())
}

fn stash_git_changes_impl(
    root_directory: String,
    message: Option<String>,
) -> Result<GitStashResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let mut command = git_command(&repo_root);
    command.args(["stash", "push"]);
    if let Some(msg) = message.as_deref() {
        if !msg.trim().is_empty() {
            command.args(["-m", msg.trim()]);
        }
    }

    let output = run_git_output(&mut command)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        return Err(output_message(output, "Failed to stash changes"));
    }

    // git stash push outputs "No local changes to save" when there's nothing to stash
    if stdout.contains("No local changes to save") || stderr.contains("No local changes to save") {
        return Ok(GitStashResult {
            message: "No local changes to save.".to_string(),
        });
    }

    Ok(GitStashResult {
        message: if stdout.is_empty() { stderr } else { stdout },
    })
}

fn pop_git_stash_impl(
    root_directory: String,
    index: Option<u32>,
) -> Result<GitStashResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let mut command = git_command(&repo_root);
    command.args(["stash", "pop"]);
    if let Some(idx) = index {
        command.arg(format!("stash@{{{}}}", idx));
    }

    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        // Stash pop can fail with conflicts; provide useful error message
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if combined.contains("CONFLICT") {
            return Err(
                "Stash pop resulted in conflicts. Resolve the conflicts and commit the result."
                    .to_string(),
            );
        }
        return Err(output_message(output, "Failed to pop stash"));
    }

    Ok(GitStashResult {
        message: String::from_utf8_lossy(&output.stdout).trim().to_string(),
    })
}

fn list_git_stashes_impl(root_directory: String) -> Result<GitStashListResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let lines = read_git_stdout_lines(&repo_root, ["stash", "list"], "Failed to list stashes")?;

    let mut stashes = Vec::new();
    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Format: stash@{0}: On main: message
        // Or: stash@{0}: WIP on main: abc1234 message
        let stash = parse_stash_line(trimmed);
        stashes.push(stash);
    }

    Ok(GitStashListResult { stashes })
}

fn parse_stash_line(line: &str) -> GitStashEntry {
    // Format: stash@{N}: On branch: message  OR  stash@{N}: WIP on branch: hash msg
    let index_end = line.find('}').unwrap_or(0);
    let index_str = line
        .get(..index_end)
        .and_then(|s| s.strip_prefix("stash@{"))
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let message_part = line.find(": ").map(|pos| &line[pos + 2..]).unwrap_or("");

    // Try to extract branch: "On branch: msg" -> branch, "WIP on branch: hash msg" -> branch
    let branch = if let Some(rest) = message_part.strip_prefix("On ") {
        rest.split(':').next().map(|b| b.trim().to_string())
    } else if let Some(rest) = message_part.strip_prefix("WIP on ") {
        rest.split(':').next().map(|b| b.trim().to_string())
    } else {
        None
    };

    let message = message_part.to_string();

    GitStashEntry {
        index: index_str,
        branch,
        message,
    }
}

fn add_git_remote_impl(
    root_directory: String,
    name: String,
    url: String,
) -> Result<GitRemoteInfo, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let name_trimmed = name.trim();
    let url_trimmed = url.trim();

    if name_trimmed.is_empty() {
        return Err("Remote name cannot be empty.".to_string());
    }
    if url_trimmed.is_empty() {
        return Err("Remote URL cannot be empty.".to_string());
    }

    let mut command = git_command(&repo_root);
    command.args(["remote", "add", name_trimmed, url_trimmed]);
    ensure_success(run_git_output(&mut command)?, "Failed to add remote")?;

    Ok(GitRemoteInfo {
        name: name_trimmed.to_string(),
        url: url_trimmed.to_string(),
    })
}

fn remove_git_remote_impl(root_directory: String, name: String) -> Result<(), String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let mut command = git_command(&repo_root);
    command.args(["remote", "remove", &name]);
    ensure_success(run_git_output(&mut command)?, "Failed to remove remote")
}

fn list_git_remotes_impl(root_directory: String) -> Result<GitRemoteListResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    Ok(GitRemoteListResult {
        remotes: collect_git_remotes(&repo_root)?,
    })
}

fn list_git_worktrees_impl(root_directory: String) -> Result<GitWorktreeListResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    Ok(GitWorktreeListResult {
        worktrees: collect_git_worktrees(&repo_root)?,
    })
}

fn create_git_worktree_impl(
    root_directory: String,
    options: CreateGitWorktreeRequest,
) -> Result<GitWorktreeCreateResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let branch_name = normalized_branch_name(&options.branch_name)?;
    let create_branch = options.create_branch.unwrap_or(true);
    let start_point = options
        .start_point
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if !create_branch && start_point.is_some() {
        return Err("Start point is only available when creating a new branch.".to_string());
    }

    let worktree_path = resolve_worktree_destination(&repo_root, &options.path)?;
    if worktree_path.exists() {
        return Err("Choose a new destination path for the worktree.".to_string());
    }

    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to prepare the worktree folder: {}", err))?;
    }

    let mut command = git_command(&repo_root);
    command.arg("worktree").arg("add");

    if create_branch {
        command.args(["-b", &branch_name]);
        command.arg(&worktree_path);
        if let Some(start_point) = start_point.as_deref() {
            command.arg(start_point);
        }
    } else {
        command.arg(&worktree_path).arg(&branch_name);
    }

    ensure_success(run_git_output(&mut command)?, "Failed to create worktree")?;

    Ok(GitWorktreeCreateResult {
        path: display_path(&worktree_path),
        branch: branch_name,
        repo_root: repo_root.to_string_lossy().to_string(),
        created_branch: create_branch,
    })
}

fn remove_git_worktree_impl(
    root_directory: String,
    worktree_path: String,
) -> Result<GitWorktreeRemoveResult, String> {
    let repo_root = resolve_repo_root(&root_directory)?;
    let worktrees = collect_git_worktrees(&repo_root)?;
    let target = worktrees
        .into_iter()
        .find(|worktree| paths_match(Path::new(&worktree.path), Path::new(worktree_path.trim())))
        .ok_or_else(|| "That worktree is not linked to this repository.".to_string())?;

    if target.is_main {
        return Err("The main checkout cannot be removed as a worktree.".to_string());
    }

    let mut command = git_command(&repo_root);
    command.arg("worktree").arg("remove").arg(&target.path);
    ensure_success(run_git_output(&mut command)?, "Failed to remove worktree")?;

    Ok(GitWorktreeRemoveResult { path: target.path })
}

fn collect_git_remotes(repo_root: &Path) -> Result<Vec<GitRemoteInfo>, String> {
    let mut command = git_command(&repo_root);
    command.args(["remote", "-v"]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        // No remotes is not an error
        if String::from_utf8_lossy(&output.stderr)
            .to_lowercase()
            .contains("not a git repository")
        {
            return Err("Not a Git repository.".to_string());
        }
        return Ok(Vec::new());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut seen_names = std::collections::HashSet::new();
    let mut remotes = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Format: "origin\thttps://github.com/user/repo.git (fetch)" or "origin  https://... (push)"
        let without_suffix = trimmed
            .strip_suffix("(fetch)")
            .or_else(|| trimmed.strip_suffix("(push)"))
            .unwrap_or(trimmed)
            .trim();

        // Split on whitespace or tab between name and URL
        let mut parts = without_suffix.splitn(2, |c: char| c == '\t' || c == ' ');
        let name = parts.next().unwrap_or("").trim().to_string();
        let url = parts.next().unwrap_or("").trim().to_string();

        if name.is_empty() || url.is_empty() {
            continue;
        }
        if seen_names.contains(&name) {
            continue;
        }
        seen_names.insert(name.clone());
        remotes.push(GitRemoteInfo { name, url });
    }

    Ok(remotes)
}

fn collect_git_worktrees(current_worktree_root: &Path) -> Result<Vec<GitWorktreeEntry>, String> {
    let mut command = git_command(current_worktree_root);
    command.args(["worktree", "list", "--porcelain"]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Err(output_message(output, "Failed to read Git worktrees"));
    }

    let current_worktree_root = display_path(current_worktree_root);
    let main_worktree_root = resolve_main_worktree_root(Path::new(&current_worktree_root))?;
    let mut parsed = Vec::new();
    let mut current = ParsedGitWorktree::default();

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            if current.path.is_some() {
                parsed.push(current);
                current = ParsedGitWorktree::default();
            }
            continue;
        }

        if let Some(path) = trimmed.strip_prefix("worktree ") {
            if current.path.is_some() {
                parsed.push(current);
                current = ParsedGitWorktree::default();
            }
            current.path = Some(path.to_string());
            continue;
        }

        if let Some(head) = trimmed.strip_prefix("HEAD ") {
            current.head = Some(head.to_string());
            continue;
        }

        if let Some(branch) = trimmed.strip_prefix("branch ") {
            current.branch = Some(short_branch_name(branch));
            continue;
        }

        if trimmed == "detached" {
            current.is_detached = true;
            continue;
        }

        if let Some(reason) = trimmed.strip_prefix("locked") {
            current.is_locked = true;
            current.lock_reason = optional_reason(reason);
            continue;
        }

        if let Some(reason) = trimmed.strip_prefix("prunable") {
            current.is_prunable = true;
            current.prunable_reason = optional_reason(reason);
        }
    }

    if current.path.is_some() {
        parsed.push(current);
    }

    let mut main_marked = false;
    let mut worktrees = parsed
        .into_iter()
        .filter_map(|worktree| {
            let path = worktree.path?;
            let is_main = main_worktree_root
                .as_deref()
                .is_some_and(|main_root| paths_match(Path::new(&path), main_root));
            if is_main {
                main_marked = true;
            }

            Some(GitWorktreeEntry {
                is_current: paths_match(Path::new(&path), Path::new(&current_worktree_root)),
                is_main,
                path,
                branch: worktree.branch,
                head: worktree.head.unwrap_or_default(),
                is_detached: worktree.is_detached,
                is_locked: worktree.is_locked,
                is_prunable: worktree.is_prunable,
                lock_reason: worktree.lock_reason,
                prunable_reason: worktree.prunable_reason,
            })
        })
        .collect::<Vec<_>>();

    if !main_marked {
        if let Some(first) = worktrees.first_mut() {
            first.is_main = true;
        }
    }

    Ok(worktrees)
}

fn resolve_worktree_destination(repo_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let trimmed = requested_path.trim();
    if trimmed.is_empty() {
        return Err("Worktree destination cannot be empty.".to_string());
    }

    let path = PathBuf::from(trimmed);
    Ok(if path.is_absolute() {
        path
    } else {
        repo_root.join(path)
    })
}

fn resolve_main_worktree_root(repo_root: &Path) -> Result<Option<PathBuf>, String> {
    let mut command = git_command(repo_root);
    command.args(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Ok(None);
    }

    let common_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if common_dir.is_empty() {
        return Ok(None);
    }

    let common_dir = PathBuf::from(common_dir);
    if common_dir.file_name() == Some(OsStr::new(".git")) {
        return Ok(common_dir.parent().map(Path::to_path_buf));
    }

    Ok(None)
}

fn short_branch_name(branch_ref: &str) -> String {
    branch_ref
        .trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(branch_ref.trim())
        .to_string()
}

fn optional_reason(reason: &str) -> Option<String> {
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn display_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn paths_match(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
}

fn normalized_path(path: &Path) -> String {
    display_path(path)
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

async fn run_git_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("Git task failed: {}", err))?
}

fn approved_root_string(roots: &ApprovedRoots, root_directory: String) -> Result<String, String> {
    Ok(roots
        .ensure_root_approved(root_directory)?
        .to_string_lossy()
        .to_string())
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

fn resolve_repo_root(root_directory: &str) -> Result<PathBuf, String> {
    let root = canonical_root(root_directory)?;
    detect_repo_root(&root)?.ok_or_else(|| "Not a Git repository.".to_string())
}

fn detect_repo_root(root: &Path) -> Result<Option<PathBuf>, String> {
    let mut command = git_command(root);
    command.args(["rev-parse", "--show-toplevel"]);
    let output = run_git_output(&mut command)?;

    if output.status.success() {
        let repo_root = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if repo_root.is_empty() {
            return Err("Git did not return a repository root.".to_string());
        }
        return Ok(Some(PathBuf::from(repo_root)));
    }

    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    if stderr.contains("not a git repository") {
        return Ok(None);
    }

    Err(output_message(output, "Failed to resolve Git repository"))
}

fn load_github_oauth_config() -> Result<GitHubOAuthConfig, String> {
    let client_id = std::env::var("AT_TERMINAL_GITHUB_OAUTH_CLIENT_ID")
        .or_else(|_| std::env::var("GITHUB_OAUTH_CLIENT_ID"))
        .map_err(|_| "GitHub browser auth is not configured.".to_string())?;
    let client_secret = std::env::var("AT_TERMINAL_GITHUB_OAUTH_CLIENT_SECRET")
        .or_else(|_| std::env::var("GITHUB_OAUTH_CLIENT_SECRET"))
        .map_err(|_| "GitHub browser auth is not configured.".to_string())?;

    if client_id.trim().is_empty() || client_secret.trim().is_empty() {
        return Err("GitHub browser auth is not configured.".to_string());
    }

    Ok(GitHubOAuthConfig {
        client_id,
        client_secret,
    })
}

#[allow(dead_code)]
fn load_github_credential(host: &str) -> Result<StoredGitHubCredential, String> {
    let entry = KeyringEntry::new(GITHUB_KEYRING_SERVICE, host)
        .map_err(|err| format!("Failed to access secure GitHub storage: {}", err))?;
    let value = entry
        .get_password()
        .map_err(|_| "No saved GitHub credential.".to_string())?;
    serde_json::from_str(&value)
        .map_err(|err| format!("Failed to read saved GitHub credential: {}", err))
}

fn save_github_credential(host: &str, credential: &StoredGitHubCredential) -> Result<(), String> {
    let entry = KeyringEntry::new(GITHUB_KEYRING_SERVICE, host)
        .map_err(|err| format!("Failed to access secure GitHub storage: {}", err))?;
    let value = serde_json::to_string(credential)
        .map_err(|err| format!("Failed to save GitHub credential: {}", err))?;
    entry
        .set_password(&value)
        .map_err(|err| format!("Failed to save GitHub credential: {}", err))
}

fn clear_github_credential(host: &str) -> Result<(), String> {
    let entry = KeyringEntry::new(GITHUB_KEYRING_SERVICE, host)
        .map_err(|err| format!("Failed to access secure GitHub storage: {}", err))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(err) => {
            let message = err.to_string();
            if message.contains("No entry found") || message.contains("no matching entry found") {
                Ok(())
            } else {
                Err(format!("Failed to clear GitHub credential: {}", err))
            }
        }
    }
}

fn run_github_oauth_listener(
    listener: TcpListener,
    auth_state: Arc<GitAuthState>,
    app: AppHandle,
    config: GitHubOAuthConfig,
    auth_attempt_id: String,
    callback_url: String,
    expires_at: chrono::DateTime<Utc>,
    shutdown: Arc<AtomicBool>,
    completion: oneshot::Sender<()>,
) {
    let client = Client::builder()
        .timeout(StdDuration::from_secs(20))
        .build();
    let client = match client {
        Ok(client) => client,
        Err(err) => {
            emit_auth_event(
                &app,
                GitAuthEventPayload {
                    auth_attempt_id: auth_attempt_id.clone(),
                    status: "error".to_string(),
                    username: None,
                    message: Some(format!("Failed to create GitHub auth client: {}", err)),
                },
            );
            remove_auth_attempt(&auth_state, &auth_attempt_id);
            let _ = completion.send(());
            return;
        }
    };

    let result: Result<String, String> = (|| {
        loop {
            if shutdown.load(Ordering::Relaxed) {
                return Err("GitHub auth callback server cancelled.".to_string());
            }
            if Utc::now() > expires_at {
                return Err("GitHub login timed out. Try again.".to_string());
            }

            // Blocking accept; the OS will park this thread until a connection
            // arrives. No more 200ms busy-wait.
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if shutdown.load(Ordering::Relaxed) {
                        return Err("GitHub auth callback server cancelled.".to_string());
                    }
                    let mut buffer = [0_u8; 4096];
                    let _ = stream.read(&mut buffer);
                    let request = String::from_utf8_lossy(&buffer).to_string();
                    let first_line = request.lines().next().unwrap_or_default();
                    let result = if let Some(query) = extract_query_from_request_line(first_line) {
                        complete_github_oauth(
                            &client,
                            &auth_state,
                            &config,
                            &auth_attempt_id,
                            &callback_url,
                            query,
                        )
                    } else {
                        Err("GitHub returned an invalid callback URL.".to_string())
                    };

                    match result {
                        Ok(username) => {
                            let _ = write_http_response(&mut stream, success_auth_html());
                            emit_auth_event(
                                &app,
                                GitAuthEventPayload {
                                    auth_attempt_id: auth_attempt_id.clone(),
                                    status: "success".to_string(),
                                    username: Some(username.clone()),
                                    message: Some("GitHub connected.".to_string()),
                                },
                            );
                            return Ok(username);
                        }
                        Err(message) => {
                            let _ = write_http_response(&mut stream, error_auth_html(&message));
                            emit_auth_event(
                                &app,
                                GitAuthEventPayload {
                                    auth_attempt_id: auth_attempt_id.clone(),
                                    status: "error".to_string(),
                                    username: None,
                                    message: Some(message.clone()),
                                },
                            );
                            return Err(message);
                        }
                    }
                }
                Err(err) => {
                    return Err(format!("GitHub auth callback server failed: {}", err));
                }
            }
        }
    })();

    if let Err(message) = result {
        // Only emit a "timed out" event if the listener itself noticed the
        // shutdown or expiry. The async-side timeout case is handled in
        // `start_github_oauth` and we don't want to double-emit.
        if message == "GitHub login timed out. Try again.".to_string() {
            emit_auth_event(
                &app,
                GitAuthEventPayload {
                    auth_attempt_id: auth_attempt_id.clone(),
                    status: "error".to_string(),
                    username: None,
                    message: Some(message),
                },
            );
        } else if message == "GitHub auth callback server cancelled.".to_string() {
            // Cancellation: the async side will emit the timeout event.
        } else {
            emit_auth_event(
                &app,
                GitAuthEventPayload {
                    auth_attempt_id: auth_attempt_id.clone(),
                    status: "error".to_string(),
                    username: None,
                    message: Some(message),
                },
            );
        }
    }
    remove_auth_attempt(&auth_state, &auth_attempt_id);
    let _ = completion.send(());
}

fn wake_github_oauth_listener(port: u16) {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
        let _ = stream.write_all(b"GET /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    }
}

fn complete_github_oauth(
    client: &Client,
    auth_state: &Arc<GitAuthState>,
    config: &GitHubOAuthConfig,
    auth_attempt_id: &str,
    callback_url: &str,
    query: &str,
) -> Result<String, String> {
    let params = parse_query_string(query);
    if let Some(error) = params.get("error") {
        let description = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone());
        return Err(format!("GitHub login was not completed: {}", description));
    }

    let code = params
        .get("code")
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| "GitHub did not return an authorization code.".to_string())?;
    let state = params
        .get("state")
        .cloned()
        .ok_or_else(|| "GitHub did not return a state token.".to_string())?;

    let attempt = auth_state
        .attempts
        .lock()
        .map_err(|_| "Failed to read GitHub auth session.".to_string())?
        .get(auth_attempt_id)
        .cloned()
        .ok_or_else(|| "This GitHub login session is no longer available.".to_string())?;
    if Utc::now() > attempt.expires_at {
        return Err("GitHub login timed out. Try again.".to_string());
    }
    if state != attempt.state_token {
        return Err("GitHub login could not be verified. Please try again.".to_string());
    }

    let token_response = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("User-Agent", "AT-Terminal")
        .form(&[
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", callback_url),
            ("state", state.as_str()),
        ])
        .send()
        .map_err(|err| format!("Failed to complete GitHub login: {}", err))?;
    let token_payload = token_response
        .json::<GitHubTokenResponse>()
        .map_err(|err| format!("Failed to decode GitHub login response: {}", err))?;
    if let Some(error) = token_payload.error {
        let details = token_payload.error_description.unwrap_or(error);
        return Err(format!("GitHub login failed: {}", details));
    }
    let token = token_payload
        .access_token
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "GitHub did not return an access token.".to_string())?;

    let user_response = client
        .get("https://api.github.com/user")
        .header("Accept", "application/json")
        .header("User-Agent", "AT-Terminal")
        .bearer_auth(&token)
        .send()
        .map_err(|err| format!("Failed to read GitHub account info: {}", err))?;
    let user = user_response
        .json::<GitHubUserResponse>()
        .map_err(|err| format!("Failed to decode GitHub account info: {}", err))?;

    save_github_credential(
        &attempt.host,
        &StoredGitHubCredential {
            username: user.login.clone(),
            token,
        },
    )?;

    Ok(user.login)
}

fn emit_auth_event(app: &AppHandle, payload: GitAuthEventPayload) {
    let _ = app.emit(GITHUB_AUTH_EVENT, payload);
}

fn remove_auth_attempt(auth_state: &Arc<GitAuthState>, auth_attempt_id: &str) {
    if let Ok(mut attempts) = auth_state.attempts.lock() {
        attempts.remove(auth_attempt_id);
    }
}

fn extract_query_from_request_line(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    let _method = parts.next()?;
    let target = parts.next()?;
    let (_, query) = target.split_once('?')?;
    Some(query)
}

fn parse_query_string(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let (key, value) = segment.split_once('=').unwrap_or((segment, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

fn percent_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn percent_decode(value: &str) -> String {
    let value = value.replace('+', " ");
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(hex);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).to_string()
}

fn write_http_response(stream: &mut impl Write, body: String) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|err| format!("Failed to respond to GitHub auth callback: {}", err))
}

fn success_auth_html() -> String {
    "<!doctype html><html><body style=\"font-family: sans-serif; background: #09090b; color: #f4f4f5; display:flex; align-items:center; justify-content:center; min-height:100vh;\"><div><h2>GitHub connected</h2><p>You can return to AT-Terminal now.</p></div></body></html>".to_string()
}

fn error_auth_html(message: &str) -> String {
    format!(
        "<!doctype html><html><body style=\"font-family: sans-serif; background: #09090b; color: #f4f4f5; display:flex; align-items:center; justify-content:center; min-height:100vh;\"><div><h2>GitHub login failed</h2><p>{}</p></div></body></html>",
        html_escape(message)
    )
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn collect_git_status(repo_root: &Path) -> Result<GitStatusPayload, String> {
    let mut command = git_command(repo_root);
    command.args([
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "-z",
    ]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Err(output_message(output, "Failed to read git status"));
    }

    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut entries = Vec::new();
    let mut records = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());

    while let Some(record_bytes) = records.next() {
        let record = String::from_utf8_lossy(record_bytes).to_string();
        match record.chars().next() {
            Some('#') => parse_branch_header(&record, &mut branch, &mut ahead, &mut behind),
            Some('1') => parse_changed_record(&record, repo_root, &mut entries)?,
            Some('2') => {
                let old_path = records
                    .next()
                    .map(|bytes| String::from_utf8_lossy(bytes).to_string());
                parse_renamed_record(&record, old_path, repo_root, &mut entries)?;
            }
            Some('u') => parse_conflicted_record(&record, repo_root, &mut entries)?,
            Some('?') => parse_untracked_record(&record, repo_root, &mut entries),
            Some('!') | None => {}
            Some(_) => {}
        }
    }

    Ok(GitStatusPayload {
        is_repo: true,
        repo_root: Some(repo_root.to_string_lossy().to_string()),
        branch,
        ahead,
        behind,
        is_clean: entries.is_empty(),
        entries,
    })
}

fn resolve_remote_info(repo_root: &Path) -> Result<RemoteInfo, String> {
    let remotes = collect_git_remotes(repo_root)?;
    if let Some(origin) = remotes.iter().find(|remote| remote.name == "origin") {
        return resolve_remote_info_for_name(repo_root, &origin.name);
    }

    if let Some(first_remote) = remotes.first() {
        return resolve_remote_info_for_name(repo_root, &first_remote.name);
    }

    Ok(RemoteInfo {
        kind: RemoteKind::None,
        host: None,
    })
}

fn resolve_remote_info_for_name(repo_root: &Path, remote_name: &str) -> Result<RemoteInfo, String> {
    let mut command = git_command(repo_root);
    command.args(["remote", "get-url", remote_name]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("no such remote") {
            return Ok(RemoteInfo {
                kind: RemoteKind::None,
                host: None,
            });
        }
        return Err(output_message(output, "Failed to read Git remote"));
    }

    Ok(classify_remote_url(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn select_default_remote_name(repo_root: &Path) -> Result<String, String> {
    let remotes = collect_git_remotes(repo_root)?;
    if let Some(origin) = remotes.iter().find(|remote| remote.name == "origin") {
        return Ok(origin.name.clone());
    }

    if let Some(first_remote) = remotes.first() {
        return Ok(first_remote.name.clone());
    }

    Err("No Git remotes are configured for this repository.".to_string())
}

fn classify_remote_url(remote_url: &str) -> RemoteInfo {
    let normalized = remote_url.trim();
    if normalized.is_empty() {
        return RemoteInfo {
            kind: RemoteKind::None,
            host: None,
        };
    }

    if let Some(rest) = normalized.strip_prefix("https://") {
        let host = rest.split('/').next().unwrap_or_default().to_string();
        return RemoteInfo {
            kind: if host.eq_ignore_ascii_case(GITHUB_HOST) {
                RemoteKind::GitHubHttps
            } else {
                RemoteKind::OtherHttps
            },
            host: Some(host),
        };
    }

    if let Some(rest) = normalized.strip_prefix("http://") {
        let host = rest.split('/').next().unwrap_or_default().to_string();
        return RemoteInfo {
            kind: RemoteKind::OtherHttps,
            host: Some(host),
        };
    }

    if let Some(host_part) = normalized.split('@').nth(1) {
        let host = host_part
            .split([':', '/'])
            .next()
            .unwrap_or_default()
            .to_string();
        return RemoteInfo {
            kind: if host.eq_ignore_ascii_case(GITHUB_HOST) {
                RemoteKind::GitHubSsh
            } else {
                RemoteKind::OtherSsh
            },
            host: Some(host),
        };
    }

    if let Some(rest) = normalized.strip_prefix("ssh://") {
        let host = rest
            .split('@')
            .nth(1)
            .unwrap_or(rest)
            .split('/')
            .next()
            .unwrap_or_default()
            .to_string();
        return RemoteInfo {
            kind: if host.eq_ignore_ascii_case(GITHUB_HOST) {
                RemoteKind::GitHubSsh
            } else {
                RemoteKind::OtherSsh
            },
            host: Some(host),
        };
    }

    RemoteInfo {
        kind: RemoteKind::OtherHttps,
        host: None,
    }
}

fn is_gh_installed() -> bool {
    let resolution = resolve_gh_executable();
    is_gh_installed_with_resolution(&resolution)
}

fn is_gh_installed_with_resolution(resolution: &GhResolution) -> bool {
    if !resolution.found {
        return false;
    }

    let mut command = gh_command_from_resolution(resolution);
    command.arg("--version");
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn read_gh_auth_identity() -> (bool, Option<String>, Option<String>) {
    let mut command = gh_command();
    command.args(["auth", "status", "--hostname", GITHUB_HOST]);
    match command.output() {
        Ok(output) => {
            if !output.status.success() {
                return (
                    false,
                    None,
                    Some(output_message(output, "GitHub CLI is not signed in.")),
                );
            }
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            (true, parse_gh_username(&combined), None)
        }
        Err(err) => (
            false,
            None,
            Some(format!("Failed to run GitHub CLI: {}", err)),
        ),
    }
}

fn parse_gh_username(text: &str) -> Option<String> {
    for line in text.lines() {
        let normalized = line.trim();
        let marker = "Logged in to github.com account ";
        if let Some(rest) = normalized
            .find(marker)
            .map(|index| &normalized[index + marker.len()..])
        {
            let username = rest
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .trim_matches(|ch: char| ch == '(' || ch == ')' || ch == ',');
            if !username.is_empty() {
                return Some(username.to_string());
            }
        }
    }
    None
}

fn git_credential_helper_configured(repo_root: &Path) -> Result<bool, String> {
    // Check per-host credential.https://github.com.helper config (gh auth setup-git sets this)
    let mut command = git_command(repo_root);
    command.args([
        "config",
        "--get-all",
        "credential.https://github.com.helper",
    ]);
    let output = run_git_output(&mut command)?;
    if output.status.success() {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if combined
            .lines()
            .map(str::trim)
            .any(is_usable_github_credential_helper)
        {
            return Ok(true);
        }
    }

    // Check global credential.helper config
    let mut command = git_command(repo_root);
    command.args(["config", "--get-all", "credential.helper"]);
    let output = run_git_output(&mut command)?;
    if output.status.success() {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if combined
            .lines()
            .map(str::trim)
            .any(is_usable_github_credential_helper)
        {
            return Ok(true);
        }
    }

    Ok(false)
}

fn is_usable_github_credential_helper(line: &str) -> bool {
    let normalized = line.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }

    normalized.contains("gh auth git-credential")
        || normalized.contains("gh.exe") && normalized.contains("auth git-credential")
        || cfg!(windows) && matches!(normalized.as_str(), "manager" | "manager-core")
}

fn gh_login_command() -> String {
    let executable = resolve_gh_executable();
    #[cfg(windows)]
    if executable.path.is_some() && Path::new(&executable.executable).is_absolute() {
        let executable = powershell_single_quoted(&executable.executable.to_string_lossy());
        return format!(
            "powershell.exe -NoProfile -Command \"& {} auth login --web --hostname {} --git-protocol https\"",
            executable, GITHUB_HOST
        );
    }

    #[cfg(not(windows))]
    if executable.path.is_some() && Path::new(&executable.executable).is_absolute() {
        let executable = shell_single_quoted(&executable.executable.to_string_lossy());
        return format!(
            "{} auth login --web --hostname {} --git-protocol https",
            executable, GITHUB_HOST
        );
    }

    format!(
        "gh auth login --web --hostname {} --git-protocol https",
        GITHUB_HOST
    )
}

#[cfg(windows)]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(not(windows))]
fn shell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn gh_command() -> Command {
    gh_command_from_resolution(&resolve_gh_executable())
}

fn gh_command_from_resolution(resolution: &GhResolution) -> Command {
    Command::new(&resolution.executable)
}

fn resolve_gh_executable() -> GhResolution {
    if let Some(path) = find_executable_on_path("gh") {
        return GhResolution {
            executable: path.as_os_str().to_os_string(),
            path: Some(path),
            source: "PATH",
            found: true,
        };
    }

    for dir in common_gh_install_dirs() {
        for name in gh_executable_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return GhResolution {
                    executable: candidate.as_os_str().to_os_string(),
                    path: Some(candidate),
                    source: "common-install-dir",
                    found: true,
                };
            }
        }
    }

    GhResolution {
        executable: OsString::from("gh"),
        path: None,
        source: "unresolved",
        found: false,
    }
}

fn find_executable_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;

    #[cfg(windows)]
    let extensions: Vec<OsString> = env::var_os("PATHEXT")
        .map(|value| {
            env::split_paths(&value)
                .map(|path| path.as_os_str().to_os_string())
                .collect()
        })
        .filter(|values: &Vec<OsString>| !values.is_empty())
        .unwrap_or_else(|| {
            [".COM", ".EXE", ".BAT", ".CMD"]
                .iter()
                .map(OsString::from)
                .collect()
        });

    for dir in env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }

        #[cfg(windows)]
        {
            for extension in &extensions {
                let candidate = dir.join(format!("{}{}", name, extension.to_string_lossy()));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[cfg(windows)]
fn gh_executable_names() -> &'static [&'static str] {
    &["gh.exe", "gh"]
}

#[cfg(not(windows))]
fn gh_executable_names() -> &'static [&'static str] {
    &["gh"]
}

#[cfg(windows)]
fn common_gh_install_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(program_files) = env::var_os("ProgramFiles") {
        dirs.push(PathBuf::from(program_files).join("GitHub CLI"));
    }

    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        dirs.push(PathBuf::from(program_files_x86).join("GitHub CLI"));
    }

    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local_app_data).join("GitHub CLI"));
    }

    dirs
}

#[cfg(not(windows))]
fn common_gh_install_dirs() -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
        "/var/lib/flatpak/exports/bin",
        "/usr/local/sbin",
        "/usr/sbin",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

fn collect_branch_refs(
    repo_root: &Path,
    current_branch: Option<&str>,
) -> Result<Vec<GitBranchRef>, String> {
    let mut branches = collect_branch_group(repo_root, false)?;
    let remotes = collect_branch_group(repo_root, true)?;

    if let Some(current_branch) = current_branch {
        for branch in &mut branches {
            branch.is_current = branch.name == current_branch;
        }
    }

    branches.sort_by(|left, right| {
        right
            .is_current
            .cmp(&left.is_current)
            .then_with(|| left.name.cmp(&right.name))
    });
    branches.extend(remotes);
    Ok(branches)
}

fn collect_branch_group(repo_root: &Path, remote: bool) -> Result<Vec<GitBranchRef>, String> {
    let format = if remote {
        "%(refname:short)"
    } else {
        "%(refname:short)\t%(HEAD)\t%(committerdate:unix)"
    };

    let args = if remote {
        vec![
            "for-each-ref",
            "--sort=-committerdate",
            "--format",
            format,
            "refs/remotes",
        ]
    } else {
        vec!["for-each-ref", "--format", format, "refs/heads"]
    };

    let output = read_git_stdout_lines(repo_root, args, "Failed to list branches")?;
    let mut branches = Vec::new();

    for line in output {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if remote {
            if trimmed.ends_with("/HEAD") {
                continue;
            }

            branches.push(GitBranchRef {
                name: trimmed.to_string(),
                is_current: false,
                is_remote: true,
                last_commit_timestamp: None,
                upstream_remote: None,
                upstream_branch: None,
            });
            continue;
        }

        let mut parts = trimmed.splitn(3, '\t');
        let name = parts.next().unwrap_or("").trim();
        let head_marker = parts.next().unwrap_or("").trim();
        let last_commit_timestamp = parts
            .next()
            .and_then(|value| value.trim().parse::<i64>().ok());
        if name.is_empty() {
            continue;
        }

        let (upstream_remote, upstream_branch) = branch_upstream_details(repo_root, name)?;
        branches.push(GitBranchRef {
            name: name.to_string(),
            is_current: head_marker == "*",
            is_remote: false,
            last_commit_timestamp,
            upstream_remote,
            upstream_branch,
        });
    }

    Ok(branches)
}

fn branch_upstream_details(
    repo_root: &Path,
    branch_name: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let remote = read_git_optional_stdout(
        repo_root,
        ["config", "--get", &format!("branch.{}.remote", branch_name)],
        "Failed to read branch upstream remote",
    )?;
    let merge_ref = read_git_optional_stdout(
        repo_root,
        ["config", "--get", &format!("branch.{}.merge", branch_name)],
        "Failed to read branch upstream branch",
    )?;

    let upstream_branch = merge_ref.and_then(|value| {
        value
            .trim()
            .strip_prefix("refs/heads/")
            .map(ToOwned::to_owned)
            .or_else(|| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
    });

    Ok((remote, upstream_branch))
}

fn remote_start_point_local_name(repo_root: &Path, start_point: &str) -> Option<String> {
    let trimmed = start_point.trim();
    if trimmed.is_empty() {
        return None;
    }

    let remotes = collect_git_remotes(repo_root).ok()?;
    let matched_remote = remotes
        .iter()
        .find(|remote| trimmed.starts_with(&format!("{}/", remote.name)))?;

    trimmed
        .strip_prefix(&format!("{}/", matched_remote.name))
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
}

fn build_sync_result(repo_root: &Path, summary: &str) -> Result<GitSyncResult, String> {
    let status = collect_git_status(repo_root)?;
    Ok(GitSyncResult {
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        summary: summary.to_string(),
    })
}

fn normalized_branch_name(branch_name: &str) -> Result<String, String> {
    let trimmed = branch_name.trim();
    if trimmed.is_empty() {
        return Err("Branch name cannot be empty.".to_string());
    }

    let mut command = Command::new("git");
    command.args(["check-ref-format", "--branch", trimmed]);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Err(output_message(output, "Invalid branch name."));
    }

    Ok(trimmed.to_string())
}

fn parse_branch_header(
    record: &str,
    branch: &mut Option<String>,
    ahead: &mut u32,
    behind: &mut u32,
) {
    if let Some(head) = record.strip_prefix("# branch.head ") {
        *branch = Some(if head == "(detached)" {
            "detached".to_string()
        } else {
            head.to_string()
        });
        return;
    }

    if let Some(ab) = record.strip_prefix("# branch.ab ") {
        for token in ab.split_whitespace() {
            if let Some(value) = token.strip_prefix('+') {
                *ahead = value.parse().unwrap_or(0);
            } else if let Some(value) = token.strip_prefix('-') {
                *behind = value.parse().unwrap_or(0);
            }
        }
    }
}

fn parse_changed_record(
    record: &str,
    repo_root: &Path,
    entries: &mut Vec<GitStatusEntry>,
) -> Result<(), String> {
    let mut fields = record.splitn(9, ' ');
    fields.next();
    let xy = fields.next().unwrap_or("..");
    for _ in 0..6 {
        fields.next();
    }
    let path = fields.next().unwrap_or("");
    if path.is_empty() {
        return Ok(());
    }

    let absolute_path = repo_root.join(path).to_string_lossy().to_string();
    push_status_entry(
        entries,
        &absolute_path,
        None,
        xy.chars().next().unwrap_or('.'),
        true,
    );
    push_status_entry(
        entries,
        &absolute_path,
        None,
        xy.chars().nth(1).unwrap_or('.'),
        false,
    );
    Ok(())
}

fn parse_renamed_record(
    record: &str,
    old_path: Option<String>,
    repo_root: &Path,
    entries: &mut Vec<GitStatusEntry>,
) -> Result<(), String> {
    let mut fields = record.splitn(10, ' ');
    fields.next();
    let xy = fields.next().unwrap_or("..");
    for _ in 0..7 {
        fields.next();
    }
    let path = fields.next().unwrap_or("");
    if path.is_empty() {
        return Ok(());
    }

    let absolute_path = repo_root.join(path).to_string_lossy().to_string();
    let absolute_old_path = old_path
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|value| repo_root.join(value).to_string_lossy().to_string());
    push_status_entry(
        entries,
        &absolute_path,
        absolute_old_path.clone(),
        xy.chars().next().unwrap_or('.'),
        true,
    );
    push_status_entry(
        entries,
        &absolute_path,
        absolute_old_path,
        xy.chars().nth(1).unwrap_or('.'),
        false,
    );
    Ok(())
}

fn parse_conflicted_record(
    record: &str,
    repo_root: &Path,
    entries: &mut Vec<GitStatusEntry>,
) -> Result<(), String> {
    let mut fields = record.splitn(11, ' ');
    fields.next();
    fields.next();
    for _ in 0..8 {
        fields.next();
    }
    let path = fields.next().unwrap_or("");
    if path.is_empty() {
        return Ok(());
    }

    entries.push(GitStatusEntry {
        path: repo_root.join(path).to_string_lossy().to_string(),
        kind: "conflicted".to_string(),
        staged: false,
        old_path: None,
    });
    Ok(())
}

fn parse_untracked_record(record: &str, repo_root: &Path, entries: &mut Vec<GitStatusEntry>) {
    let path = record.strip_prefix("? ").unwrap_or("");
    if path.is_empty() {
        return;
    }

    entries.push(GitStatusEntry {
        path: repo_root.join(path).to_string_lossy().to_string(),
        kind: "untracked".to_string(),
        staged: false,
        old_path: None,
    });
}

fn push_status_entry(
    entries: &mut Vec<GitStatusEntry>,
    path: &str,
    old_path: Option<String>,
    status_code: char,
    staged: bool,
) {
    if status_code == '.' {
        return;
    }

    entries.push(GitStatusEntry {
        path: path.to_string(),
        kind: status_kind(status_code).to_string(),
        staged,
        old_path,
    });
}

fn status_kind(status_code: char) -> &'static str {
    match status_code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "conflicted",
        '?' => "untracked",
        _ => "modified",
    }
}

fn relative_git_paths(repo_root: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Select at least one path.".to_string());
    }
    paths
        .iter()
        .map(|path| relative_git_path(repo_root, path))
        .collect()
}

fn relative_git_path(repo_root: &Path, path: &str) -> Result<String, String> {
    let requested = Path::new(path);
    if requested.is_absolute() {
        let relative = requested
            .strip_prefix(repo_root)
            .map_err(|_| "Path is outside the Git repository.".to_string())?;
        Ok(path_for_git(relative))
    } else {
        Ok(path.replace('\\', "/"))
    }
}

fn path_for_git(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn git_has_head(repo_root: &Path) -> Result<bool, String> {
    let mut command = git_command(repo_root);
    command.args(["rev-parse", "--verify", "HEAD"]);
    let output = run_git_output(&mut command)?;
    Ok(output.status.success())
}

fn is_untracked(repo_root: &Path, relative_path: &str) -> Result<bool, String> {
    let mut command = git_command(repo_root);
    command
        .args(["ls-files", "--others", "--exclude-standard", "--"])
        .arg(relative_path);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Err(output_message(
            output,
            "Failed to inspect git status for file",
        ));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn read_git_stdout<I, S>(repo_root: &Path, args: I, fallback: &str) -> Result<String, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(repo_root);
    command.args(args);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Err(output_message(output, fallback));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn read_git_optional_stdout<I, S>(
    repo_root: &Path,
    args: I,
    _fallback: &str,
) -> Result<Option<String>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(repo_root);
    command.args(args);
    let output = run_git_output(&mut command)?;
    if !output.status.success() {
        return Ok(None);
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }

    Ok(Some(value))
}

fn read_git_stdout_lines<I, S>(
    repo_root: &Path,
    args: I,
    fallback: &str,
) -> Result<Vec<String>, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Ok(read_git_stdout(repo_root, args, fallback)?
        .lines()
        .map(|line| line.to_string())
        .collect())
}

fn git_command(cwd: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(cwd);
    command
}

fn run_network_git_output(
    repo_root: &Path,
    remote_info: &RemoteInfo,
    command: &mut Command,
) -> Result<Output, String> {
    command.env("GIT_TERMINAL_PROMPT", "0");

    match remote_info.kind {
        RemoteKind::GitHubHttps => {
            let auth_status = build_git_auth_status(repo_root, remote_info)?;
            match auth_status.next_action.as_str() {
                "install-gh" => {
                    return Err(
                        "Install GitHub CLI to continue with GitHub HTTPS push and pull."
                            .to_string(),
                    )
                }
                "login-gh" => {
                    return Err(
                        "Sign in with GitHub CLI to continue with GitHub HTTPS push and pull."
                            .to_string(),
                    )
                }
                "setup-git" => {
                    return Err(
                        "Finish GitHub CLI Git setup to continue with GitHub HTTPS push and pull."
                            .to_string(),
                    )
                }
                _ => {}
            }
            prepend_gh_parent_to_path(command);
        }
        RemoteKind::OtherHttps => {
            return Err(
                "This repo uses a non-GitHub HTTPS remote. GitHub CLI setup in AT-Terminal currently supports github.com only."
                    .to_string(),
            );
        }
        _ => {}
    }

    run_git_output(command)
}

fn prepend_gh_parent_to_path(command: &mut Command) {
    let resolution = resolve_gh_executable();
    let Some(parent) = resolution.path.as_deref().and_then(Path::parent) else {
        return;
    };

    let mut paths = vec![parent.to_path_buf()];
    if let Some(existing) = env::var_os("PATH") {
        paths.extend(env::split_paths(&existing));
    }

    if let Ok(joined) = env::join_paths(paths) {
        command.env("PATH", joined);
    }
}

fn ensure_network_command_success(
    output: Output,
    fallback: &str,
    remote_info: &RemoteInfo,
) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }

    let message = output_message(output, fallback);
    if remote_info.kind == RemoteKind::GitHubHttps && looks_like_auth_failure(&message) {
        return Err(
            "GitHub CLI authentication was rejected. Sign in with GitHub CLI again and retry."
                .to_string(),
        );
    }

    Err(message)
}

fn looks_like_auth_failure(message: &str) -> bool {
    let lowercase = message.to_lowercase();
    lowercase.contains("authentication failed")
        || lowercase.contains("invalid username or password")
        || lowercase.contains("http basic")
        || lowercase.contains("could not read username")
        || lowercase.contains("repository not found")
        || lowercase.contains("403")
}

fn run_git_output(command: &mut Command) -> Result<Output, String> {
    run_process_output(command, "Git is not installed or is not available on PATH.")
}

fn run_process_output(command: &mut Command, not_found_message: &str) -> Result<Output, String> {
    command.output().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            not_found_message.to_string()
        } else {
            format!("Failed to run command: {}", err)
        }
    })
}

fn ensure_success(output: Output, fallback: &str) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(output_message(output, fallback))
    }
}

fn output_message(output: Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            fallback.to_string()
        } else {
            stdout
        }
    } else {
        stderr
    }
}
