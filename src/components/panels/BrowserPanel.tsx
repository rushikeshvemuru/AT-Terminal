import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  LoaderCircle,
  RotateCw,
  Square,
} from "lucide-react";
import type { PanelProps } from "@/lib/panelRegistry";
import { cn } from "@/lib/utils";

interface BrowserStateSnapshot {
  url: string;
  history: string[];
}

interface PersistedBrowserPanelState {
  browserState?: BrowserStateSnapshot;
  url?: string;
}

export const BrowserPanel = ({ panel, onPanelStateChange }: PanelProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const persistedState = panel.state as PersistedBrowserPanelState | undefined;
  const persistedBrowserState =
    persistedState?.browserState &&
    typeof persistedState.browserState.url === "string" &&
    Array.isArray(persistedState.browserState.history)
      ? persistedState.browserState
      : undefined;
  const persistedUrl =
    persistedBrowserState?.url ??
    (typeof persistedState?.url === "string" ? persistedState.url : undefined);
  const persistedHistory =
    persistedBrowserState?.history.filter((entry): entry is string => typeof entry === "string") ??
    (persistedUrl ? [persistedUrl] : []);
  const [initialUrl] = useState(persistedUrl ?? "https://example.com");
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [addressValue, setAddressValue] = useState(initialUrl);
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<string[]>(
    persistedHistory.length > 0 ? persistedHistory : [initialUrl],
  );
  const [historyIndex, setHistoryIndex] = useState(
    Math.max(0, persistedHistory.length > 0 ? persistedHistory.lastIndexOf(initialUrl) : 0),
  );
  const lastPersistedStateRef = useRef<string>("");
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyEntries.length - 1;

  useEffect(() => {
    const nextUrl = currentUrl.trim();
    if (!nextUrl) {
      return;
    }

    const nextHistory = historyEntries.filter((entry) => entry.trim().length > 0);
    const nextSnapshot = JSON.stringify({
      url: nextUrl,
      history: nextHistory,
    });
    if (nextSnapshot === lastPersistedStateRef.current) {
      return;
    }

    lastPersistedStateRef.current = nextSnapshot;
    onPanelStateChange?.({
      ...(panel.state ?? {}),
      browserState: {
        url: nextUrl,
        history: nextHistory,
      },
      url: nextUrl,
    });
  }, [currentUrl, historyEntries, onPanelStateChange, panel.state]);

  const normalizeUrl = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) return "";

    try {
      // Try parsing as-is first
      new URL(trimmed);
      return trimmed;
    } catch {
      // If it fails, try adding https://
      try {
        new URL(`https://${trimmed}`);
        return `https://${trimmed}`;
      } catch {
        return "";
      }
    }
  };

  const handleNavigate = useCallback(() => {
    const target = addressValue.trim();
    if (!target) return;

    const normalized = normalizeUrl(target);
    if (!normalized) {
      setError("Invalid URL");
      return;
    }

    setError(null);
    setIsLoading(true);
    setCurrentUrl(normalized);
    setHistoryEntries((previous) => {
      const baseHistory = previous.slice(0, historyIndex + 1);
      if (baseHistory[baseHistory.length - 1] === normalized) {
        setHistoryIndex(baseHistory.length - 1);
        return baseHistory;
      }
      const nextHistory = [...baseHistory, normalized];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });

    if (iframeRef.current) {
      iframeRef.current.src = normalized;
    }
  }, [addressValue, historyIndex]);

  const handleIframeLoad = () => {
    setIsLoading(false);
    try {
      const iframeDoc =
        iframeRef.current?.contentDocument || iframeRef.current?.contentWindow?.document;
      if (iframeDoc) {
        setTitle(iframeDoc.title || "");
      }
    } catch {
      setTitle("");
    }
  };

  const handleIframeError = () => {
    setIsLoading(false);
    setError("Failed to load page");
  };

  const statusText = error || title || currentUrl || "Browser Preview";
  const displayedAddress = isEditingAddress ? addressValue : currentUrl;

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-800 px-2">
        <IconButton
          title="Back"
          onClick={() => {
            if (!canGoBack || !iframeRef.current) return;
            const nextIndex = historyIndex - 1;
            const target = historyEntries[nextIndex];
            if (!target) return;
            setHistoryIndex(nextIndex);
            setCurrentUrl(target);
            setAddressValue(target);
            setIsLoading(true);
            setError(null);
            iframeRef.current.src = target;
          }}
          disabled={!canGoBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <IconButton
          title="Forward"
          onClick={() => {
            if (!canGoForward || !iframeRef.current) return;
            const nextIndex = historyIndex + 1;
            const target = historyEntries[nextIndex];
            if (!target) return;
            setHistoryIndex(nextIndex);
            setCurrentUrl(target);
            setAddressValue(target);
            setIsLoading(true);
            setError(null);
            iframeRef.current.src = target;
          }}
          disabled={!canGoForward}
        >
          <ArrowRight className="h-4 w-4" />
        </IconButton>
        <IconButton
          title={isLoading ? "Stop" : "Reload"}
          onClick={() => {
            if (!iframeRef.current) return;

            if (isLoading) {
              iframeRef.current.contentWindow?.stop();
              setIsLoading(false);
              return;
            }

            iframeRef.current.src = currentUrl;
            setIsLoading(true);
            setError(null);
          }}
          disabled={!currentUrl}
        >
          {isLoading ? <Square className="h-3.5 w-3.5" /> : <RotateCw className="h-4 w-4" />}
        </IconButton>

        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            handleNavigate();
          }}
        >
          <div className="flex h-8 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <input
              value={displayedAddress}
              onChange={(event) => setAddressValue(event.target.value)}
              onFocus={() => {
                setAddressValue(currentUrl);
                setIsEditingAddress(true);
              }}
              onBlur={() => setIsEditingAddress(false)}
              placeholder="Enter a URL"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>
        </form>

        <IconButton
          title="Open externally"
          onClick={() => {
            if (!currentUrl.trim()) return;
            void open(currentUrl.trim()).catch(console.error);
          }}
          disabled={!currentUrl.trim()}
        >
          <ExternalLink className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-900 bg-zinc-950/90 px-3 text-xs text-zinc-400">
        {isLoading ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <span className="h-3.5 w-3.5 rounded-full bg-zinc-700" />
        )}
        <span className={cn("truncate", error ? "text-rose-400" : "text-zinc-400")}>
          {statusText}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 bg-zinc-950">
        <iframe
          ref={iframeRef}
          src={initialUrl}
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          className="absolute inset-0 h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          title="Browser preview panel"
        />
        {error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-rose-400">
            {error}
          </div>
        )}
      </div>
    </div>
  );
};

interface IconButtonProps {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}

function IconButton({ children, disabled, onClick, title }: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 transition-colors",
        disabled ? "cursor-not-allowed opacity-40" : "hover:bg-zinc-800 hover:text-zinc-100",
      )}
    >
      {children}
    </button>
  );
}
