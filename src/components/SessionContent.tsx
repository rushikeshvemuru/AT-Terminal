import { useEffect, useMemo, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Clock3, FolderOpen, Plus, Search, TerminalSquare, Trash2 } from "lucide-react";
import { useSessionStore, type Session } from "@/store/useSessionStore";
import { useTabStore } from "@/store/useTabStore";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { useSessionList } from "@/hooks/useSessionList";
import { savePersistedTabState } from "@/lib/tabPersistence";
import { selectWorkspaceRoot } from "@/lib/workspaceRoots";
import { cn } from "@/lib/utils";

type LauncherMode = "create" | "folder" | null;

interface FolderDraft {
  path: string;
  name: string;
}

function formatRelativeTime(isoString: string) {
  const timestamp = new Date(isoString).getTime();
  if (Number.isNaN(timestamp)) return "unknown";

  const diffInSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffInSeconds < 60) return "just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;

  return new Date(isoString).toLocaleDateString();
}

function basename(path: string) {
  return (
    path

      .replace(/[/\\]+$/, "")

      .split(/[/\\]/)

      .filter(Boolean)

      .pop() ?? ""
  );
}

function getSessionRoots(session: Session) {
  const roots = session.tab_state?.tabs
    .map((tab) => tab.root_directory?.trim())
    .filter((root): root is string => Boolean(root));

  return Array.from(new Set(roots ?? []));
}

function getSessionSummary(session: Session) {
  const tabs = session.tab_state?.tabs ?? [];
  const visibleTabs = tabs.filter((tab) => !tab.detached);
  const roots = getSessionRoots(session);

  if (tabs.length === 0) return "No tabs saved";

  const tabLabel = `${visibleTabs.length || tabs.length} ${
    (visibleTabs.length || tabs.length) === 1 ? "tab" : "tabs"
  }`;
  if (roots.length === 0) return tabLabel;
  if (roots.length === 1) return `${tabLabel} in ${basename(roots[0]) || roots[0]}`;
  return `${tabLabel} across ${roots.length} folders`;
}

function sessionMatchesQuery(session: Session, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const roots = getSessionRoots(session);
  const haystack = [session.name, session.created_at, session.last_accessed, ...roots]
    .join(" ")
    .toLowerCase();

  return haystack.includes(normalizedQuery);
}

