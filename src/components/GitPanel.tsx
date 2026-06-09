import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Eye,
  EyeOff,
  EllipsisVertical,
  FolderGit2,
  FolderOpen,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { VariableSizeList, type ListChildComponentProps } from "react-window";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  useActiveSessionId,
  useActiveTabId,
  useActiveTabRootDirectory,
} from "@/hooks/useActiveSessionTabState";
import {
  addGitRemote,
  createGitWorktree,
  checkoutGitBranch,
  createGitBranch,
  createGitCommit,
  discardGitAllChanges,
  fetchGitChanges,
  getGitAuthStatus,
  getGitStatus,
  listGitBranches,
  listGitRemotes,
  listGitStashes,
  listGitWorktrees,
  mergeGitBranchFromRemote,
  pullGitChanges,
  popGitStash,
  pushGitChanges,
  removeGitWorktree,
  removeGitRemote,
  stageGitAll,
  stageGitPaths,
  stashGitChanges,
  syncGitChanges,
  unstageGitAll,
  unstageGitPaths,
} from "@/lib/git";
import { prepareMonacoPanelsForRootMutation } from "@/lib/monacoMutationGuards";
import { MONACO_PANEL_TYPE, TERMINAL_PANEL_TYPE } from "@/lib/panelRegistry";
import { cn } from "@/lib/utils";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { useGitAuthStore } from "@/store/useGitAuthStore";
import { useGitPanelHeaderStore, type GitHeaderTone } from "@/store/useGitPanelHeaderStore";
import { useTabStore, type Tab } from "@/store/useTabStore";
import type {
  GitAuthStatus,
  GitBranchListPayload,
  GitBranchRef,
  GitEntryKind,
  GitRemoteInfo,
  GitStatusEntry,
  GitStatusPayload,
  GitWorktreeEntry,
  GitWorktreeListResult,
} from "@/types/git";
import type { FileChangeBatchEvent } from "@/types/filesystem";

interface FeedbackState {
  tone: "error" | "success";
  message: string;
}

interface GitPanelState {
  view: "git-diff";
  filePath: string;
  staged?: boolean;
  oldPath?: string;
}

interface TerminalPanelState {
  startupCommand?: string;
  startupNonce?: string;
}

type GitSyncAction = "pull" | "push" | "sync";

const HIDDEN_WORKTREE_STORAGE_KEY = "at-terminal:hidden-worktrees";
const GIT_WATCH_REFRESH_DEBOUNCE_MS = 1000;
const GIT_SELF_REFRESH_EVENT_COOLDOWN_MS = 2500;
const EMPTY_TABS: Tab[] = [];
const GIT_STATUS_HEADER_ROW_HEIGHT = 30;
const GIT_STATUS_ENTRY_ROW_HEIGHT = 34;
const GIT_STATUS_RENAMED_ENTRY_ROW_HEIGHT = 48;

interface GitStatusHeaderRow {
  kind: "header";
  key: string;
  title: string;
  count: number;
  showToggleAll?: boolean;
}

interface GitStatusEntryRow {
  kind: "entry";
  key: string;
  entry: GitStatusEntry;
}

type GitStatusRow = GitStatusHeaderRow | GitStatusEntryRow;

interface GitStatusListRowData {
  rows: GitStatusRow[];
  repoRoot: string | null;
  pendingPath: string | null;
  disableActions: boolean;
  onOpenDiff: (entry: GitStatusEntry) => void;
  onToggleStage: (entry: GitStatusEntry) => void;
  onStageAll: () => void;
}

export function GitPanel() {
  const activeSessionId = useActiveSessionId();
  const activeTabId = useActiveTabId();
  const rootDirectory = useActiveTabRootDirectory();

  return (
    <GitPanelContent
      key={rootDirectory ?? "no-root"}
      activeSessionId={activeSessionId}
      activeTabId={activeTabId}
      rootDirectory={rootDirectory}
    />
  );
}

interface GitPanelContentProps {
  activeSessionId: string | null;
  activeTabId: string | null;
  rootDirectory: string | null;
}

