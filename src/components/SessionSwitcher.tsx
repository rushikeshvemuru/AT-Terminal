import { useState } from "react";
import { Plus, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { useSessionStore } from "@/store/useSessionStore";
import type { Session } from "@/store/useSessionStore";
import { useSessionList } from "@/hooks/useSessionList";
import { cn } from "@/lib/utils";

export const SessionSwitcher = () => {
  const [open, setOpen] = useState(false);
  const { activeSession, switchToSession, setNavState } = useSessionStore();
  const { sessions, refreshSessions } = useSessionList();

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      refreshSessions();
    }
  };

  const handleCreateNew = () => {
    setNavState("NEW_SESSION_FORM");
    setOpen(false);
  };

  const handleSelectSession = (session: Session) => {
    void switchToSession(session);
    setOpen(false);
  };

  const formatRelativeTime = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return "just now";
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-2 rounded px-2 py-1 text-sm text-zinc-100 outline-none transition-colors hover:bg-zinc-800">
          <span className="font-medium">{activeSession?.name ?? "Select Session"}</span>
          <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 border-zinc-800 bg-zinc-950 p-0" align="start">
        <Command className="bg-zinc-950 text-zinc-100">
          <CommandInput
            placeholder="Search sessions..."
            className="border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500"
          />
          <CommandList>
            <CommandEmpty className="p-4 text-center text-zinc-500">
              No sessions found.
            </CommandEmpty>
            <CommandGroup>
              <CommandItem onSelect={handleCreateNew} className="cursor-pointer text-zinc-100">
                <Plus className="mr-2 h-4 w-4" />
                Create Session
              </CommandItem>
            </CommandGroup>
            <CommandSeparator className="bg-zinc-800" />
            <CommandGroup heading="Sessions">
              {sessions.map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() => handleSelectSession(session)}
                  className={cn(
                    "cursor-pointer text-zinc-100",
                    session.id === activeSession?.id && "bg-zinc-800",
                  )}
                >
                  <span>{session.name}</span>
                  <span className="ml-auto text-xs text-zinc-500">
                    {formatRelativeTime(session.last_accessed)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
