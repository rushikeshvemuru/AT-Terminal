import { invoke } from "@tauri-apps/api/core";
import type {
  CommitResult,
  CreateGitWorktreeOptions,
  GhInstallHelp,
  GhLaunchResult,
  GhSetupGitResult,
  GitAuthStatus,
  GitBranchListPayload,
  GitCheckoutResult,
  GitDiffPayload,
  GitRemoteInfo,
  GitRemoteListResult,
  GitStashListResult,
  GitStashResult,
  GitStatusPayload,
  GitSyncResult,
  GitWorktreeCreateResult,
  GitWorktreeListResult,
  GitWorktreeRemoveResult,
} from "@/types/git";

export function getGitStatus(rootDirectory: string): Promise<GitStatusPayload> {
  return invoke<GitStatusPayload>("get_git_status", { rootDirectory });
}

export function getGitAuthStatus(rootDirectory: string): Promise<GitAuthStatus> {
  return invoke<GitAuthStatus>("get_git_auth_status", { rootDirectory });
}

export function launchGhAuthLogin(rootDirectory: string): Promise<GhLaunchResult> {
  return invoke<GhLaunchResult>("launch_gh_auth_login", { rootDirectory });
}

export function runGhAuthSetupGit(rootDirectory: string): Promise<GhSetupGitResult> {
  return invoke<GhSetupGitResult>("run_gh_auth_setup_git", { rootDirectory });
}

export function getGhInstallHelp(): Promise<GhInstallHelp> {
  return invoke<GhInstallHelp>("get_gh_install_help");
}

export function listGitBranches(rootDirectory: string): Promise<GitBranchListPayload> {
  return invoke<GitBranchListPayload>("list_git_branches", { rootDirectory });
}

export function checkoutGitBranch(
  rootDirectory: string,
  branchName: string,
): Promise<GitCheckoutResult> {
  return invoke<GitCheckoutResult>("checkout_git_branch", { rootDirectory, branchName });
}

export function createGitBranch(
  rootDirectory: string,
  branchName: string,
  options?: { checkout?: boolean; startPoint?: string | null },
): Promise<GitCheckoutResult> {
  return invoke<GitCheckoutResult>("create_git_branch", {
    rootDirectory,
    branchName,
    checkout: options?.checkout ?? true,
    startPoint: options?.startPoint ?? null,
  });
}

export function pullGitChanges(rootDirectory: string): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("pull_git_changes", { rootDirectory });
}

export function pushGitChanges(rootDirectory: string): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("push_git_changes", { rootDirectory });
}

export function syncGitChanges(rootDirectory: string): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("sync_git_changes", { rootDirectory });
}

export function stageGitPaths(rootDirectory: string, paths: string[]): Promise<void> {
  return invoke<void>("stage_git_paths", { rootDirectory, paths });
}

export function unstageGitPaths(rootDirectory: string, paths: string[]): Promise<void> {
  return invoke<void>("unstage_git_paths", { rootDirectory, paths });
}

export function getGitDiff(
  rootDirectory: string,
  path: string,
  staged?: boolean,
): Promise<GitDiffPayload> {
  return invoke<GitDiffPayload>("get_git_diff", { rootDirectory, path, staged: staged ?? false });
}

export function createGitCommit(rootDirectory: string, message: string): Promise<CommitResult> {
  return invoke<CommitResult>("create_git_commit", { rootDirectory, message });
}

export function fetchGitChanges(rootDirectory: string): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("fetch_git_changes", { rootDirectory });
}

export function mergeGitBranchFromRemote(
  rootDirectory: string,
  remote: string,
  branch: string,
): Promise<GitSyncResult> {
  return invoke<GitSyncResult>("merge_git_branch_from_remote", {
    rootDirectory,
    remote,
    branch,
  });
}

export function stageGitAll(rootDirectory: string): Promise<void> {
  return invoke<void>("stage_git_all", { rootDirectory });
}

export function unstageGitAll(rootDirectory: string): Promise<void> {
  return invoke<void>("unstage_git_all", { rootDirectory });
}

export function discardGitAllChanges(rootDirectory: string): Promise<void> {
  return invoke<void>("discard_git_all_changes", { rootDirectory });
}

export function stashGitChanges(rootDirectory: string, message?: string): Promise<GitStashResult> {
  return invoke<GitStashResult>("stash_git_changes", {
    rootDirectory,
    message: message ?? null,
  });
}

export function popGitStash(rootDirectory: string, index?: number): Promise<GitStashResult> {
  return invoke<GitStashResult>("pop_git_stash", { rootDirectory, index: index ?? null });
}

export function listGitStashes(rootDirectory: string): Promise<GitStashListResult> {
  return invoke<GitStashListResult>("list_git_stashes", { rootDirectory });
}

export function addGitRemote(
  rootDirectory: string,
  name: string,
  url: string,
): Promise<GitRemoteInfo> {
  return invoke<GitRemoteInfo>("add_git_remote", { rootDirectory, name, url });
}

export function removeGitRemote(rootDirectory: string, name: string): Promise<void> {
  return invoke<void>("remove_git_remote", { rootDirectory, name });
}

export function listGitRemotes(rootDirectory: string): Promise<GitRemoteListResult> {
  return invoke<GitRemoteListResult>("list_git_remotes", { rootDirectory });
}

export function listGitWorktrees(rootDirectory: string): Promise<GitWorktreeListResult> {
  return invoke<GitWorktreeListResult>("list_git_worktrees", { rootDirectory });
}

export function createGitWorktree(
  rootDirectory: string,
  options: CreateGitWorktreeOptions,
): Promise<GitWorktreeCreateResult> {
  return invoke<GitWorktreeCreateResult>("create_git_worktree", { rootDirectory, options });
}

export function removeGitWorktree(
  rootDirectory: string,
  worktreePath: string,
): Promise<GitWorktreeRemoveResult> {
  return invoke<GitWorktreeRemoveResult>("remove_git_worktree", { rootDirectory, worktreePath });
}
