import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { AlertCircle, CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import {
  getGhInstallHelp,
  getGitAuthStatus,
  launchGhAuthLogin,
  runGhAuthSetupGit,
} from "@/lib/git";
import { useGitAuthStore } from "@/store/useGitAuthStore";
import type { GhInstallHelp, GitAuthStatus } from "@/types/git";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GH_INSTALL_DOCS_URL = "https://github.com/cli/cli#installation";

type Phase = "idle" | "working" | "error";

export function GitAuthDialog() {
  const request = useGitAuthStore((state) => state.request);
  const resolve = useGitAuthStore((state) => state.resolve);

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && resolve(false)}>
      {request ? (
        <GitAuthDialogContent
          key={`${request.rootDirectory}:${request.actionLabel}:${request.status.nextAction}`}
          resolve={resolve}
        />
      ) : null}
    </Dialog>
  );
}

function GitAuthDialogContent({ resolve }: { resolve: (ready: boolean) => void }) {
  const request = useGitAuthStore((state) => state.request);
  const [status, setStatus] = useState<GitAuthStatus | null>(request?.status ?? null);
  const [installHelp, setInstallHelp] = useState<GhInstallHelp | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadInstallHelp = async () => {
      try {
        const help = await getGhInstallHelp();
        if (!cancelled) {
          setInstallHelp(help);
        }
      } catch {
        if (!cancelled) {
          setInstallHelp(null);
        }
      }
    };

    void loadInstallHelp();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (status?.nextAction !== "ready") return;
    const timer = window.setTimeout(() => resolve(true), 250);
    return () => window.clearTimeout(timer);
  }, [resolve, status?.nextAction]);

  const title = useMemo(() => {
    switch (status?.nextAction) {
      case "install-gh":
        return "Install GitHub CLI";
      case "login-gh":
        return "Sign In With GitHub CLI";
      case "setup-git":
        return "Finish Git Setup";
      case "ready":
        return "GitHub CLI Ready";
      default:
        return "GitHub Setup";
    }
  }, [status?.nextAction]);

  const description = useMemo(() => {
    switch (status?.nextAction) {
      case "install-gh":
        return "Install GitHub CLI once, then come back here and we’ll keep moving.";
      case "login-gh":
        return "AT-Terminal will start GitHub CLI sign-in. Complete the browser flow, then check again.";
      case "setup-git":
        return "GitHub CLI is signed in. One more setup step lets Git use that session for push and pull.";
      case "ready":
        return `${request?.actionLabel ?? "GitHub"} is ready to continue.`;
      default:
        return status?.message ?? "GitHub CLI setup is required for this repo.";
    }
  }, [request?.actionLabel, status?.message, status?.nextAction]);

  const primaryCommand =
    status?.nextAction === "login-gh"
      ? "gh auth login --web --hostname github.com --git-protocol https"
      : status?.nextAction === "setup-git"
        ? "gh auth setup-git --hostname github.com"
        : null;

  const currentPlatform = useMemo(() => detectPlatform(), []);
  const preferredPlatforms = useMemo(() => {
    if (!installHelp) return [];
    const preferred = installHelp.platforms.filter((platform) => platform.os === currentPlatform);
    const others = installHelp.platforms.filter((platform) => platform.os !== currentPlatform);
    return [...preferred, ...others];
  }, [currentPlatform, installHelp]);

  const refreshStatus = async () => {
    if (!request) return false;

    setPhase("working");
    setError(null);
    try {
      const nextStatus = await getGitAuthStatus(request.rootDirectory);
      setStatus(nextStatus);
      setNote(nextStatus.message);
      setPhase("idle");
      return nextStatus.nextAction === "ready";
    } catch (err) {
      setPhase("error");
      setError(formatError(err));
      return false;
    }
  };

  const handlePrimary = async () => {
    if (!request || !status) return;

    setError(null);
    setNote(null);

    if (status.nextAction === "install-gh") {
      await open(installHelp?.docsUrl ?? GH_INSTALL_DOCS_URL);
      return;
    }

    if (status.nextAction === "login-gh") {
      setPhase("working");
      try {
        const result = await launchGhAuthLogin(request.rootDirectory);
        if (result.started) {
          setNote(result.message);
        } else {
          request.onOpenTerminal(result.command);
          await copyText(result.command);
          setNote(
            result.fallbackReason ? `${result.message} ${result.fallbackReason}` : result.message,
          );
        }
        setPhase("idle");
      } catch (err) {
        setPhase("error");
        setError(formatError(err));
      }
      return;
    }

    if (status.nextAction === "setup-git") {
      setPhase("working");
      try {
        const result = await runGhAuthSetupGit(request.rootDirectory);
        setNote(result.message);
        await refreshStatus();
      } catch (err) {
        setPhase("error");
        setError(formatError(err));
      }
    }
  };

  const primaryLabel = (() => {
    switch (status?.nextAction) {
      case "install-gh":
        return "Open Install Docs";
      case "login-gh":
        return "Start Sign In";
      case "setup-git":
        return "Finish Git Setup";
      case "ready":
        return "Ready";
      default:
        return "Continue";
    }
  })();

  const primaryDisabled = phase === "working" || status?.nextAction === "ready";

  return (
    <DialogContent className="max-w-lg border-zinc-800 bg-zinc-950 text-zinc-100">
      <DialogHeader>
        <DialogTitle className="text-base">{title}</DialogTitle>
        <DialogDescription className="text-sm text-zinc-400">{description}</DialogDescription>
      </DialogHeader>

      {status?.message && status.nextAction !== "ready" && (
        <div className="rounded border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-300">
          {status.message}
        </div>
      )}

      {(status?.ghPath || status?.ghError) && status.nextAction !== "ready" && (
        <div className="rounded border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-500">
          {status.ghPath ? (
            <div className="break-words">
              GitHub CLI: {status.ghPath}
              {status.ghPathSource ? ` (${status.ghPathSource})` : null}
            </div>
          ) : null}
          {status.ghError ? <div className="mt-1 break-words">{status.ghError}</div> : null}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-950/70 bg-red-950/30 p-2 text-sm text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 break-words">{error}</div>
        </div>
      )}

      {note && !error && (
        <div className="flex items-start gap-2 rounded border border-emerald-950/70 bg-emerald-950/20 p-2 text-sm text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 break-words">{note}</div>
        </div>
      )}

      {status?.nextAction === "install-gh" && preferredPlatforms.length > 0 && (
        <div className="space-y-2">
          {preferredPlatforms.map((platform) => (
            <div
              key={platform.os}
              className="rounded border border-zinc-800 bg-zinc-900/80 p-3 text-sm text-zinc-300"
            >
              <div className="font-medium text-zinc-100">{platform.title}</div>
              {platform.recommendedCommand ? (
                <div className="mt-2 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-2">
                  <code className="min-w-0 flex-1 truncate text-xs text-zinc-200">
                    {platform.recommendedCommand}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyText(platform.recommendedCommand ?? "")}
                    className="inline-flex h-7 items-center justify-center gap-1 rounded border border-zinc-700 px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
              ) : null}
              {platform.notes ? (
                <div className="mt-2 text-xs text-zinc-500">{platform.notes}</div>
              ) : null}
              {platform.docsUrl ? (
                <button
                  type="button"
                  onClick={() => void open(platform.docsUrl ?? GH_INSTALL_DOCS_URL)}
                  className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open {platform.title} docs
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {primaryCommand && status?.nextAction !== "install-gh" && (
        <div className="rounded border border-zinc-800 bg-zinc-900/80 p-3 text-sm text-zinc-300">
          <div className="font-medium text-zinc-100">
            {status?.nextAction === "login-gh" ? "Sign-in command" : "Setup command"}
          </div>
          <div className="mt-2 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-2">
            <code className="min-w-0 flex-1 truncate text-xs text-zinc-200">{primaryCommand}</code>
            <button
              type="button"
              onClick={() => void copyText(primaryCommand)}
              className="inline-flex h-7 items-center justify-center gap-1 rounded border border-zinc-700 px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </button>
          </div>
        </div>
      )}

      <DialogFooter className="gap-2">
        <button
          type="button"
          onClick={() => resolve(false)}
          disabled={phase === "working"}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={phase === "working"}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Check Again
        </button>
        <button
          type="button"
          onClick={() => void handlePrimary()}
          disabled={primaryDisabled}
          className="inline-flex items-center gap-1.5 rounded bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {phase === "working" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-4 w-4" />
          )}
          {primaryLabel}
        </button>
      </DialogFooter>
    </DialogContent>
  );
}

function detectPlatform(): string {
  const platform = navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  return "linux";
}

async function copyText(value: string): Promise<void> {
  if (!value) return;
  await navigator.clipboard.writeText(value);
}

function formatError(err: unknown): string {
  return typeof err === "string" ? err : String(err);
}