function GitPanelContent({ activeSessionId, activeTabId, rootDirectory }: GitPanelContentProps) {
  const sessionTabs =
    useTabStore((state) =>
      activeSessionId ? state.sessionStates[activeSessionId]?.tabs : undefined,
    ) ?? EMPTY_TABS;
  const addPanel = useTabStore((state) => state.addPanel);
  const setActivePanel = useTabStore((state) => state.setActivePanel);
  const updatePanelState = useTabStore((state) => state.updatePanelState);
  const addTab = useTabStore((state) => state.addTab);
  const setActiveTab = useTabStore((state) => state.setActiveTab);
  const closeTabById = useTabStore((state) => state.closeTabById);
  const requestGitAuth = useGitAuthStore((state) => state.requestSetup);
  const loadIdRef = useRef(0);
  const gitWatchRefreshTimeoutRef = useRef<number | null>(null);
  const isMutationPendingRef = useRef(false);
  const lastAutoRefreshAtRef = useRef(0);
  const statusListViewportRef = useRef<HTMLDivElement>(null);
  const statusListRef = useRef<VariableSizeList<GitStatusListRowData> | null>(null);
  const [status, setStatus] = useState<GitStatusPayload | null>(null);
  const [authStatus, setAuthStatus] = useState<GitAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authActionPending, setAuthActionPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [commitPending, setCommitPending] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchState, setBranchState] = useState<GitBranchListPayload | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchActionPending, setBranchActionPending] = useState(false);
  const [syncPending, setSyncPending] = useState<GitSyncAction | null>(null);
  const [mutationAction, setMutationAction] = useState<string | null>(null);
  const [pullFromOpen, setPullFromOpen] = useState(false);
  const [pullFromRemote, setPullFromRemote] = useState("");
  const [pullFromBranch, setPullFromBranch] = useState("");
  const [pullFromRemotes, setPullFromRemotes] = useState<GitRemoteInfo[]>([]);
  const [pullFromRemotePickerOpen, setPullFromRemotePickerOpen] = useState(false);
  const [pullFromBranchPickerOpen, setPullFromBranchPickerOpen] = useState(false);
  const [pullFromLoading, setPullFromLoading] = useState(false);
  const [createBranchFromOpen, setCreateBranchFromOpen] = useState(false);
  const [createBranchFromName, setCreateBranchFromName] = useState("");
  const [createBranchFromRemote, setCreateBranchFromRemote] = useState("");
  const [createBranchFromStart, setCreateBranchFromStart] = useState("");
  const [createBranchFromRemotes, setCreateBranchFromRemotes] = useState<GitRemoteInfo[]>([]);
  const [createBranchFromRemotePickerOpen, setCreateBranchFromRemotePickerOpen] = useState(false);
  const [createBranchFromBranchPickerOpen, setCreateBranchFromBranchPickerOpen] = useState(false);
  const [createBranchFromLoading, setCreateBranchFromLoading] = useState(false);
  const [addRemoteOpen, setAddRemoteOpen] = useState(false);
  const [addRemoteName, setAddRemoteName] = useState("");
  const [addRemoteUrl, setAddRemoteUrl] = useState("");
  const [addRemoteLoading, setAddRemoteLoading] = useState(false);
  const [removeRemoteOpen, setRemoveRemoteOpen] = useState(false);
  const [removeRemoteRemotes, setRemoveRemoteRemotes] = useState<GitRemoteInfo[]>([]);
  const [removeRemoteLoading, setRemoveRemoteLoading] = useState(false);
  const [stashListOpen, setStashListOpen] = useState(false);
  const [stashEntries, setStashEntries] = useState<
    { index: number; branch: string | null; message: string }[]
  >([]);
  const [stashListLoading, setStashListLoading] = useState(false);
  const [stashPopLoading, setStashPopLoading] = useState<number | null>(null);
  const [worktreeState, setWorktreeState] = useState<GitWorktreeListResult | null>(null);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [createWorktreeOpen, setCreateWorktreeOpen] = useState(false);
  const [createWorktreeBranchName, setCreateWorktreeBranchName] = useState("");
  const [createWorktreePath, setCreateWorktreePath] = useState("");
  const [createWorktreeStartPoint, setCreateWorktreeStartPoint] = useState("");
  const [createWorktreeUseExistingBranch, setCreateWorktreeUseExistingBranch] = useState(false);
  const [createWorktreeBranchPickerOpen, setCreateWorktreeBranchPickerOpen] = useState(false);
  const [createWorktreeOpenAfterCreate, setCreateWorktreeOpenAfterCreate] = useState(true);
  const [createWorktreeAdvancedOpen, setCreateWorktreeAdvancedOpen] = useState(false);
  const [createWorktreePathEdited, setCreateWorktreePathEdited] = useState(false);
  const [createWorktreeLoading, setCreateWorktreeLoading] = useState(false);
  const [removingWorktreePath, setRemovingWorktreePath] = useState<string | null>(null);
  const [hiddenWorktreesByRepo, setHiddenWorktreesByRepo] = useState<Record<string, string[]>>(
    () => {
      if (typeof window === "undefined") return {};
      try {
        const raw = window.localStorage.getItem(HIDDEN_WORKTREE_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as Record<string, string[]>;
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    },
  );
  const [worktreeManagerOpen, setWorktreeManagerOpen] = useState(false);
  const [statusListHeight, setStatusListHeight] = useState(0);
  const confirm = useConfirmationStore((s) => s.confirm);
  const lastPublishedHeaderRef = useRef<{
    visible: boolean;
    rootDirectory: string | null;
    username: string | null;
    tone: GitHeaderTone;
    isRefreshing: boolean;
    onRefresh: (() => void) | null;
  } | null>(null);

  const loadStatus = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const nextLoadId = silent ? loadIdRef.current : loadIdRef.current + 1;
      if (!silent) {
        loadIdRef.current = nextLoadId;
      }

      if (!rootDirectory) {
        setStatus(null);
        setError(null);
        if (!silent) {
          setLoading(false);
        }
        return;
      }

      if (!silent) {
        setLoading(true);
      }
      setError(null);

      try {
        const nextStatus = await getGitStatus(rootDirectory);
        if (loadIdRef.current !== nextLoadId) return;
        setStatus(nextStatus);
        setError(null);
      } catch (err) {
        if (loadIdRef.current !== nextLoadId) return;
        setStatus(null);
        setError(formatError(err));
      } finally {
        if (loadIdRef.current === nextLoadId && !silent) {
          setLoading(false);
        }
      }
    },
    [rootDirectory],
  );

  const loadBranches = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!rootDirectory) {
        setBranchState(null);
        setBranchError(null);
        return;
      }

      if (!options?.silent) {
        setBranchLoading(true);
      }
      setBranchError(null);

      try {
        const nextBranches = await listGitBranches(rootDirectory);
        setBranchState(nextBranches);
      } catch (err) {
        setBranchState(null);
        setBranchError(formatError(err));
      } finally {
        setBranchLoading(false);
      }
    },
    [rootDirectory],
  );

  const loadWorktrees = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!rootDirectory) {
        setWorktreeState(null);
        setWorktreeError(null);
        setWorktreeLoading(false);
        return;
      }

      if (!options?.silent) {
        setWorktreeLoading(true);
      }
      setWorktreeError(null);

      try {
        const nextWorktrees = await listGitWorktrees(rootDirectory);
        setWorktreeState(nextWorktrees);
      } catch (err) {
        const message = formatError(err);
        if (message === "Not a Git repository.") {
          setWorktreeState({ worktrees: [] });
          setWorktreeError(null);
        } else {
          setWorktreeState(null);
          setWorktreeError(message);
        }
      } finally {
        setWorktreeLoading(false);
      }
    },
    [rootDirectory],
  );

  const loadAuthStatus = useCallback(async () => {
    if (!rootDirectory) {
      setAuthStatus(null);
      setAuthLoading(false);
      return;
    }

    setAuthLoading(true);
    try {
      const nextAuthStatus = await getGitAuthStatus(rootDirectory);
      setAuthStatus(nextAuthStatus);
    } catch (err) {
      setAuthStatus({
        remoteKind: "none",
        ghInstalled: false,
        ghAuthenticated: false,
        gitCredentialHelperConfigured: false,
        username: null,
        message: formatError(err),
        nextAction: "none",
      });
    } finally {
      setAuthLoading(false);
    }
  }, [rootDirectory]);

  const refreshGitStateAfterMerge = useCallback(() => {
    void Promise.allSettled([loadStatus(), loadBranches({ silent: true })]);
  }, [loadBranches, loadStatus]);

  const releaseDialogPointerLock = useCallback(() => {
    if (typeof document === "undefined") return;

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const hasOpenDialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (!hasOpenDialog) {
          document.body.style.pointerEvents = "";
        }
      });
    });
  }, []);

  const closePullFromDialog = useCallback(() => {
    setPullFromOpen(false);
    setPullFromRemotePickerOpen(false);
    setPullFromBranchPickerOpen(false);
    releaseDialogPointerLock();
  }, [releaseDialogPointerLock]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadStatus();
      void loadAuthStatus();
      void loadBranches({ silent: true });
      void loadWorktrees({ silent: true });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadAuthStatus, loadBranches, loadStatus, loadWorktrees]);

  const stagedEntries = useMemo(
    () => status?.entries.filter((entry) => entry.staged) ?? [],
    [status?.entries],
  );
  const changeEntries = useMemo(
    () => status?.entries.filter((entry) => !entry.staged && entry.kind !== "untracked") ?? [],
    [status?.entries],
  );
  const untrackedEntries = useMemo(
    () => status?.entries.filter((entry) => !entry.staged && entry.kind === "untracked") ?? [],
    [status?.entries],
  );
  const gitStatusRows = useMemo<GitStatusRow[]>(() => {
    const rows: GitStatusRow[] = [];
    const groups = [
      { title: "Staged", entries: stagedEntries, showToggleAll: false },
      { title: "Changes", entries: changeEntries, showToggleAll: true },
      { title: "Untracked", entries: untrackedEntries, showToggleAll: false },
    ];

    groups.forEach((group) => {
      if (group.entries.length === 0) return;
      rows.push({
        kind: "header",
        key: `header:${group.title}`,
        title: group.title,
        count: group.entries.length,
        showToggleAll: group.showToggleAll,
      });
      group.entries.forEach((entry) => {
        rows.push({
          kind: "entry",
          key: `${entry.staged ? "staged" : "changes"}:${entry.path}:${entry.kind}`,
          entry,
        });
      });
    });

    return rows;
  }, [changeEntries, stagedEntries, untrackedEntries]);

  useEffect(() => {
    statusListRef.current?.resetAfterIndex(0, true);
  }, [gitStatusRows]);
  useEffect(() => {
    const element = statusListViewportRef.current;
    if (!element) return;

    const updateHeight = () => {
      setStatusListHeight(element.clientHeight);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [gitStatusRows.length, status?.isClean]);

  const currentBranchEntry = useMemo(
    () => branchState?.branches.find((branch) => branch.isCurrent && !branch.isRemote) ?? null,
    [branchState?.branches],
  );
  const currentBranchNeedsPublish = Boolean(
    currentBranchEntry &&
    (!currentBranchEntry.upstreamRemote?.trim() ||
      currentBranchEntry.upstreamBranch?.trim() !== currentBranchEntry.name),
  );
  const localBranches = useMemo(
    () => branchState?.branches.filter((branch) => !branch.isRemote && !branch.isCurrent) ?? [],
    [branchState?.branches],
  );
  const remoteBranches = useMemo(
    () => branchState?.branches.filter((branch) => branch.isRemote) ?? [],
    [branchState?.branches],
  );
  const trimmedCreateWorktreeBranchName = createWorktreeBranchName.trim();
  const createWorktreeExistingBranches = useMemo(() => {
    const branches = (branchState?.branches ?? []).filter((branch) => !branch.isRemote);
    return [...branches].sort((left, right) => {
      const rightTimestamp = right.lastCommitTimestamp ?? Number.NEGATIVE_INFINITY;
      const leftTimestamp = left.lastCommitTimestamp ?? Number.NEGATIVE_INFINITY;
      return rightTimestamp - leftTimestamp || left.name.localeCompare(right.name);
    });
  }, [branchState?.branches]);
  const filteredCreateWorktreeExistingBranches = useMemo(() => {
    const query = trimmedCreateWorktreeBranchName.toLowerCase();
    if (!query) return createWorktreeExistingBranches;
    return createWorktreeExistingBranches.filter((branch) =>
      branch.name.toLowerCase().includes(query),
    );
  }, [createWorktreeExistingBranches, trimmedCreateWorktreeBranchName]);
  const pullFromRemoteBranches = useMemo(() => {
    const selectedRemote = pullFromRemote.trim();
    if (!selectedRemote) return [];
    return remoteBranches.filter((branch) => branch.name.startsWith(`${selectedRemote}/`));
  }, [pullFromRemote, remoteBranches]);
  const filteredPullFromRemoteBranches = useMemo(() => {
    const query = pullFromBranch.trim().toLowerCase();
    if (!query) return pullFromRemoteBranches;
    return pullFromRemoteBranches.filter((branch) => branch.name.toLowerCase().includes(query));
  }, [pullFromBranch, pullFromRemoteBranches]);
  const createBranchFromRemoteBranches = useMemo(() => {
    const selectedRemote = createBranchFromRemote.trim();
    if (!selectedRemote) return [];
    return remoteBranches.filter((branch) => branch.name.startsWith(`${selectedRemote}/`));
  }, [createBranchFromRemote, remoteBranches]);
  const filteredCreateBranchFromRemoteBranches = useMemo(() => {
    const query = createBranchFromStart.trim().toLowerCase();
    if (!query) return createBranchFromRemoteBranches;
    return createBranchFromRemoteBranches.filter((branch) =>
      branch.name.toLowerCase().includes(query),
    );
  }, [createBranchFromRemoteBranches, createBranchFromStart]);
  const worktrees = useMemo(() => worktreeState?.worktrees ?? [], [worktreeState?.worktrees]);
  const openWorktreePaths = useMemo(
    () => new Set(sessionTabs.map((tab) => normalizePathForComparison(tab.rootDirectory))),
    [sessionTabs],
  );
  const currentCheckoutPath = useMemo(
    () => normalizePathForComparison(rootDirectory ?? status?.repoRoot ?? ""),
    [rootDirectory, status?.repoRoot],
  );
  const currentWorktreeEntry = useMemo(
    () =>
      worktrees.find(
        (worktree) => normalizePathForComparison(worktree.path) === currentCheckoutPath,
      ) ?? null,
    [currentCheckoutPath, worktrees],
  );
  const repoDisplayName = useMemo(
    () => basename(status?.repoRoot ?? rootDirectory ?? ""),
    [rootDirectory, status?.repoRoot],
  );
  const isMainCheckout = useMemo(
    () =>
      currentWorktreeEntry
        ? currentWorktreeEntry.isMain
        : normalizePathForComparison(rootDirectory ?? "") ===
          normalizePathForComparison(status?.repoRoot ?? ""),
    [currentWorktreeEntry, rootDirectory, status?.repoRoot],
  );
  const suggestedCreateWorktreePath = useMemo(
    () => suggestWorktreePath(status?.repoRoot ?? rootDirectory, createWorktreeBranchName),
    [createWorktreeBranchName, rootDirectory, status?.repoRoot],
  );
  const effectiveCreateWorktreePath = createWorktreePathEdited
    ? createWorktreePath
    : suggestedCreateWorktreePath;
  const trimmedCreateWorktreePath = effectiveCreateWorktreePath.trim();
  const existingCreateWorktreeBranchAvailable = branchNameExists(
    branchState?.branches ?? [],
    trimmedCreateWorktreeBranchName,
  );
  const hiddenWorktreeRepoKey = useMemo(
    () => normalizePathForComparison(status?.repoRoot ?? rootDirectory ?? ""),
    [rootDirectory, status?.repoRoot],
  );
  const hiddenWorktreePaths = useMemo(
    () =>
      new Set(
        (hiddenWorktreesByRepo[hiddenWorktreeRepoKey] ?? []).map((path) =>
          normalizePathForComparison(path),
        ),
      ),
    [hiddenWorktreeRepoKey, hiddenWorktreesByRepo],
  );
  const visibleWorktrees = useMemo(
    () =>
      worktrees.filter(
        (worktree) => !hiddenWorktreePaths.has(normalizePathForComparison(worktree.path)),
      ),
    [hiddenWorktreePaths, worktrees],
  );

  const isMutationPending =
    commitPending ||
    branchActionPending ||
    syncPending !== null ||
    pendingPath !== null ||
    authActionPending ||
    mutationAction !== null ||
    createWorktreeLoading ||
    removingWorktreePath !== null;
  useEffect(() => {
    isMutationPendingRef.current = isMutationPending;
  }, [isMutationPending]);
  const stagedCount = stagedEntries.length;
  const changeCount = changeEntries.length;
  const canCommit = stagedCount > 0 && commitMessage.trim().length > 0 && !isMutationPending;
  const trimmedBranchQuery = branchQuery.trim();
  const canCreateBranch =
    isLikelyValidBranchName(trimmedBranchQuery) &&
    !branchNameExists(branchState?.branches ?? [], trimmedBranchQuery);
  const canCreateWorktree =
    trimmedCreateWorktreePath.length > 0 &&
    trimmedCreateWorktreeBranchName.length > 0 &&
    (createWorktreeUseExistingBranch
      ? existingCreateWorktreeBranchAvailable
      : isLikelyValidBranchName(trimmedCreateWorktreeBranchName) &&
        !branchNameExists(branchState?.branches ?? [], trimmedCreateWorktreeBranchName));

  const refreshAllGitState = useCallback(() => {
    void loadStatus();
    void loadAuthStatus();
    void loadWorktrees();
  }, [loadAuthStatus, loadStatus, loadWorktrees]);

  useEffect(() => {
    const nextHeaderState: {
      visible: boolean;
      rootDirectory: string | null;
      username: string | null;
      tone: GitHeaderTone;
      isRefreshing: boolean;
      onRefresh: (() => void) | null;
    } = {
      visible: Boolean(rootDirectory),
      rootDirectory,
      username:
        authStatus?.remoteKind === "github_https" && authStatus.nextAction === "ready"
          ? authStatus.username
          : null,
      tone:
        loading || authLoading || worktreeLoading
          ? "warning"
          : authStatus?.remoteKind === "github_https" && authStatus.nextAction === "ready"
            ? "success"
            : rootDirectory
              ? "danger"
              : "neutral",
      isRefreshing: loading || authLoading || worktreeLoading,
      onRefresh: rootDirectory ? refreshAllGitState : null,
    };
    const previousHeaderState = lastPublishedHeaderRef.current;
    if (
      previousHeaderState &&
      previousHeaderState.visible === nextHeaderState.visible &&
      previousHeaderState.rootDirectory === nextHeaderState.rootDirectory &&
      previousHeaderState.username === nextHeaderState.username &&
      previousHeaderState.tone === nextHeaderState.tone &&
      previousHeaderState.isRefreshing === nextHeaderState.isRefreshing &&
      previousHeaderState.onRefresh === nextHeaderState.onRefresh
    ) {
      return;
    }
    lastPublishedHeaderRef.current = nextHeaderState;
    useGitPanelHeaderStore.getState().setState(nextHeaderState);
  }, [authLoading, authStatus, loading, refreshAllGitState, rootDirectory, worktreeLoading]);

  useEffect(() => {
    if (!rootDirectory || typeof window === "undefined") return;

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const clearScheduledRefresh = () => {
      if (gitWatchRefreshTimeoutRef.current === null) return;
      window.clearTimeout(gitWatchRefreshTimeoutRef.current);
      gitWatchRefreshTimeoutRef.current = null;
    };

    const scheduleRefresh = (includeBranches: boolean) => {
      clearScheduledRefresh();
      gitWatchRefreshTimeoutRef.current = window.setTimeout(() => {
        gitWatchRefreshTimeoutRef.current = null;
        if (cancelled || isMutationPendingRef.current) return;
        lastAutoRefreshAtRef.current = Date.now();
        if (includeBranches) {
          void Promise.allSettled([loadStatus({ silent: true }), loadBranches({ silent: true })]);
          return;
        }
        void loadStatus({ silent: true });
      }, GIT_WATCH_REFRESH_DEBOUNCE_MS);
    };

    const setupListener = async () => {
      unlisten = await listen<FileChangeBatchEvent>("file-change", (event) => {
        if (cancelled || isMutationPendingRef.current) return;
        const changedPaths = event.payload.changedPaths ?? [];
        const changedDirs = event.payload.changedDirs ?? [];
        const changedItems = changedPaths.length > 0 ? changedPaths : changedDirs;
        if (changedItems.length === 0) return;

        const normalizedRoot = normalizePathForComparison(rootDirectory);
        const affectsRoot = changedItems.some((path) =>
          isPathInsideRoot(normalizePathForComparison(path), normalizedRoot),
        );
        if (!affectsRoot) return;

        const includesGitMetadata = Boolean(event.payload.includesGitMetadata);
        if (
          includesGitMetadata &&
          Date.now() - lastAutoRefreshAtRef.current < GIT_SELF_REFRESH_EVENT_COOLDOWN_MS
        ) {
          return;
        }

        scheduleRefresh(includesGitMetadata);
      });
    };

    void setupListener().catch((err) => {
      console.error("Failed to listen for Git file changes:", err);
    });

    return () => {
      cancelled = true;
      clearScheduledRefresh();
      if (unlisten) unlisten();
    };
  }, [loadBranches, loadStatus, rootDirectory]);

  useEffect(() => {
    return () => {
      if (gitWatchRefreshTimeoutRef.current !== null && typeof window !== "undefined") {
        window.clearTimeout(gitWatchRefreshTimeoutRef.current);
        gitWatchRefreshTimeoutRef.current = null;
      }
      lastPublishedHeaderRef.current = null;
      useGitPanelHeaderStore.getState().reset();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HIDDEN_WORKTREE_STORAGE_KEY, JSON.stringify(hiddenWorktreesByRepo));
  }, [hiddenWorktreesByRepo]);

  const setWorktreeHidden = useCallback(
    (worktreePath: string, hidden: boolean) => {
      if (!hiddenWorktreeRepoKey || hiddenWorktreeRepoKey === "/") return;
      const normalizedPath = normalizePathForComparison(worktreePath);
      setHiddenWorktreesByRepo((current) => {
        const nextPaths = new Set(
          (current[hiddenWorktreeRepoKey] ?? []).map((path) => normalizePathForComparison(path)),
        );
        if (hidden) {
          nextPaths.add(normalizedPath);
        } else {
          nextPaths.delete(normalizedPath);
        }
        return {
          ...current,
          [hiddenWorktreeRepoKey]: Array.from(nextPaths),
        };
      });
    },
    [hiddenWorktreeRepoKey],
  );

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry) => {
      if (!activeSessionId || !activeTabId) return;

      const store = useTabStore.getState();
      const tab = store.sessionStates[activeSessionId]?.tabs.find(
        (candidate) => candidate.id === activeTabId,
      );
      if (!tab) return;

      const existingPanel = tab.panels.find((panel) => {
        if (panel.type !== MONACO_PANEL_TYPE) return false;
        const state = panel.state as GitPanelState | undefined;
        return (
          state?.view === "git-diff" &&
          state.filePath === entry.path &&
          Boolean(state.staged) === entry.staged
        );
      });

      if (existingPanel) {
        setActivePanel(activeSessionId, tab.id, existingPanel.id);
        return;
      }

      const panelId = addPanel(activeSessionId, tab.id, MONACO_PANEL_TYPE, {
        name: diffPanelName(entry),
      });
      if (!panelId) return;

      updatePanelState(activeSessionId, tab.id, panelId, {
        view: "git-diff",
        filePath: entry.path,
        staged: entry.staged,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      } satisfies GitPanelState);
    },
    [activeSessionId, activeTabId, addPanel, setActivePanel, updatePanelState],
  );

  const handleStageToggle = useCallback(
    async (entry: GitStatusEntry) => {
      if (!rootDirectory || isMutationPending) return;

      setPendingPath(`${entry.staged ? "unstage" : "stage"}:${entry.path}`);
      setFeedback(null);
      try {
        if (entry.staged) {
          await unstageGitPaths(rootDirectory, [entry.path]);
        } else {
          await stageGitPaths(rootDirectory, [entry.path]);
        }
        await loadStatus();
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setPendingPath(null);
      }
    },
    [isMutationPending, loadStatus, rootDirectory],
  );

  const handleCommit = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    setCommitPending(true);
    setFeedback(null);
    try {
      const result = await createGitCommit(rootDirectory, commitMessage);
      setCommitMessage("");
      setFeedback({
        tone: "success",
        message: `Committed ${result.commitHash.slice(0, 7)} ${result.summary}`,
      });
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setCommitPending(false);
    }
  }, [commitMessage, isMutationPending, loadStatus, rootDirectory]);

  const handleOpenTerminal = useCallback(
    (startupCommand?: string) => {
      if (!activeSessionId || !activeTabId) return;

      const store = useTabStore.getState();
      const tab = store.sessionStates[activeSessionId]?.tabs.find(
        (candidate) => candidate.id === activeTabId,
      );
      if (!tab) return;

      const existingPanel = tab.panels.find((panel) => panel.type === TERMINAL_PANEL_TYPE);
      const nextState =
        startupCommand && startupCommand.trim().length > 0
          ? ({
              ...((existingPanel?.state as TerminalPanelState | undefined) ?? {}),
              startupCommand,
              startupNonce: `${Date.now()}`,
            } satisfies TerminalPanelState)
          : null;

      if (existingPanel) {
        if (nextState) {
          updatePanelState(activeSessionId, tab.id, existingPanel.id, nextState);
        }
        setActivePanel(activeSessionId, tab.id, existingPanel.id);
        return;
      }

      const panelId = addPanel(activeSessionId, tab.id, TERMINAL_PANEL_TYPE);
      if (!panelId) return;
      if (nextState) {
        updatePanelState(activeSessionId, tab.id, panelId, nextState);
      }
    },
    [activeSessionId, activeTabId, addPanel, setActivePanel, updatePanelState],
  );

  const handleOpenWorktree = useCallback(
    (worktreePath: string) => {
      if (!activeSessionId) return;

      const normalizedTarget = normalizePathForComparison(worktreePath);
      const existingTab = sessionTabs.find(
        (tab) => normalizePathForComparison(tab.rootDirectory) === normalizedTarget,
      );

      if (existingTab) {
        setActiveTab(activeSessionId, existingTab.id);
        return;
      }

      addTab(activeSessionId, worktreePath);
    },
    [activeSessionId, addTab, sessionTabs, setActiveTab],
  );

  const handleOpenCreateWorktreeDialog = useCallback(() => {
    setCreateWorktreeBranchName("");
    setCreateWorktreePath("");
    setCreateWorktreeStartPoint("");
    setCreateWorktreeUseExistingBranch(false);
    setCreateWorktreeBranchPickerOpen(false);
    setCreateWorktreeOpenAfterCreate(true);
    setCreateWorktreeAdvancedOpen(false);
    setCreateWorktreePathEdited(false);
    setCreateWorktreeOpen(true);
  }, []);

  const handleBrowseCreateWorktreePath = useCallback(async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Worktree Destination",
    });
    if (typeof selected === "string" && selected.trim().length > 0) {
      setCreateWorktreePath(selected);
      setCreateWorktreePathEdited(true);
    }
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    if (!rootDirectory || !canCreateWorktree) return;

    setCreateWorktreeLoading(true);
    setFeedback(null);
    try {
      const result = await createGitWorktree(rootDirectory, {
        branchName: trimmedCreateWorktreeBranchName,
        path: trimmedCreateWorktreePath,
        createBranch: !createWorktreeUseExistingBranch,
        startPoint: createWorktreeUseExistingBranch
          ? null
          : createWorktreeStartPoint.trim() || null,
      });

      setCreateWorktreeOpen(false);
      setFeedback({
        tone: "success",
        message: createWorktreeUseExistingBranch
          ? `Opened worktree for ${result.branch}.`
          : `Created worktree on ${result.branch}.`,
      });

      if (createWorktreeOpenAfterCreate) {
        handleOpenWorktree(result.path);
      }

      await loadWorktrees();
      await loadStatus();
      await loadAuthStatus();
      await loadBranches({ silent: true });
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setCreateWorktreeLoading(false);
    }
  }, [
    canCreateWorktree,
    createWorktreeOpenAfterCreate,
    createWorktreeStartPoint,
    createWorktreeUseExistingBranch,
    handleOpenWorktree,
    loadAuthStatus,
    loadBranches,
    loadStatus,
    loadWorktrees,
    rootDirectory,
    trimmedCreateWorktreeBranchName,
    trimmedCreateWorktreePath,
  ]);

  const handleRemoveWorktree = useCallback(
    async (worktree: GitWorktreeEntry) => {
      if (!rootDirectory) return;

      if (worktree.isMain) {
        setFeedback({
          tone: "error",
          message: "The main checkout cannot be removed as a worktree.",
        });
        return;
      }

      if (worktree.isCurrent) {
        setFeedback({
          tone: "error",
          message: "Open a different worktree tab before removing the current checkout.",
        });
        return;
      }

      const confirmed = await confirm({
        title: `Remove worktree ${basename(worktree.path)}?`,
        description:
          `A worktree is an extra Git checkout linked to this repo. ` +
          `Removing this one will unlink it from Git and delete its working directory from disk:\n${worktree.path}`,
        confirmLabel: "Remove Worktree",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;

      setRemovingWorktreePath(worktree.path);
      setFeedback(null);
      try {
        const result = await removeGitWorktree(rootDirectory, worktree.path);
        if (activeSessionId) {
          const normalizedRemovedPath = normalizePathForComparison(result.path);
          const existingTab = sessionTabs.find(
            (tab) => normalizePathForComparison(tab.rootDirectory) === normalizedRemovedPath,
          );
          if (existingTab) {
            closeTabById(activeSessionId, existingTab.id);
          }
        }

        setFeedback({
          tone: "success",
          message: `Removed worktree ${basename(result.path)}.`,
        });
        setWorktreeHidden(result.path, false);
        await loadWorktrees();
        await loadStatus();
        await loadAuthStatus();
        await loadBranches({ silent: true });
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setRemovingWorktreePath(null);
      }
    },
    [
      activeSessionId,
      closeTabById,
      confirm,
      loadAuthStatus,
      loadBranches,
      loadStatus,
      loadWorktrees,
      rootDirectory,
      sessionTabs,
      setWorktreeHidden,
    ],
  );

  const handleGitAuthFlow = useCallback(
    async (actionLabel: string, statusOverride?: GitAuthStatus | null) => {
      const currentStatus = statusOverride ?? authStatus;
      if (!rootDirectory || !currentStatus) return false;

      if (currentStatus.nextAction === "ready") {
        return true;
      }

      if (currentStatus.nextAction === "unsupported" || currentStatus.nextAction === "none") {
        setFeedback({
          tone: "error",
          message: currentStatus.message ?? "Git auth setup is not available for this remote.",
        });
        return false;
      }

      setAuthActionPending(true);
      setFeedback(null);
      try {
        const ready = await requestGitAuth({
          rootDirectory,
          status: currentStatus,
          actionLabel,
          onOpenTerminal: handleOpenTerminal,
        });
        await loadAuthStatus();
        if (ready) {
          setFeedback({
            tone: "success",
            message: `${actionLabel} is ready through GitHub CLI.`,
          });
        }
        return ready;
      } finally {
        setAuthActionPending(false);
      }
    },
    [authStatus, handleOpenTerminal, loadAuthStatus, requestGitAuth, rootDirectory],
  );

  const handleBranchPickerOpenChange = useCallback(
    (open: boolean) => {
      setBranchPickerOpen(open);
      if (open) {
        setBranchQuery("");
        void loadBranches();
      } else {
        setBranchError(null);
      }
    },
    [loadBranches],
  );

  const handleCheckoutBranch = useCallback(
    async (branch: GitBranchRef) => {
      if (!rootDirectory || isMutationPending) return;

      setBranchActionPending(true);
      setFeedback(null);
      try {
        if (branch.isRemote) {
          const nextBranchName = remoteBranchLocalName(branch.name);
          const result = await createGitBranch(rootDirectory, nextBranchName, {
            checkout: true,
            startPoint: branch.name,
          });
          setFeedback({
            tone: "success",
            message: `Created and switched to ${result.branch}.`,
          });
        } else {
          const result = await checkoutGitBranch(rootDirectory, branch.name);
          setFeedback({
            tone: "success",
            message: `Switched to ${result.branch}.`,
          });
        }
        setBranchPickerOpen(false);
        setBranchQuery("");
        await loadStatus();
        await loadAuthStatus();
        await loadBranches({ silent: true });
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setBranchActionPending(false);
      }
    },
    [isMutationPending, loadAuthStatus, loadBranches, loadStatus, rootDirectory],
  );

  const handleCreateBranch = useCallback(async () => {
    if (!rootDirectory || isMutationPending || !canCreateBranch) return;

    setBranchActionPending(true);
    setFeedback(null);
    try {
      const result = await createGitBranch(rootDirectory, trimmedBranchQuery, {
        checkout: true,
      });
      setFeedback({
        tone: "success",
        message: `Created and switched to ${result.branch}.`,
      });
      setBranchPickerOpen(false);
      setBranchQuery("");
      await loadStatus();
      await loadAuthStatus();
      await loadBranches({ silent: true });
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setBranchActionPending(false);
    }
  }, [
    canCreateBranch,
    isMutationPending,
    loadAuthStatus,
    loadBranches,
    loadStatus,
    rootDirectory,
    trimmedBranchQuery,
  ]);

  const handleSyncAction = useCallback(
    async (action: GitSyncAction) => {
      if (!rootDirectory || isMutationPending) return;

      if (authStatus?.remoteKind === "other_https") {
        setFeedback({
          tone: "error",
          message:
            authStatus.message ??
            "This repo uses a non-GitHub HTTPS remote. Browser auth currently supports github.com only.",
        });
        return;
      }

      if (authStatus?.remoteKind === "github_https") {
        const ready = await handleGitAuthFlow(syncActionLabel(action), authStatus);
        if (!ready) {
          setFeedback({
            tone: "error",
            message:
              authStatus.message ??
              "Finish GitHub CLI setup to continue with remote Git operations.",
          });
          return;
        }
      }

      setSyncPending(action);
      setFeedback(null);
      try {
        const runAction = () =>
          action === "pull"
            ? pullGitChanges(rootDirectory)
            : action === "push"
              ? pushGitChanges(rootDirectory)
              : syncGitChanges(rootDirectory);
        let result;
        try {
          result = await runAction();
        } catch (err) {
          const message = formatError(err);
          if (
            authStatus?.remoteKind === "github_https" &&
            message.toLowerCase().includes("sign in with github cli again")
          ) {
            await loadAuthStatus();
            const ready = await handleGitAuthFlow(syncActionLabel(action));
            if (!ready) {
              throw err;
            }
            result = await runAction();
          } else {
            throw err;
          }
        }
        setFeedback({ tone: "success", message: result.summary });
        await loadStatus();
        await loadAuthStatus();
        await loadBranches({ silent: true });
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setSyncPending(null);
      }
    },
    [
      authStatus,
      handleGitAuthFlow,
      isMutationPending,
      loadAuthStatus,
      loadBranches,
      loadStatus,
      rootDirectory,
    ],
  );

  const handleFetchAction = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    if (authStatus?.remoteKind === "other_https") {
      setFeedback({
        tone: "error",
        message:
          authStatus.message ??
          "This repo uses a non-GitHub HTTPS remote. Browser auth currently supports github.com only.",
      });
      return;
    }

    if (authStatus?.remoteKind === "github_https") {
      const ready = await handleGitAuthFlow("Fetch", authStatus);
      if (!ready) {
        setFeedback({
          tone: "error",
          message:
            authStatus.message ?? "Finish GitHub CLI setup to continue with remote Git operations.",
        });
        return;
      }
    }

    setMutationAction("fetch");
    setFeedback(null);
    try {
      const result = await fetchGitChanges(rootDirectory);
      setFeedback({ tone: "success", message: result.summary });
      await loadStatus();
      await loadAuthStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [authStatus, handleGitAuthFlow, isMutationPending, loadAuthStatus, loadStatus, rootDirectory]);

  const handlePullFromAction = useCallback(async () => {
    if (!rootDirectory || !pullFromRemote.trim() || !pullFromBranch.trim()) return;

    const mutationPlan = await prepareMonacoPanelsForRootMutation(activeSessionId, rootDirectory);
    if (!mutationPlan) return;

    setPullFromLoading(true);
    setFeedback(null);
    try {
      const trimmedRemote = pullFromRemote.trim();
      const trimmedBranch = pullFromBranch.trim();
      const result = await mergeGitBranchFromRemote(rootDirectory, trimmedRemote, trimmedBranch);
      mutationPlan.closePanels();
      setFeedback({ tone: "success", message: result.summary });
      closePullFromDialog();
      setPullFromRemote("");
      setPullFromBranch("");
      refreshGitStateAfterMerge();
    } catch (err) {
      const message = formatError(err);
      if (message.includes("Merge resulted in conflicts") || message.includes("Merge stopped")) {
        mutationPlan.closePanels();
      }
      setFeedback({ tone: "error", message });
      refreshGitStateAfterMerge();
    } finally {
      setPullFromLoading(false);
    }
  }, [
    activeSessionId,
    closePullFromDialog,
    pullFromBranch,
    pullFromRemote,
    refreshGitStateAfterMerge,
    rootDirectory,
  ]);

  const handleStageAll = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    setMutationAction("stage-all");
    setFeedback(null);
    try {
      await stageGitAll(rootDirectory);
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [isMutationPending, loadStatus, rootDirectory]);

  const handleUnstageAll = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    setMutationAction("unstage-all");
    setFeedback(null);
    try {
      await unstageGitAll(rootDirectory);
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [isMutationPending, loadStatus, rootDirectory]);

  const handleDiscardAll = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    const confirmed = await confirm({
      title: "Discard All Changes?",
      description:
        "This will permanently discard all uncommitted changes and delete untracked files. This cannot be undone.",
      confirmLabel: "Discard All",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;

    const mutationPlan = await prepareMonacoPanelsForRootMutation(activeSessionId, rootDirectory);
    if (!mutationPlan) return;

    setMutationAction("discard-all");
    setFeedback(null);
    try {
      await discardGitAllChanges(rootDirectory);
      mutationPlan.closePanels();
      setFeedback({ tone: "success", message: "All changes discarded." });
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [activeSessionId, confirm, isMutationPending, loadStatus, rootDirectory]);

  const handleStashAll = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    const mutationPlan = await prepareMonacoPanelsForRootMutation(activeSessionId, rootDirectory);
    if (!mutationPlan) return;

    setMutationAction("stash-all");
    setFeedback(null);
    try {
      const result = await stashGitChanges(rootDirectory);
      mutationPlan.closePanels();
      setFeedback({ tone: "success", message: result.message });
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [activeSessionId, isMutationPending, loadStatus, rootDirectory]);

  const handleStashPop = useCallback(async () => {
    if (!rootDirectory || isMutationPending) return;

    const mutationPlan = await prepareMonacoPanelsForRootMutation(activeSessionId, rootDirectory);
    if (!mutationPlan) return;

    setMutationAction("stash-pop");
    setFeedback(null);
    try {
      const result = await popGitStash(rootDirectory);
      mutationPlan.closePanels();
      setFeedback({ tone: "success", message: result.message });
      await loadStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setMutationAction(null);
    }
  }, [activeSessionId, isMutationPending, loadStatus, rootDirectory]);

  const handleOpenPullFromDialog = useCallback(async () => {
    setPullFromOpen(true);
    setPullFromBranch("");
    setPullFromRemotePickerOpen(false);
    setPullFromBranchPickerOpen(false);
    if (!rootDirectory) {
      setPullFromRemote("");
      setPullFromRemotes([]);
      return;
    }

    try {
      const [remoteResult, branchResult] = await Promise.all([
        listGitRemotes(rootDirectory),
        listGitBranches(rootDirectory),
      ]);
      setPullFromRemotes(remoteResult.remotes);
      setBranchState(branchResult);
      setBranchError(null);

      const currentLocalBranch =
        branchResult.branches.find((branch) => branch.isCurrent && !branch.isRemote) ?? null;
      setPullFromRemote(
        selectDefaultPullRemote(remoteResult.remotes, currentLocalBranch?.upstreamRemote ?? null),
      );
    } catch {
      setPullFromRemote("");
      setPullFromRemotes([]);
    }
  }, [rootDirectory]);

  const handlePullFromOpenChange = useCallback(
    (open: boolean) => {
      setPullFromOpen(open);
      if (!open) {
        setPullFromRemotePickerOpen(false);
        setPullFromBranchPickerOpen(false);
        releaseDialogPointerLock();
      }
    },
    [releaseDialogPointerLock],
  );

  const handleOpenCreateBranchFromDialog = useCallback(() => {
    setCreateBranchFromOpen(true);
    setCreateBranchFromName("");
    setCreateBranchFromStart("");
    setCreateBranchFromRemotePickerOpen(false);
    setCreateBranchFromBranchPickerOpen(false);
    if (!rootDirectory) {
      setCreateBranchFromRemote("");
      setCreateBranchFromRemotes([]);
      return;
    }

    void (async () => {
      try {
        const [remoteResult, branchResult] = await Promise.all([
          listGitRemotes(rootDirectory),
          listGitBranches(rootDirectory),
        ]);
        setCreateBranchFromRemotes(remoteResult.remotes);
        setBranchState(branchResult);
        setBranchError(null);

        const currentLocalBranch =
          branchResult.branches.find((branch) => branch.isCurrent && !branch.isRemote) ?? null;
        setCreateBranchFromRemote(
          selectDefaultPullRemote(remoteResult.remotes, currentLocalBranch?.upstreamRemote ?? null),
        );
      } catch {
        setCreateBranchFromRemote("");
        setCreateBranchFromRemotes([]);
      }
    })();
  }, [rootDirectory]);

  const handleCreateBranchFromOpenChange = useCallback((open: boolean) => {
    setCreateBranchFromOpen(open);
    if (!open) {
      setCreateBranchFromRemotePickerOpen(false);
      setCreateBranchFromBranchPickerOpen(false);
    }
  }, []);

  const handleCreateBranchFrom = useCallback(async () => {
    if (!rootDirectory || isMutationPending || !createBranchFromName.trim()) return;

    setCreateBranchFromLoading(true);
    setFeedback(null);
    try {
      const result = await createGitBranch(rootDirectory, createBranchFromName.trim(), {
        checkout: true,
        startPoint: createBranchFromStart.trim() || undefined,
      });
      setFeedback({ tone: "success", message: `Created and switched to ${result.branch}.` });
      setCreateBranchFromOpen(false);
      setCreateBranchFromRemote("");
      setCreateBranchFromRemotes([]);
      setCreateBranchFromRemotePickerOpen(false);
      setCreateBranchFromBranchPickerOpen(false);
      setCreateBranchFromName("");
      setCreateBranchFromStart("");
      await loadStatus();
      await loadAuthStatus();
      await loadBranches({ silent: true });
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setCreateBranchFromLoading(false);
    }
  }, [
    createBranchFromName,
    createBranchFromStart,
    isMutationPending,
    loadAuthStatus,
    loadBranches,
    loadStatus,
    rootDirectory,
  ]);

  const handleOpenAddRemoteDialog = useCallback(() => {
    setAddRemoteOpen(true);
    setAddRemoteName("");
    setAddRemoteUrl("");
  }, []);

  const handleAddRemote = useCallback(async () => {
    if (!rootDirectory || !addRemoteName.trim() || !addRemoteUrl.trim()) return;

    setAddRemoteLoading(true);
    setFeedback(null);
    try {
      await addGitRemote(rootDirectory, addRemoteName.trim(), addRemoteUrl.trim());
      setFeedback({ tone: "success", message: `Remote "${addRemoteName.trim()}" added.` });
      setAddRemoteOpen(false);
      setAddRemoteName("");
      setAddRemoteUrl("");
      await loadAuthStatus();
    } catch (err) {
      setFeedback({ tone: "error", message: formatError(err) });
    } finally {
      setAddRemoteLoading(false);
    }
  }, [addRemoteName, addRemoteUrl, loadAuthStatus, rootDirectory]);

  const handleOpenRemoveRemoteDialog = useCallback(async () => {
    setRemoveRemoteOpen(true);
    if (rootDirectory) {
      try {
        const result = await listGitRemotes(rootDirectory);
        setRemoveRemoteRemotes(result.remotes);
      } catch {
        setRemoveRemoteRemotes([]);
      }
    }
  }, [rootDirectory]);

  const handleRemoveRemote = useCallback(
    async (remoteName: string) => {
      if (!rootDirectory) return;

      const confirmed = await confirm({
        title: `Remove Remote "${remoteName}"?`,
        description: "This will remove the remote from your repository configuration.",
        confirmLabel: "Remove Remote",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) return;

      setRemoveRemoteLoading(true);
      setFeedback(null);
      try {
        await removeGitRemote(rootDirectory, remoteName);
        setFeedback({ tone: "success", message: `Remote "${remoteName}" removed.` });
        const result = await listGitRemotes(rootDirectory);
        setRemoveRemoteRemotes(result.remotes);
        await loadAuthStatus();
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setRemoveRemoteLoading(false);
      }
    },
    [confirm, loadAuthStatus, rootDirectory],
  );

  const handleOpenStashListDialog = useCallback(async () => {
    setStashListOpen(true);
    if (rootDirectory) {
      setStashListLoading(true);
      try {
        const result = await listGitStashes(rootDirectory);
        setStashEntries(result.stashes);
      } catch {
        setStashEntries([]);
      } finally {
        setStashListLoading(false);
      }
    }
  }, [rootDirectory]);

  const handleStashPopByIndex = useCallback(
    async (index: number) => {
      if (!rootDirectory) return;

      const mutationPlan = await prepareMonacoPanelsForRootMutation(activeSessionId, rootDirectory);
      if (!mutationPlan) return;

      setStashPopLoading(index);
      setFeedback(null);
      try {
        const result = await popGitStash(rootDirectory, index);
        mutationPlan.closePanels();
        setFeedback({ tone: "success", message: result.message });
        const stashResult = await listGitStashes(rootDirectory);
        setStashEntries(stashResult.stashes);
        await loadStatus();
      } catch (err) {
        setFeedback({ tone: "error", message: formatError(err) });
      } finally {
        setStashPopLoading(null);
      }
    },
    [activeSessionId, loadStatus, rootDirectory],
  );
  const gitStatusRowData = useMemo<GitStatusListRowData>(
    () => ({
      rows: gitStatusRows,
      repoRoot: status?.repoRoot ?? null,
      pendingPath,
      disableActions: isMutationPending,
      onOpenDiff: handleOpenDiff,
      onToggleStage: handleStageToggle,
      onStageAll: () => void handleStageAll(),
    }),
    [
      gitStatusRows,
      handleOpenDiff,
      handleStageAll,
      handleStageToggle,
      isMutationPending,
      pendingPath,
      status?.repoRoot,
    ],
  );
  const getGitStatusRowSize = useCallback(
    (index: number) => {
      const row = gitStatusRows[index];
      if (!row) return GIT_STATUS_ENTRY_ROW_HEIGHT;
      if (row.kind === "header") return GIT_STATUS_HEADER_ROW_HEIGHT;
      return row.entry.oldPath ? GIT_STATUS_RENAMED_ENTRY_ROW_HEIGHT : GIT_STATUS_ENTRY_ROW_HEIGHT;
    },
    [gitStatusRows],
  );

  if (!rootDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-zinc-500">
        Open a folder tab to use source control.
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col p-2">
        <div className="flex items-start gap-2 rounded border border-red-950/70 bg-red-950/30 p-2 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-red-200">Git panel failed to load</div>
            <div className="mt-1 break-words text-red-300/90">{error}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadStatus();
            void loadAuthStatus();
            void loadWorktrees();
          }}
          className="mt-2 inline-flex h-7 items-center justify-center gap-1 rounded border border-zinc-800 px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-xs text-zinc-500">
        {loading ? "Loading Git status..." : "No Git data available."}
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-3 text-center text-xs text-zinc-500">
        <FolderGit2 className="h-8 w-8 text-zinc-700" />
        <div>
          <div className="font-medium text-zinc-300">Not a Git repository</div>
          <div className="mt-1 text-zinc-500">
            Open a terminal here to initialize or inspect Git manually.
          </div>
        </div>
        <button
          type="button"
          onClick={() => handleOpenTerminal()}
          className="inline-flex h-7 items-center justify-center gap-1 rounded border border-zinc-800 px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          Open Terminal
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs text-zinc-300">
      <div className="border-b border-zinc-800 px-2 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 basis-1/2">
            <Popover open={branchPickerOpen} onOpenChange={handleBranchPickerOpenChange}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={loading || isMutationPending}
                  className="flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-zinc-100 outline-none transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <GitBranch className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="truncate font-medium">{status.branch ?? "detached"}</span>
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                  )}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80 border-zinc-800 bg-zinc-950 p-0" align="start">
                <Command className="bg-zinc-950 text-zinc-100">
                  <CommandInput
                    value={branchQuery}
                    onValueChange={setBranchQuery}
                    placeholder="Search or create branch..."
                    className="border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500"
                  />
                  <CommandList>
                    {branchLoading ? (
                      <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-400">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading branches...
                      </div>
                    ) : branchError ? (
                      <div className="px-3 py-4 text-sm text-red-300">{branchError}</div>
                    ) : (
                      <>
                        <CommandEmpty className="p-4 text-center text-zinc-500">
                          No branches found.
                        </CommandEmpty>
                        {canCreateBranch && (
                          <CommandGroup heading="Create">
                            <CommandItem
                              value={`create-${trimmedBranchQuery}`}
                              onSelect={() => void handleCreateBranch()}
                              className="cursor-pointer text-zinc-100"
                            >
                              <Plus className="h-4 w-4" />
                              <span>Create branch "{trimmedBranchQuery}"</span>
                            </CommandItem>
                          </CommandGroup>
                        )}
                        {canCreateBranch &&
                          (currentBranchEntry ||
                            localBranches.length > 0 ||
                            remoteBranches.length > 0) && (
                            <CommandSeparator className="bg-zinc-800" />
                          )}
                        {currentBranchEntry && (
                          <CommandGroup heading="Current">
                            <CommandItem
                              value={currentBranchEntry.name}
                              disabled
                              className="text-zinc-300"
                            >
                              <GitBranch className="h-4 w-4" />
                              <span>{currentBranchEntry.name}</span>
                              <span className="ml-auto text-[11px] text-zinc-500">Current</span>
                            </CommandItem>
                          </CommandGroup>
                        )}
                        {localBranches.length > 0 && (
                          <CommandGroup heading="Local branches">
                            {localBranches.map((branch) => (
                              <CommandItem
                                key={branch.name}
                                value={branch.name}
                                onSelect={() => void handleCheckoutBranch(branch)}
                                className="cursor-pointer text-zinc-100"
                              >
                                <GitBranch className="h-4 w-4" />
                                <span>{branch.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                        {remoteBranches.length > 0 && (
                          <>
                            {(currentBranchEntry || localBranches.length > 0) && (
                              <CommandSeparator className="bg-zinc-800" />
                            )}
                            <CommandGroup heading="Remote branches">
                              {remoteBranches.map((branch) => (
                                <CommandItem
                                  key={branch.name}
                                  value={branch.name}
                                  onSelect={() => void handleCheckoutBranch(branch)}
                                  className="cursor-pointer text-zinc-100"
                                >
                                  <GitBranch className="h-4 w-4" />
                                  <span>{branch.name}</span>
                                  <span className="ml-auto text-[11px] text-zinc-500">
                                    Create local
                                  </span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </>
                        )}
                      </>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex min-w-0 basis-1/2 justify-end">
            {repoDisplayName !== "Untitled" && (
              <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300">
                {isMainCheckout ? (
                  <FolderGit2 className="h-3.5 w-3.5 text-zinc-500" />
                ) : (
                  <Folders className="h-3.5 w-3.5 text-zinc-500" />
                )}
                <OverflowScrollText className="min-w-0 max-w-[120px] font-medium text-zinc-200">
                  {repoDisplayName}
                </OverflowScrollText>
              </div>
            )}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <ActionButton
            label={`Pull • ${status.behind}`}
            icon={ArrowDown}
            active={syncPending === "pull"}
            disabled={isMutationPending}
            variant={status.behind > 0 ? "warning" : "default"}
            onClick={() => void handleSyncAction("pull")}
          />
          <ActionButton
            label={`${currentBranchNeedsPublish ? "Publish" : "Push"} • ${status.ahead}`}
            icon={ArrowUp}
            active={syncPending === "push"}
            disabled={isMutationPending}
            variant={status.ahead > 0 || currentBranchNeedsPublish ? "warning" : "default"}
            onClick={() => void handleSyncAction("push")}
          />
          <ActionButton
            label="Sync"
            icon={RefreshCw}
            active={syncPending === "sync"}
            disabled={isMutationPending}
            variant={
              status.ahead > 0 || status.behind > 0 || currentBranchNeedsPublish
                ? "warning"
                : "default"
            }
            onClick={() => void handleSyncAction("sync")}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={isMutationPending}
                className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
                title="More Git actions"
              >
                <EllipsisVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuItem
                disabled={isMutationPending || authStatus?.remoteKind === "none"}
                onSelect={() => void handleSyncAction("pull")}
              >
                <ArrowDown className="h-4 w-4" />
                Pull
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending || authStatus?.remoteKind === "none"}
                onSelect={() => void handleSyncAction("push")}
              >
                <ArrowUp className="h-4 w-4" />
                Push
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={
                  isMutationPending ||
                  authStatus?.remoteKind === "none" ||
                  !currentBranchNeedsPublish
                }
                onSelect={() => void handleSyncAction("push")}
              >
                <ArrowUp className="h-4 w-4" />
                Publish
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending || authStatus?.remoteKind === "none"}
                onSelect={() => void handleSyncAction("sync")}
              >
                <RefreshCw className="h-4 w-4" />
                Sync
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isMutationPending || authStatus?.remoteKind === "none"}
                onSelect={() => void handleFetchAction()}
              >
                {mutationAction === "fetch" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Fetch
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending || authStatus?.remoteKind === "none"}
                onSelect={() => void handleOpenPullFromDialog()}
              >
                <ArrowDown className="h-4 w-4" />
                Merge From...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setBranchPickerOpen(true)}
                disabled={isMutationPending}
              >
                <GitBranch className="h-4 w-4" />
                Create Branch...
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending}
                onSelect={() => handleOpenCreateBranchFromDialog()}
              >
                <GitBranch className="h-4 w-4" />
                Create Branch From...
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending}
                onSelect={handleOpenCreateWorktreeDialog}
              >
                <FolderGit2 className="h-4 w-4" />
                Create Worktree...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isMutationPending || status.isClean}
                onSelect={() => void handleStageAll()}
              >
                {mutationAction === "stage-all" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Stage All
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending || stagedCount === 0}
                onSelect={() => void handleUnstageAll()}
              >
                {mutationAction === "unstage-all" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Minus className="h-4 w-4" />
                )}
                Unstage All
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending || status.isClean}
                onSelect={() => void handleDiscardAll()}
                className="text-red-400 focus:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                Discard All Changes
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isMutationPending || status.isClean}
                onSelect={() => void handleStashAll()}
              >
                {mutationAction === "stash-all" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Stash All
              </DropdownMenuItem>
              <DropdownMenuItem disabled={isMutationPending} onSelect={() => void handleStashPop()}>
                {mutationAction === "stash-pop" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Minus className="h-4 w-4" />
                )}
                Stash Pop
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleOpenStashListDialog()}>
                <RefreshCw className="h-4 w-4" />
                Stash List
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={isMutationPending}
                onSelect={() => handleOpenAddRemoteDialog()}
              >
                <Plus className="h-4 w-4" />
                Add Remote...
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isMutationPending}
                onSelect={() => void handleOpenRemoveRemoteDialog()}
              >
                <Minus className="h-4 w-4" />
                Remove Remote...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {feedback && (
        <div
          className={cn(
            "flex items-start gap-2 border-b px-2 py-1.5 text-[11px]",
            feedback.tone === "error"
              ? "border-red-950/70 bg-red-950/30 text-red-300"
              : "border-emerald-950/70 bg-emerald-950/20 text-emerald-300",
          )}
        >
          <div className="min-w-0 flex-1 break-words">{feedback.message}</div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className={cn(
              "mt-[-1px] flex h-5 w-5 shrink-0 items-center justify-center rounded text-current opacity-60 transition hover:bg-white/5 hover:opacity-100",
              feedback.tone === "error" ? "hover:text-red-100" : "hover:text-emerald-100",
            )}
            title="Dismiss"
            aria-label="Dismiss Git message"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <WorktreeSection
          worktrees={visibleWorktrees}
          allWorktrees={worktrees}
          loading={worktreeLoading}
          error={worktreeError}
          openWorktreePaths={openWorktreePaths}
          removingWorktreePath={removingWorktreePath}
          hiddenWorktreePaths={hiddenWorktreePaths}
          managerOpen={worktreeManagerOpen}
          onCreateWorktree={handleOpenCreateWorktreeDialog}
          onRefresh={() => void loadWorktrees()}
          onOpenManager={() => setWorktreeManagerOpen(true)}
          onOpenManagerChange={setWorktreeManagerOpen}
          onOpenWorktree={handleOpenWorktree}
          onToggleHidden={setWorktreeHidden}
          onRemoveWorktree={(worktree) => void handleRemoveWorktree(worktree)}
        />
        {status.isClean ? (
          <div className="flex min-h-[160px] flex-1 items-center justify-center overflow-y-auto px-3 text-center text-xs text-zinc-500">
            Working tree is clean.
          </div>
        ) : (
          <div ref={statusListViewportRef} className="min-h-0 flex-1 border-t border-zinc-900">
            <VariableSizeList
              ref={statusListRef}
              height={Math.max(statusListHeight, GIT_STATUS_HEADER_ROW_HEIGHT)}
              width="100%"
              itemCount={gitStatusRows.length}
              itemSize={getGitStatusRowSize}
              itemData={gitStatusRowData}
              itemKey={(index, data) => data.rows[index]?.key ?? index}
              overscanCount={8}
            >
              {GitStatusListRow}
            </VariableSizeList>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Commit message"
          rows={3}
          disabled={branchActionPending || syncPending !== null}
          className="w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none transition-colors focus:border-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-2 flex items-stretch gap-2">
          <div className="grid h-7 min-w-[96px] shrink-0 grid-rows-2 overflow-hidden rounded border border-zinc-800 bg-zinc-900 text-[11px] text-zinc-400">
            <div className="flex items-center px-2">{stagedCount} staged</div>
            <div className="flex items-center border-t border-zinc-800 px-2">
              {changeCount} changes
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded bg-zinc-100 px-2 text-xs font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {commitPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-3.5 w-3.5" />
            )}
            Commit
          </button>
        </div>
      </div>

      {/* Merge From Dialog */}
      <Dialog open={pullFromOpen} onOpenChange={handlePullFromOpenChange}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Merge From Remote Branch</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Fetch a remote branch and merge it into the current branch in this checkout.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-zinc-400">Remote</label>
              {pullFromRemotes.length > 0 ? (
                <GitRemotePicker
                  value={pullFromRemote}
                  remotes={pullFromRemotes}
                  open={pullFromRemotePickerOpen}
                  onOpenChange={setPullFromRemotePickerOpen}
                  onValueChange={(remote) => {
                    setPullFromRemote(remote);
                    setPullFromBranch("");
                    setPullFromBranchPickerOpen(false);
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={pullFromRemote}
                  onChange={(e) => setPullFromRemote(e.target.value)}
                  placeholder="origin"
                  className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                />
              )}
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-zinc-400">Branch</label>
              <Popover open={pullFromBranchPickerOpen} onOpenChange={setPullFromBranchPickerOpen}>
                <PopoverAnchor asChild>
                  <div className="flex min-w-0 max-w-full items-center rounded border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600">
                    <input
                      type="text"
                      value={pullFromBranch}
                      onChange={(e) => {
                        setPullFromBranch(e.target.value);
                        setPullFromBranchPickerOpen(true);
                      }}
                      onFocus={() => setPullFromBranchPickerOpen(true)}
                      placeholder="Select a branch to merge"
                      className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setPullFromBranchPickerOpen((open) => !open)}
                      className="flex items-center justify-center px-2 text-zinc-500 transition-colors hover:text-zinc-200"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-anchor-width)] max-w-[calc(100vw-2rem)] border-zinc-800 bg-zinc-950 p-0 text-zinc-100"
                >
                  <Command shouldFilter={false} className="bg-zinc-950 text-zinc-100">
                    <CommandList>
                      <CommandEmpty className="p-3 text-xs text-zinc-500">
                        {pullFromRemote.trim()
                          ? `No branches found for ${pullFromRemote}.`
                          : "Select a remote first."}
                      </CommandEmpty>
                      {filteredPullFromRemoteBranches.length > 0 && (
                        <CommandGroup heading="Remote branches">
                          {filteredPullFromRemoteBranches.map((branch) => (
                            <CommandItem
                              key={branch.name}
                              value={branch.name}
                              onSelect={() => {
                                setPullFromBranch(remoteBranchLocalName(branch.name));
                                setPullFromBranchPickerOpen(false);
                              }}
                              className="min-w-0 cursor-pointer text-zinc-100"
                            >
                              <GitBranch className="h-4 w-4" />
                              <span className="min-w-0 truncate">{branch.name}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => handlePullFromOpenChange(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handlePullFromAction()}
              disabled={!pullFromRemote.trim() || !pullFromBranch.trim() || pullFromLoading}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {pullFromLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Merge"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Branch From Dialog */}
      <Dialog open={createBranchFromOpen} onOpenChange={handleCreateBranchFromOpenChange}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Create Branch From...</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Create a new branch from a specific start point.
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-3">
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-zinc-400">Branch name</label>
              <input
                type="text"
                value={createBranchFromName}
                onChange={(e) => setCreateBranchFromName(e.target.value)}
                placeholder="my-feature"
                className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-zinc-400">Remote</label>
              {createBranchFromRemotes.length > 0 ? (
                <GitRemotePicker
                  value={createBranchFromRemote}
                  remotes={createBranchFromRemotes}
                  open={createBranchFromRemotePickerOpen}
                  onOpenChange={setCreateBranchFromRemotePickerOpen}
                  onValueChange={(remote) => {
                    setCreateBranchFromRemote(remote);
                    setCreateBranchFromStart("");
                    setCreateBranchFromBranchPickerOpen(false);
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={createBranchFromRemote}
                  onChange={(e) => setCreateBranchFromRemote(e.target.value)}
                  placeholder="origin"
                  className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                />
              )}
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs text-zinc-400">Remote branch</label>
              <Popover
                open={createBranchFromBranchPickerOpen}
                onOpenChange={setCreateBranchFromBranchPickerOpen}
              >
                <PopoverAnchor asChild>
                  <div
                    className={cn(
                      "flex min-w-0 max-w-full items-center rounded border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600",
                      !createBranchFromRemote.trim() && "opacity-60",
                    )}
                  >
                    <input
                      type="text"
                      value={createBranchFromStart}
                      onChange={(e) => {
                        setCreateBranchFromStart(e.target.value);
                        if (createBranchFromRemote.trim()) {
                          setCreateBranchFromBranchPickerOpen(true);
                        }
                      }}
                      onFocus={() => {
                        if (createBranchFromRemote.trim()) {
                          setCreateBranchFromBranchPickerOpen(true);
                        }
                      }}
                      placeholder={
                        createBranchFromRemote.trim()
                          ? `Select a branch from ${createBranchFromRemote}`
                          : "Select a remote first"
                      }
                      disabled={!createBranchFromRemote.trim()}
                      className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none disabled:cursor-not-allowed"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!createBranchFromRemote.trim()) return;
                        setCreateBranchFromBranchPickerOpen((open) => !open);
                      }}
                      disabled={!createBranchFromRemote.trim()}
                      className="flex items-center justify-center px-2 text-zinc-500 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </PopoverAnchor>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-anchor-width)] max-w-[calc(100vw-2rem)] border-zinc-800 bg-zinc-950 p-0 text-zinc-100"
                >
                  <Command shouldFilter={false} className="bg-zinc-950 text-zinc-100">
                    <CommandList>
                      <CommandEmpty className="p-3 text-xs text-zinc-500">
                        {createBranchFromRemote.trim()
                          ? `No branches found for ${createBranchFromRemote}.`
                          : "Select a remote first."}
                      </CommandEmpty>
                      {filteredCreateBranchFromRemoteBranches.length > 0 && (
                        <CommandGroup heading="Remote branches">
                          {filteredCreateBranchFromRemoteBranches.map((branch) => (
                            <CommandItem
                              key={branch.name}
                              value={branch.name}
                              onSelect={() => {
                                setCreateBranchFromStart(branch.name);
                                setCreateBranchFromBranchPickerOpen(false);
                              }}
                              className="min-w-0 cursor-pointer text-zinc-100"
                            >
                              <GitBranch className="h-4 w-4" />
                              <span className="min-w-0 truncate">{branch.name}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Start point (optional)</label>
              <input
                type="text"
                value={createBranchFromStart}
                onChange={(e) => setCreateBranchFromStart(e.target.value)}
                placeholder="main, v1.0, abc1234"
                className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => handleCreateBranchFromOpenChange(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreateBranchFrom()}
              disabled={!createBranchFromName.trim() || createBranchFromLoading}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {createBranchFromLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Create"
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Worktree Dialog */}
      <Dialog open={createWorktreeOpen} onOpenChange={setCreateWorktreeOpen}>
        <DialogContent className="max-w-md border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Create Worktree</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                {createWorktreeUseExistingBranch ? "Existing branch" : "Branch"}
              </label>
              {createWorktreeUseExistingBranch ? (
                <Popover
                  open={createWorktreeBranchPickerOpen}
                  onOpenChange={setCreateWorktreeBranchPickerOpen}
                >
                  <PopoverAnchor asChild>
                    <div className="flex items-center rounded border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600">
                      <input
                        type="text"
                        value={createWorktreeBranchName}
                        onChange={(e) => {
                          setCreateWorktreeBranchName(e.target.value);
                          setCreateWorktreeBranchPickerOpen(true);
                        }}
                        onFocus={() => setCreateWorktreeBranchPickerOpen(true)}
                        placeholder="Select a local branch"
                        className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setCreateWorktreeBranchPickerOpen((open) => !open)}
                        className="flex items-center justify-center px-2 text-zinc-500 transition-colors hover:text-zinc-200"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </PopoverAnchor>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-anchor-width)] border-zinc-800 bg-zinc-950 p-0 text-zinc-100"
                  >
                    <Command shouldFilter={false} className="bg-zinc-950 text-zinc-100">
                      <CommandList>
                        {branchLoading ? (
                          <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-400">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading branches...
                          </div>
                        ) : (
                          <>
                            <CommandEmpty className="p-3 text-xs text-zinc-500">
                              No matching local branches.
                            </CommandEmpty>
                            {filteredCreateWorktreeExistingBranches.length > 0 && (
                              <CommandGroup heading="Local branches">
                                {filteredCreateWorktreeExistingBranches.map((branch) => (
                                  <CommandItem
                                    key={branch.name}
                                    value={branch.name}
                                    onSelect={() => {
                                      setCreateWorktreeBranchName(branch.name);
                                      setCreateWorktreeBranchPickerOpen(false);
                                    }}
                                    className="cursor-pointer text-zinc-100"
                                  >
                                    <GitBranch className="h-4 w-4" />
                                    <span>{branch.name}</span>
                                    {branch.isCurrent && (
                                      <span className="ml-auto text-[11px] text-zinc-500">
                                        Current
                                      </span>
                                    )}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            )}
                          </>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              ) : (
                <input
                  type="text"
                  value={createWorktreeBranchName}
                  onChange={(e) => setCreateWorktreeBranchName(e.target.value)}
                  placeholder="my-feature"
                  className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                />
              )}
              {trimmedCreateWorktreeBranchName ? (
                <div className="mt-1 text-[11px] text-zinc-500">
                  {createWorktreeUseExistingBranch
                    ? !existingCreateWorktreeBranchAvailable
                      ? "Choose an existing local branch from this repository."
                      : null
                    : branchNameExists(branchState?.branches ?? [], trimmedCreateWorktreeBranchName)
                      ? "That branch already exists locally."
                      : !isLikelyValidBranchName(trimmedCreateWorktreeBranchName)
                        ? "Enter a valid branch name."
                        : null}
                </div>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Destination path</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={effectiveCreateWorktreePath}
                  onChange={(e) => {
                    setCreateWorktreePath(e.target.value);
                    setCreateWorktreePathEdited(true);
                  }}
                  placeholder={suggestWorktreePath(status?.repoRoot ?? rootDirectory, "my-feature")}
                  className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => void handleBrowseCreateWorktreePath()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                  title="Browse for destination"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="rounded border border-zinc-800 bg-zinc-900/70">
              <button
                type="button"
                onClick={() => setCreateWorktreeAdvancedOpen((open) => !open)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800/80"
              >
                <span>Advanced options</span>
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 text-zinc-500 transition-transform",
                    createWorktreeAdvancedOpen && "rotate-180",
                  )}
                />
              </button>
              {createWorktreeAdvancedOpen && (
                <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 rounded border border-zinc-800 px-2 py-2">
                    <div className="text-xs text-zinc-200">Use existing branch</div>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateWorktreeUseExistingBranch((value) => !value);
                        setCreateWorktreeBranchPickerOpen(false);
                      }}
                      className={cn(
                        "rounded border px-2 py-1 text-[11px] transition-colors",
                        createWorktreeUseExistingBranch
                          ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                          : "border-zinc-800 text-zinc-400 hover:bg-zinc-800",
                      )}
                    >
                      {createWorktreeUseExistingBranch ? "On" : "Off"}
                    </button>
                  </div>

                  {!createWorktreeUseExistingBranch && (
                    <div>
                      <label className="mb-1 block text-xs text-zinc-400">
                        Start point (optional)
                      </label>
                      <input
                        type="text"
                        value={createWorktreeStartPoint}
                        onChange={(e) => setCreateWorktreeStartPoint(e.target.value)}
                        placeholder="main, v1.0, abc1234"
                        className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded border border-zinc-800 px-2 py-2">
              <div className="text-xs text-zinc-200">Open in new tab after create</div>
              <button
                type="button"
                onClick={() => setCreateWorktreeOpenAfterCreate((value) => !value)}
                className={cn(
                  "rounded border px-2 py-1 text-[11px] transition-colors",
                  createWorktreeOpenAfterCreate
                    ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 text-zinc-400 hover:bg-zinc-800",
                )}
              >
                {createWorktreeOpenAfterCreate ? "On" : "Off"}
              </button>
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setCreateWorktreeOpen(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreateWorktree()}
              disabled={!canCreateWorktree || createWorktreeLoading}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {createWorktreeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Remote Dialog */}
      <Dialog open={addRemoteOpen} onOpenChange={setAddRemoteOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Add Remote</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Add a new remote repository reference.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Remote name</label>
              <input
                type="text"
                value={addRemoteName}
                onChange={(e) => setAddRemoteName(e.target.value)}
                placeholder="origin"
                className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">URL</label>
              <input
                type="text"
                value={addRemoteUrl}
                onChange={(e) => setAddRemoteUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
                className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setAddRemoteOpen(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleAddRemote()}
              disabled={!addRemoteName.trim() || !addRemoteUrl.trim() || addRemoteLoading}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {addRemoteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add Remote"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Remote Dialog */}
      <Dialog open={removeRemoteOpen} onOpenChange={setRemoveRemoteOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Remove Remote</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Remove a remote repository reference from your configuration.
            </DialogDescription>
          </DialogHeader>
          {removeRemoteRemotes.length === 0 ? (
            <div className="py-4 text-center text-xs text-zinc-500">
              {removeRemoteLoading ? "Loading remotes..." : "No remotes configured."}
            </div>
          ) : (
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {removeRemoteRemotes.map((remote) => (
                <div
                  key={remote.name}
                  className="flex items-center justify-between rounded border border-zinc-800 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-zinc-200">{remote.name}</div>
                    <div className="truncate text-[11px] text-zinc-500">{remote.url}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRemoveRemote(remote.name)}
                    disabled={removeRemoteLoading}
                    className="ml-2 flex h-6 shrink-0 items-center justify-center rounded px-2 text-xs text-red-400 transition-colors hover:bg-red-950/50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setRemoveRemoteOpen(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Stash List Dialog */}
      <Dialog open={stashListOpen} onOpenChange={setStashListOpen}>
        <DialogContent className="max-w-sm border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Stash List</DialogTitle>
            <DialogDescription className="text-zinc-400">
              View and manage your stashed changes.
            </DialogDescription>
          </DialogHeader>
          {stashEntries.length === 0 ? (
            <div className="py-4 text-center text-xs text-zinc-500">
              {stashListLoading ? "Loading stashes..." : "No stashes found."}
            </div>
          ) : (
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {stashEntries.map((stash) => (
                <div
                  key={stash.index}
                  className="flex items-center justify-between rounded border border-zinc-800 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-zinc-200">{stash.message}</div>
                    {stash.branch && (
                      <div className="text-[11px] text-zinc-500">Branch: {stash.branch}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleStashPopByIndex(stash.index)}
                    disabled={stashPopLoading !== null}
                    className="ml-2 flex h-6 shrink-0 items-center justify-center rounded px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {stashPopLoading === stash.index ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Pop"
                    )}
                  </button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setStashListOpen(false)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface WorktreeSectionProps {
  worktrees: GitWorktreeEntry[];
  allWorktrees: GitWorktreeEntry[];
  loading: boolean;
  error: string | null;
  openWorktreePaths: Set<string>;
  removingWorktreePath: string | null;
  hiddenWorktreePaths: Set<string>;
  managerOpen: boolean;
  onCreateWorktree: () => void;
  onRefresh: () => void;
  onOpenManager: () => void;
  onOpenManagerChange: (open: boolean) => void;
  onOpenWorktree: (worktreePath: string) => void;
  onToggleHidden: (worktreePath: string, hidden: boolean) => void;
  onRemoveWorktree: (worktree: GitWorktreeEntry) => void;
}

function WorktreeSection({
  worktrees,
  allWorktrees,
  loading,
  error,
  openWorktreePaths,
  removingWorktreePath,
  hiddenWorktreePaths,
  managerOpen,
  onCreateWorktree,
  onRefresh,
  onOpenManager,
  onOpenManagerChange,
  onOpenWorktree,
  onToggleHidden,
  onRemoveWorktree,
}: WorktreeSectionProps) {
  return (
    <div className="border-b border-zinc-900 px-2 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Worktrees
            </div>
            <button
              type="button"
              onClick={onOpenManager}
              className="rounded border border-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              {allWorktrees.length} total
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCreateWorktree}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Create worktree"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            title="Refresh worktrees"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-2 rounded border border-red-950/70 bg-red-950/30 px-2 py-2 text-[11px] text-red-300">
          {error}
        </div>
      ) : loading && worktrees.length === 0 ? (
        <div className="mt-2 flex items-center gap-2 rounded border border-zinc-800 px-2 py-2 text-[11px] text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading worktrees...
        </div>
      ) : (
        <>
          <div className="mt-2 space-y-1">
            {worktrees.map((worktree) => {
              const canRemove = !worktree.isMain && !worktree.isCurrent;
              const removePending = removingWorktreePath === worktree.path;
              return (
                <div
                  key={worktree.path}
                  className={cn(
                    "flex items-center gap-2 rounded border px-2 py-2",
                    worktree.isCurrent
                      ? "border-emerald-900/80 bg-emerald-950/10"
                      : "border-zinc-800",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onOpenWorktree(worktree.path)}
                    disabled={worktree.isCurrent}
                    className="min-w-0 flex-1 text-left disabled:cursor-default"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {worktree.isMain ? (
                        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      ) : (
                        <Folders className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      )}
                      <div className="truncate text-zinc-200">
                        {worktree.isDetached ? "Detached HEAD" : (worktree.branch ?? "Branch")}
                      </div>
                      {worktree.isMain && <WorktreeChip label="Main" />}
                      {worktree.isLocked && <WorktreeChip label="Locked" />}
                      {worktree.isPrunable && <WorktreeChip label="Prunable" />}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleHidden(worktree.path, true)}
                    className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                    title="Hide worktree"
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                  </button>
                  {canRemove && (
                    <button
                      type="button"
                      onClick={() => onRemoveWorktree(worktree)}
                      disabled={removePending}
                      className="flex h-6 w-6 items-center justify-center rounded text-red-400 transition-colors hover:bg-red-950/50 disabled:opacity-50"
                      title="Remove worktree"
                    >
                      {removePending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      <Dialog open={managerOpen} onOpenChange={onOpenManagerChange}>
        <DialogContent className="max-w-lg border-zinc-800 bg-zinc-950 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Worktrees Manager</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Show, hide, and review all worktrees for this repository.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
            {allWorktrees.map((worktree) => {
              const normalizedPath = normalizePathForComparison(worktree.path);
              const hidden = hiddenWorktreePaths.has(normalizedPath);
              const isOpen = openWorktreePaths.has(normalizedPath);
              return (
                <div
                  key={`manager:${worktree.path}`}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2.5",
                    worktree.isCurrent
                      ? "border-emerald-900/80 bg-emerald-950/10"
                      : "border-zinc-800 bg-zinc-900/50",
                  )}
                >
                  {worktree.isMain ? (
                    <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-500" />
                  ) : (
                    <Folders className="h-4 w-4 shrink-0 text-zinc-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-200">
                        {worktree.isDetached ? "Detached HEAD" : (worktree.branch ?? "Branch")}
                      </span>
                      {worktree.isMain && (
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                          Main
                        </span>
                      )}
                      {worktree.isCurrent && (
                        <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-300">
                          Current
                        </span>
                      )}
                      {isOpen && (
                        <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-300">
                          Open
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-zinc-500">{worktree.path}</div>
                  </div>
                  {!worktree.isMain && (
                    <button
                      type="button"
                      onClick={() => onRemoveWorktree(worktree)}
                      disabled={worktree.isCurrent}
                      className="inline-flex h-7 items-center gap-1 rounded border border-red-900/50 px-2.5 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-950/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                      title={
                        worktree.isCurrent ? "Open a different worktree first" : "Remove worktree"
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenWorktree(worktree.path)}
                    disabled={worktree.isCurrent}
                    className="inline-flex h-7 items-center gap-1 rounded border border-zinc-700 px-2.5 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                    title={worktree.isCurrent ? "Already open" : "Open worktree in new tab"}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleHidden(worktree.path, !hidden)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1 rounded border px-2.5 text-[11px] font-medium transition-colors",
                      hidden
                        ? "border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                        : "border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
                    )}
                    title={hidden ? "Show worktree" : "Hide worktree"}
                  >
                    {hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    {hidden ? "Show" : "Hide"}
                  </button>
                </div>
              );
            })}
          </div>
          <DialogFooter className="border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => onOpenManagerChange(false)}
              className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorktreeChip({ label }: { label: string }) {
  return (
    <span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
      {label}
    </span>
  );
}

function GitRemotePicker({
  value,
  remotes,
  open,
  onOpenChange,
  onValueChange,
}: {
  value: string;
  remotes: GitRemoteInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
}) {
  const selectedRemote = remotes.find((remote) => remote.name === value);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left text-xs text-zinc-200 outline-none transition-colors hover:bg-zinc-800 focus:border-zinc-600"
        >
          <span
            className={cn(
              "block min-w-0 max-w-full flex-1 truncate",
              !selectedRemote && "text-zinc-500",
            )}
          >
            {selectedRemote ? `${selectedRemote.name} (${selectedRemote.url})` : "Select remote..."}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] border-zinc-800 bg-zinc-950 p-0 text-zinc-100"
      >
        <Command shouldFilter={false} className="bg-zinc-950 text-zinc-100">
          <CommandList>
            <CommandEmpty className="p-3 text-xs text-zinc-500">
              No remotes configured.
            </CommandEmpty>
            <CommandGroup heading="Remotes">
              {remotes.map((remote) => (
                <CommandItem
                  key={remote.name}
                  value={remote.name}
                  onSelect={() => {
                    onValueChange(remote.name);
                    onOpenChange(false);
                  }}
                  className="min-w-0 cursor-pointer text-zinc-100"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-zinc-100">{remote.name}</div>
                    <div className="truncate text-[11px] text-zinc-500">{remote.url}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function GitStatusListRow({ index, style, data }: ListChildComponentProps<GitStatusListRowData>) {
  const row = data.rows[index];
  if (!row) {
    return <div style={style} />;
  }

  if (row.kind === "header") {
    return (
      <div
        style={style}
        className={cn(
          "flex items-center justify-between px-2",
          index > 0 ? "border-t border-zinc-900" : "",
        )}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          {row.title} ({row.count})
        </span>
        {row.showToggleAll && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onStageAll();
            }}
            disabled={data.disableActions}
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            title="Stage All"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  const { entry } = row;
  const actionKey = `${entry.staged ? "unstage" : "stage"}:${entry.path}`;
  const isPending = data.pendingPath === actionKey;

  return (
    <div style={style}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => data.onOpenDiff(entry)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            data.onOpenDiff(entry);
          }
        }}
        className="group flex h-full w-full items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-zinc-900"
        title={entry.path}
      >
        <StatusBadge kind={entry.kind} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-zinc-200">{relativePath(data.repoRoot, entry.path)}</div>
          {entry.oldPath && (
            <div className="truncate text-[11px] text-zinc-500">
              from {relativePath(data.repoRoot, entry.oldPath)}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void data.onToggleStage(entry);
          }}
          disabled={data.disableActions}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          title={entry.staged ? "Unstage" : "Stage"}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : entry.staged ? (
            <Minus className="h-3.5 w-3.5" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function ActionButton({
  label,
  icon: Icon,
  active,
  disabled,
  variant = "default",
  onClick,
}: {
  label: string;
  icon: typeof RefreshCw;
  active?: boolean;
  disabled?: boolean;
  variant?: "default" | "warning";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-6 min-w-[78px] items-center justify-center gap-1 rounded border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "warning"
          ? "border-amber-900/70 bg-amber-950/30 text-amber-200 hover:bg-amber-950/45"
          : "border-zinc-800 text-zinc-300 hover:bg-zinc-800",
      )}
    >
      {active ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      {label}
    </button>
  );
}

function OverflowScrollText({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

function StatusBadge({ kind }: { kind: GitEntryKind }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold uppercase",
        badgeClassName(kind),
      )}
    >
      {badgeLabel(kind)}
    </span>
  );
}

function badgeLabel(kind: GitEntryKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    default:
      return "M";
  }
}

function badgeClassName(kind: GitEntryKind): string {
  switch (kind) {
    case "added":
      return "border-emerald-900 bg-emerald-950/40 text-emerald-300";
    case "deleted":
      return "border-red-900 bg-red-950/40 text-red-300";
    case "renamed":
    case "copied":
      return "border-sky-900 bg-sky-950/40 text-sky-300";
    case "untracked":
      return "border-amber-900 bg-amber-950/40 text-amber-300";
    case "conflicted":
      return "border-fuchsia-900 bg-fuchsia-950/40 text-fuchsia-300";
    default:
      return "border-zinc-800 bg-zinc-900 text-zinc-300";
  }
}

function diffPanelName(entry: GitStatusEntry): string {
  const suffix = entry.staged ? "staged" : "changes";
  return `${basename(entry.path)} (${suffix})`;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "Untitled";
}

function relativePath(root: string | null, path: string): string {
  if (!root) return path;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath === normalizedRoot) return ".";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return path;
}

function normalizePathForComparison(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isPathInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function suggestWorktreePath(root: string | null, branchName: string): string {
  if (!root) return "";

  const trimmedRoot = root.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(trimmedRoot.lastIndexOf("/"), trimmedRoot.lastIndexOf("\\"));
  const separator = trimmedRoot.includes("\\") ? "\\" : "/";
  const parent =
    lastSeparator > 0
      ? trimmedRoot.slice(0, lastSeparator)
      : lastSeparator === 0
        ? trimmedRoot.slice(0, 1)
        : "";
  const base = lastSeparator >= 0 ? trimmedRoot.slice(lastSeparator + 1) : trimmedRoot;
  const suffix = sanitizeWorktreeSegment(branchName) || "worktree";
  const joiner = parent && !parent.endsWith("/") && !parent.endsWith("\\") ? separator : "";
  return parent ? `${parent}${joiner}${base}-${suffix}` : `${base}-${suffix}`;
}

function sanitizeWorktreeSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function remoteBranchLocalName(remoteName: string): string {
  const parts = remoteName.split("/");
  if (parts.length <= 1) return remoteName;
  return parts.slice(1).join("/");
}

function selectDefaultPullRemote(
  remotes: GitRemoteInfo[],
  upstreamRemote: string | null | undefined,
): string {
  const trimmedUpstream = upstreamRemote?.trim();
  if (trimmedUpstream && remotes.some((remote) => remote.name === trimmedUpstream)) {
    return trimmedUpstream;
  }

  const originRemote = remotes.find((remote) => remote.name === "origin");
  if (originRemote) {
    return originRemote.name;
  }

  return remotes[0]?.name ?? "";
}

function branchNameExists(branches: GitBranchRef[], branchName: string): boolean {
  return branches.some((branch) => !branch.isRemote && branch.name === branchName);
}

function isLikelyValidBranchName(branchName: string): boolean {
  if (!branchName) return false;
  if (branchName === "." || branchName === "@") return false;
  if (branchName.startsWith("/") || branchName.endsWith("/")) return false;
  if (branchName.startsWith(".") || branchName.endsWith(".")) return false;
  if (branchName.endsWith(".lock")) return false;
  if (branchName.includes("..") || branchName.includes("@{") || branchName.includes("//")) {
    return false;
  }
  if (/[~^:?*[\]\\\s]/.test(branchName)) return false;
  return true;
}

function syncActionLabel(action: GitSyncAction): string {
  switch (action) {
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    default:
      return "Sync";
  }
}

function formatError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}
