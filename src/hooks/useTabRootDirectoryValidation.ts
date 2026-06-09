import { useEffect } from "react";
import { useActiveSessionId } from "@/hooks/useActiveSessionTabState";
import { directoryExists } from "@/lib/filesystem";
import { useTabStore } from "@/store/useTabStore";

export function useTabRootDirectoryValidation(enabled = true) {
  const sessionId = useActiveSessionId();
  const sessionState = useTabStore((state) =>
    sessionId ? (state.sessionStates[sessionId] ?? null) : null,
  );
  const setTabRootDirectoryMissing = useTabStore((state) => state.setTabRootDirectoryMissing);
  const tabs = sessionState?.tabs;
  const activeTabId = sessionState?.activeTabId ?? null;
  const tabRootsSignature = tabs?.map((tab) => `${tab.id}:${tab.rootDirectory}`).join("|") ?? "";
  const activeTabRootDirectory = tabs?.find((tab) => tab.id === activeTabId)?.rootDirectory ?? null;

  useEffect(() => {
    if (!enabled || !sessionId || !tabs?.length) return;

    let cancelled = false;

    const validateAllTabs = async () => {
      await Promise.all(
        tabs.map(async (tab) => {
          const missing = !(await directoryExists(tab.rootDirectory));
          if (cancelled) return;
          setTabRootDirectoryMissing(sessionId, tab.id, missing);
        }),
      );
    };

    void validateAllTabs();

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId, setTabRootDirectoryMissing, tabRootsSignature, tabs]);

  useEffect(() => {
    if (!enabled || !sessionId || !activeTabId || !activeTabRootDirectory) return;

    let cancelled = false;

    const validateActiveTab = async () => {
      const missing = !(await directoryExists(activeTabRootDirectory));
      if (cancelled) return;
      setTabRootDirectoryMissing(sessionId, activeTabId, missing);
    };

    const handleWindowFocus = () => {
      void validateActiveTab();
    };

    void validateActiveTab();
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [enabled, sessionId, activeTabId, activeTabRootDirectory, setTabRootDirectoryMissing]);
}
