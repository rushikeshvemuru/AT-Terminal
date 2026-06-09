import { useEffect, useRef } from "react";
import { Eye, EyeOff, FilePlus, FolderPlus, RefreshCw, Search, X } from "lucide-react";
import { useFileExplorerStore } from "@/store/useFileExplorerStore";

interface FileExplorerHeaderProps {
  rootDirectory: string | null;
  onRefresh?: () => void;
  resultCount?: { shown: number; total: number };
}

export function FileExplorerHeader({
  rootDirectory,
  onRefresh,
  resultCount,
}: FileExplorerHeaderProps) {
  const showHidden = useFileExplorerStore((s) => s.showHidden);
  const searchFilter = useFileExplorerStore((s) => s.searchFilter);
  const { toggleShowHidden, setSearchFilter, startCreating, clearFilter } = useFileExplorerStore();
  const inputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: Ctrl/Cmd+F to focus filter
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
      if (e.key === "Escape" && searchFilter) {
        clearFilter();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchFilter, clearFilter]);

  const handleNewFile = () => {
    if (!rootDirectory) return;
    startCreating(rootDirectory, "file");
  };

  const handleNewFolder = () => {
    if (!rootDirectory) return;
    startCreating(rootDirectory, "directory");
  };

  const handleClearSearch = () => {
    setSearchFilter("");
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-1 border-b border-zinc-800 px-2 py-1.5">
      {/* Search row */}
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
          <input
            ref={inputRef}
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filter files..."
            className="h-6 w-full rounded border border-zinc-800 bg-zinc-900 py-0 pl-6 pr-5 text-xs text-zinc-300 placeholder-zinc-600 outline-none focus:border-zinc-600"
          />
          {searchFilter && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {resultCount && searchFilter && (
          <span className="text-xs text-zinc-500">
            {resultCount.shown}/{resultCount.total}
          </span>
        )}
      </div>
      {/* Action row */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          title="New File"
          onClick={handleNewFile}
          disabled={!rootDirectory}
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="New Folder"
          onClick={handleNewFolder}
          disabled={!rootDirectory}
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Refresh"
          onClick={onRefresh}
          disabled={!rootDirectory}
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
          onClick={toggleShowHidden}
          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
        >
          {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
