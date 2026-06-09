export type GitEntryKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface GitStatusEntry {
  path: string;
  kind: GitEntryKind;
  staged: boolean;
  oldPath?: string | null;
}

export interface GitStatusPayload {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  entries: GitStatusEntry[];
}

export interface GitDiffPayload {
  path: string;
  staged: boolean;
  patch: string;
  originalContent: string;
  modifiedContent: string;
  originalPath: string;
  modifiedPath: string;
  oldPath?: string | null;
}

export interface CommitResult {
  commitHash: string;
  summary: string;
}

export interface GitBranchRef {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommitTimestamp?: number | null;
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
}

export interface GitBranchListPayload {
  currentBranch: string | null;
  branches: GitBranchRef[];
}

export interface GitCheckoutResult {
  branch: string;
  repoRoot: string;
}

export interface GitSyncResult {
  branch: string | null;
  ahead: number;
  behind: number;
  summary: string;
}

export type GitRemoteKind = "github_https" | "github_ssh" | "other_https" | "other_ssh" | "none";

export type GitAuthNextAction =
  | "install-gh"
  | "login-gh"
  | "setup-git"
  | "ready"
  | "unsupported"
  | "none";

export interface GitAuthStatus {
  remoteKind: GitRemoteKind;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  gitCredentialHelperConfigured: boolean;
  username: string | null;
  message: string | null;
  nextAction: GitAuthNextAction;
  ghPath?: string | null;
  ghPathSource?: string | null;
  ghError?: string | null;
}

export interface GhLaunchResult {
  started: boolean;
  launchedInTerminal: boolean;
  command: string;
  message: string;
  fallbackReason?: string | null;
}

export interface GhSetupGitResult {
  configured: boolean;
  message: string;
}

export interface GhInstallHelpPlatform {
  os: string;
  title: string;
  recommendedCommand?: string | null;
  notes?: string | null;
  docsUrl?: string | null;
}

export interface GhInstallHelp {
  docsUrl: string;
  platforms: GhInstallHelpPlatform[];
}

export interface GitStashResult {
  message: string;
}

export interface GitStashEntry {
  index: number;
  branch: string | null;
  message: string;
}

export interface GitStashListResult {
  stashes: GitStashEntry[];
}

export interface GitRemoteInfo {
  name: string;
  url: string;
}

export interface GitRemoteListResult {
  remotes: GitRemoteInfo[];
}

export interface GitWorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isCurrent: boolean;
  isMain: boolean;
  isDetached: boolean;
  isLocked: boolean;
  isPrunable: boolean;
  lockReason?: string | null;
  prunableReason?: string | null;
}

export interface GitWorktreeListResult {
  worktrees: GitWorktreeEntry[];
}

export interface CreateGitWorktreeOptions {
  branchName: string;
  path: string;
  createBranch?: boolean;
  startPoint?: string | null;
}

export interface GitWorktreeCreateResult {
  path: string;
  branch: string;
  repoRoot: string;
  createdBranch: boolean;
}

export interface GitWorktreeRemoveResult {
  path: string;
}
