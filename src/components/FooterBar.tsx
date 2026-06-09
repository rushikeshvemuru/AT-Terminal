import { useEffect, useMemo, useState } from "react";
import { PowerOff } from "lucide-react";
import { TerminalBlocksBar } from "@/components/TerminalBlocksBar";
import { useActiveTabSummary } from "@/hooks/useActiveSessionTabState";
import { useSessionStore } from "@/store/useSessionStore";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { getAppDiagnostics, type AppDiagnostics } from "@/lib/diagnostics";

const MODULE_HEALTH_STARTUP_POLL_MS = 1_000;
const MODULE_HEALTH_STEADY_POLL_MS = 10_000;

export const FooterBar = () => {
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [returningToMenu, setReturningToMenu] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const activeSession = useSessionStore((s) => s.activeSession);
  const returnToMainMenu = useSessionStore((s) => s.returnToMainMenu);
  const terminateActiveSession = useSessionStore((s) => s.terminateActiveSession);
  const confirm = useConfirmationStore((s) => s.confirm);
  const { tabCount, activeTabName } = useActiveTabSummary();
  const moduleHealth = useMemo(() => {
    const modules = diagnostics?.modules ?? [];
    if (modules.length === 0) return null;
    const healthy = modules.filter((module) => module.healthy).length;
    return { healthy, total: modules.length };
  }, [diagnostics?.modules]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const modulesAreHealthy = (nextDiagnostics: AppDiagnostics | null) => {
      const modules = nextDiagnostics?.modules ?? [];
      return modules.length > 0 && modules.every((module) => module.healthy);
    };

    const refresh = async () => {
      let nextDiagnostics: AppDiagnostics | null;
      try {
        nextDiagnostics = await getAppDiagnostics();
      } catch {
        nextDiagnostics = null;
      }

      if (cancelled) return;

      setDiagnostics(nextDiagnostics);
      timeoutId = window.setTimeout(
        () => void refresh(),
        modulesAreHealthy(nextDiagnostics)
          ? MODULE_HEALTH_STEADY_POLL_MS
          : MODULE_HEALTH_STARTUP_POLL_MS,
      );
    };

    const handleFocus = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      void refresh();
    };

    void refresh();
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const handleReturnToMainMenu = async () => {
    if (!activeSession || returningToMenu) return;

    const confirmed = await confirm({
      title: "Return to main menu?",
      description: `This will save "${activeSession.name}" and return to the startup launcher. The session will remain available.`,
      confirmLabel: "Return",
      cancelLabel: "Stay",
      variant: "warning",
    });
    if (!confirmed) return;

    setReturningToMenu(true);
    try {
      await returnToMainMenu();
    } catch (error) {
      console.error("Failed to return to main menu:", error);
    } finally {
      setReturningToMenu(false);
    }
  };

  const handleTerminateSession = async () => {
    if (!activeSession || terminating) return;

    const confirmed = await confirm({
      title: "Terminate session?",
      description: `This will terminate "${activeSession.name}" and permanently delete its saved session data.`,
      confirmLabel: "Terminate",
      destructive: true,
    });
    if (!confirmed) return;

    setTerminating(true);
    try {
      await terminateActiveSession();
    } catch (error) {
      console.error("Failed to terminate session:", error);
    } finally {
      setTerminating(false);
    }
  };

  return (
    <div className="relative flex h-6 select-none items-center border-t border-zinc-800 bg-zinc-950 px-3">
      <div className="flex min-w-0 items-center">
        {activeSession ? (
          <button
            type="button"
            onClick={() => void handleReturnToMainMenu()}
            disabled={returningToMenu}
            className="shrink-0 text-[11px] text-zinc-500 transition-colors hover:text-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
            title="Return to main menu"
          >
            AT-Terminal
          </button>
        ) : (
          <span className="shrink-0 text-[11px] text-zinc-500">AT-Terminal</span>
        )}
        {activeSession && (
          <>
            <span className="mx-2 shrink-0 text-[11px] text-zinc-600">|</span>
            <span className="truncate text-[11px] text-zinc-400">{activeSession.name}</span>
            {tabCount > 0 && (
              <>
                <span className="mx-1 shrink-0 text-[11px] text-zinc-600">-</span>
                <span className="truncate text-[11px] text-zinc-500">
                  {activeTabName ?? "No active tab"} ({tabCount} {tabCount === 1 ? "tab" : "tabs"})
                </span>
              </>
            )}
          </>
        )}
        {moduleHealth && (
          <>
            <span className="mx-2 shrink-0 text-[11px] text-zinc-600">|</span>
            <span
              className={
                moduleHealth.healthy === moduleHealth.total
                  ? "shrink-0 text-[11px] text-emerald-500"
                  : "shrink-0 text-[11px] text-amber-400"
              }
              title="Module health"
            >
              Modules {moduleHealth.healthy}/{moduleHealth.total}
            </span>
          </>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
        <div className="pointer-events-auto">
          <TerminalBlocksBar />
        </div>
      </div>

      {activeSession && (
        <button
          type="button"
          onClick={() => void handleTerminateSession()}
          disabled={terminating}
          className="ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded border border-red-900/60 px-1.5 text-[11px] text-red-300 transition-colors hover:border-red-700 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
          title="Terminate and delete session"
        >
          <PowerOff className="h-3 w-3" />
          <span>{terminating ? "Terminating" : "Terminate"}</span>
        </button>
      )}
    </div>
  );
};
