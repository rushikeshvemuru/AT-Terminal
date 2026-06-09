import { useSessionStore } from "../store/useSessionStore";

export function useSessionList() {
  const { availableSessions, refreshSessions } = useSessionStore();

  return {
    sessions: availableSessions,
    refreshSessions,
  };
}