export const SessionContent = () => {
  const { navState, openSession, setNavState } = useSessionStore();
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const { sessions, refreshSessions } = useSessionList();
  const addTab = useTabStore((s) => s.addTab);
  const confirm = useConfirmationStore((s) => s.confirm);
  const [mode, setMode] = useState<LauncherMode>(null);
  const [sessionName, setSessionName] = useState("");
  const [folderDraft, setFolderDraft] = useState<FolderDraft | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [folderPicking, setFolderPicking] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort(
        (left, right) =>
          new Date(right.last_accessed).getTime() - new Date(left.last_accessed).getTime(),
      ),
    [sessions],
  );

  const latestSession = sortedSessions[0] ?? null;
  const filteredSessions = useMemo(
    () => sortedSessions.filter((session) => sessionMatchesQuery(session, query)),
    [query, sortedSessions],
  );

  const resetInlineForm = () => {
    setNavState("SESSION_SELECTION");
    setMode(null);
    setSessionName("");
    setFolderDraft(null);
    setError(null);
  };

  const navMode: LauncherMode = navState === "NEW_SESSION_FORM" ? "create" : null;
  const activeMode = navMode ?? mode;

  const handleCreateSession = async () => {
    const trimmedName = sessionName.trim();
    if (!trimmedName || creating) return;

    setCreating(true);
    setError(null);
    try {
      const session = await invoke<Session>("create_session", { name: trimmedName });
      await openSession(session);
    } catch (e) {
      setError(`Could not create session: ${e}`);
    } finally {
      setCreating(false);
    }
  };

  const handlePickFolder = async () => {
    if (folderPicking) return;

    setFolderPicking(true);
    setError(null);
    try {
      const selected = await selectWorkspaceRoot("Open Folder");
      if (!selected?.path.trim()) return;

      const folderName = basename(selected.path) || "Workspace";
      setNavState("SESSION_SELECTION");
      setFolderDraft({ path: selected.path, name: folderName });
      setMode("folder");
    } catch (e) {
      setError(`Could not open folder picker: ${e}`);
    } finally {
      setFolderPicking(false);
    }
  };

  const handleCreateFolderSession = async () => {
    const trimmedName = folderDraft?.name.trim() ?? "";
    const rootDirectory = folderDraft?.path.trim() ?? "";
    if (!trimmedName || !rootDirectory || creating) return;

    setCreating(true);
    setError(null);
    try {
      const session = await invoke<Session>("create_session", { name: trimmedName });
      await openSession(session);
      const tabId = addTab(session.id, rootDirectory);
      const sessionState = useTabStore.getState().sessionStates[session.id];
      if (!tabId || !sessionState) {
        throw new Error("Could not create a tab for the selected folder");
      }
      await savePersistedTabState(session.id, sessionState);
    } catch (e) {
      setError(`Could not open folder session: ${e}`);
    } finally {
      setCreating(false);
    }
  };

  const handleOpenSession = async (session: Session) => {
    setError(null);
    await openSession(session);
  };

  const handleDeleteSession = async (session: Session) => {
    if (deletingSessionId) return;

    const confirmed = await confirm({
      title: "Delete session?",
      description: `This will permanently delete "${session.name}" and its saved session data.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;

    setDeletingSessionId(session.id);
    setError(null);
    try {
      await deleteSession(session);
    } catch (e) {
      setError(`Could not delete session: ${e}`);
    } finally {
      setDeletingSessionId(null);
    }
  };

  return (
    <div className="flex h-full min-w-0 bg-black text-zinc-100">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-6 py-6 sm:px-8 lg:px-10">
        <div className="flex min-h-0 flex-1 flex-col gap-6">
          <header className="flex flex-col gap-4 border-b border-zinc-900 pb-5 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-300">
                  <TerminalSquare className="h-4 w-4" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold text-zinc-50">AT-Terminal</h1>
                  <p className="mt-1 text-sm text-zinc-500">
                    {sessions.length > 0
                      ? `${sessions.length} saved ${sessions.length === 1 ? "session" : "sessions"}`
                      : "Create a session or open a folder to begin"}
                  </p>
                </div>
              </div>
            </div>

            {latestSession ? (
              <button
                type="button"
                onClick={() => void handleOpenSession(latestSession)}
                className="group flex h-12 min-w-0 items-center justify-between gap-4 rounded-md border border-zinc-700 bg-zinc-100 px-4 text-left text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 md:w-80"
              >
                <span className="min-w-0">
                  <span className="block text-xs font-medium uppercase text-zinc-500">
                    Resume latest
                  </span>
                  <span className="block truncate">{latestSession.name}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </button>
            ) : null}
          </header>

          <main className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            <section className="flex min-h-0 flex-col gap-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <LauncherAction
                  active={activeMode === "create"}
                  icon={Plus}
                  title="New Session"
                  detail="Start with an empty workspace"
                  onClick={() => {
                    setNavState("SESSION_SELECTION");
                    setError(null);
                    setFolderDraft(null);
                    setSessionName("");
                    setMode("create");
                  }}
                />
                <LauncherAction
                  active={activeMode === "folder"}
                  icon={FolderOpen}
                  title="Open Folder"
                  detail="Name it, then create a rooted tab"
                  disabled={folderPicking}
                  onClick={() => void handlePickFolder()}
                />
              </div>

              <InlinePanel
                mode={activeMode}
                sessionName={sessionName}
                folderDraft={folderDraft}
                creating={creating}
                onSessionNameChange={setSessionName}
                onFolderNameChange={(name) =>
                  setFolderDraft((draft) => (draft ? { ...draft, name } : draft))
                }
                onCreateSession={() => void handleCreateSession()}
                onCreateFolderSession={() => void handleCreateFolderSession()}
                onCancel={resetInlineForm}
              />

              {error ? (
                <div className="rounded-md border border-red-900/70 bg-red-950/30 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              ) : null}
            </section>

            <section className="flex min-h-0 flex-col rounded-md border border-zinc-900 bg-zinc-950/60">
              <div className="flex flex-col gap-3 border-b border-zinc-900 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-medium text-zinc-200">Available Sessions</h2>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {query.trim()
                      ? `${filteredSessions.length} matching ${filteredSessions.length === 1 ? "session" : "sessions"}`
                      : "Sorted by last opened"}
                  </p>
                </div>
                <label className="relative min-w-0 sm:w-72">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search sessions or folders"
                    className="h-9 w-full rounded-md border border-zinc-800 bg-black pl-9 pr-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600"
                  />
                </label>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {sortedSessions.length === 0 ? (
                  <EmptySessions
                    onCreate={() => {
                      setNavState("SESSION_SELECTION");
                      setMode("create");
                    }}
                    onOpenFolder={handlePickFolder}
                  />
                ) : filteredSessions.length === 0 ? (
                  <div className="flex h-full min-h-48 items-center justify-center text-sm text-zinc-500">
                    No sessions match the current search.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {filteredSessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        latest={session.id === latestSession?.id}
                        deleting={deletingSessionId === session.id}
                        onOpen={() => void handleOpenSession(session)}
                        onDelete={() => void handleDeleteSession(session)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  );
};

interface LauncherActionProps {
  active: boolean;
  disabled?: boolean;
  icon: ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  onClick: () => void;
}

function LauncherAction({
  active,
  disabled,
  icon: Icon,
  title,
  detail,
  onClick,
}: LauncherActionProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-20 items-center gap-3 rounded-md border px-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "border-zinc-600 bg-zinc-900 text-zinc-50"
          : "border-zinc-900 bg-zinc-950/70 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900/80",
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-black text-zinc-300">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-500">{detail}</span>
      </span>
    </button>
  );
}

interface InlinePanelProps {
  mode: LauncherMode;
  sessionName: string;
  folderDraft: FolderDraft | null;
  creating: boolean;
  onSessionNameChange: (name: string) => void;
  onFolderNameChange: (name: string) => void;
  onCreateSession: () => void;
  onCreateFolderSession: () => void;
  onCancel: () => void;
}

function InlinePanel({
  mode,
  sessionName,
  folderDraft,
  creating,
  onSessionNameChange,
  onFolderNameChange,
  onCreateSession,
  onCreateFolderSession,
  onCancel,
}: InlinePanelProps) {
  if (!mode) return null;

  const isFolderMode = mode === "folder";
  const value = isFolderMode ? (folderDraft?.name ?? "") : sessionName;
  const canSubmit = value.trim().length > 0 && (!isFolderMode || Boolean(folderDraft?.path));

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">
            {isFolderMode ? "Name Folder Session" : "Create Session"}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            {isFolderMode
              ? "The selected folder becomes the first tab."
              : "Create an empty session."}
          </p>
        </div>
      </div>

      {isFolderMode && folderDraft ? (
        <div className="mb-3 truncate rounded border border-zinc-900 bg-black px-3 py-2 font-mono text-xs text-zinc-500">
          {folderDraft.path}
        </div>
      ) : null}

      <input
        value={value}
        onChange={(event) =>
          isFolderMode
            ? onFolderNameChange(event.target.value)
            : onSessionNameChange(event.target.value)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && canSubmit && !creating) {
            if (isFolderMode) {
              onCreateFolderSession();
            } else {
              onCreateSession();
            }
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        placeholder="Session name"
        className="h-9 w-full rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-zinc-600"
        autoFocus
      />

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit || creating}
          onClick={isFolderMode ? onCreateFolderSession : onCreateSession}
          className="h-8 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating..." : isFolderMode ? "Open Folder" : "Create"}
        </button>
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: Session;
  latest: boolean;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function SessionRow({ session, latest, deleting, onOpen, onDelete }: SessionRowProps) {
  const roots = getSessionRoots(session);
  const primaryRoot = roots[0] ?? null;

  return (
    <div className="group flex min-h-16 items-center gap-2 rounded-md border border-zinc-900 bg-black p-2 transition-colors hover:border-zinc-700 hover:bg-zinc-900/70">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-zinc-400">
          <Clock3 className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">{session.name}</span>
            {latest ? (
              <span className="shrink-0 rounded-sm border border-emerald-900/70 bg-emerald-950/30 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-300">
                Latest
              </span>
            ) : null}
          </span>
          <span className="mt-1 block truncate text-xs text-zinc-500">
            {getSessionSummary(session)}
            {primaryRoot ? ` · ${primaryRoot}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-xs text-zinc-500">
          {formatRelativeTime(session.last_accessed)}
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-zinc-500 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        disabled={deleting}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-zinc-500 transition-colors hover:border-red-900/70 hover:bg-red-950/30 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
        title={`Delete ${session.name}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface EmptySessionsProps {
  onCreate: () => void;
  onOpenFolder: () => void;
}

function EmptySessions({ onCreate, onOpenFolder }: EmptySessionsProps) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-md border border-zinc-800 bg-black text-zinc-400">
        <TerminalSquare className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-sm font-medium text-zinc-200">No sessions yet</h2>
        <p className="mt-1 max-w-sm text-sm text-zinc-500">
          Create an empty session or open a folder to start with a project root.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="h-8 rounded-md bg-zinc-100 px-3 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-200"
        >
          New Session
        </button>
        <button
          type="button"
          onClick={onOpenFolder}
          className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
        >
          Open Folder
        </button>
      </div>
    </div>
  );
}
