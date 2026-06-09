import { useCallback, useMemo } from "react";
import { Copy, FilePenLine, FolderInput, Pencil, Trash2, FilePlus, FolderPlus } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { useFileExplorerStore } from "@/store/useFileExplorerStore";
import { useConfirmationStore } from "@/store/useConfirmationStore";
import { revealInExplorer } from "@/lib/filesystem";
import type { DirEntry } from "@/types/filesystem";

interface FileExplorerContextMenuProps {
  entry: DirEntry;
  rootDirectory: string;
  children: React.ReactNode;
  selectedPaths: Set<string>;
  selectedDirectoryPaths: Set<string>;
  onOpenFile?: (path: string) => void;
  onBulkDelete: (paths: string[], dirs: Set<string>) => Promise<void>;
  onBulkCopyPaths: (paths: string[]) => Promise<void>;
}

function getRelativePath(rootDirectory: string, absolutePath: string): string {
  const normalizedRoot = rootDirectory.replace(/\\/g, "/");
  const normalizedPath = absolutePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith(normalizedRoot)) {
    const relative = normalizedPath.slice(normalizedRoot.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return normalizedPath;
}

export function FileExplorerContextMenu({
  entry,
  rootDirectory,
  children,
  selectedPaths,
  selectedDirectoryPaths,
  onOpenFile,
  onBulkDelete,
  onBulkCopyPaths,
}: FileExplorerContextMenuProps) {
  const { startRename, startCreating } = useFileExplorerStore();
  const confirm = useConfirmationStore((s) => s.confirm);

  const effectiveSelection = useMemo(() => {
    if (selectedPaths.has(entry.path)) {
      return selectedPaths;
    }
    return new Set([entry.path]);
  }, [entry.path, selectedPaths]);

  const isBulkSelection = effectiveSelection.size > 1;

  const handleOpen = useCallback(() => {
    onOpenFile?.(entry.path);
  }, [entry.path, onOpenFile]);

  const handleRevealInExplorer = useCallback(async () => {
    try {
      await revealInExplorer(entry.path);
    } catch (err) {
      console.error("Failed to reveal in system explorer:", err);
    }
  }, [entry.path]);

  const handleCopyPath = useCallback(async () => {
    await onBulkCopyPaths(Array.from(effectiveSelection));
  }, [effectiveSelection, onBulkCopyPaths]);

  const handleCopyRelativePath = useCallback(async () => {
    const relativePaths = Array.from(effectiveSelection).map((path) =>
      getRelativePath(rootDirectory, path),
    );
    await onBulkCopyPaths(relativePaths);
  }, [effectiveSelection, onBulkCopyPaths, rootDirectory]);

  const handleRename = useCallback(() => {
    startRename(entry.path);
  }, [entry.path, startRename]);

  const handleDelete = useCallback(async () => {
    const paths = Array.from(effectiveSelection);
    const selectedDirSet = new Set(paths.filter((path) => selectedDirectoryPaths.has(path)));
    if (entry.is_directory && paths.includes(entry.path)) {
      selectedDirSet.add(entry.path);
    }

    const confirmed = await confirm({
      title:
        paths.length > 1
          ? `Delete ${paths.length} Items?`
          : entry.is_directory
            ? "Delete Folder?"
            : "Delete File?",
      description:
        paths.length > 1
          ? "Are you sure you want to delete the selected items? This cannot be undone."
          : entry.is_directory
            ? `Are you sure you want to delete "${entry.name}" and all its contents? This cannot be undone.`
            : `Are you sure you want to delete "${entry.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;

    await onBulkDelete(paths, selectedDirSet);
  }, [
    confirm,
    effectiveSelection,
    entry.is_directory,
    entry.name,
    entry.path,
    onBulkDelete,
    selectedDirectoryPaths,
  ]);

  const handleNewFile = useCallback(() => {
    const parentPath = entry.is_directory ? entry.path : rootDirectory;
    startCreating(parentPath, "file");
  }, [entry.is_directory, entry.path, rootDirectory, startCreating]);

  const handleNewFolder = useCallback(() => {
    const parentPath = entry.is_directory ? entry.path : rootDirectory;
    startCreating(parentPath, "directory");
  }, [entry.is_directory, entry.path, rootDirectory, startCreating]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        {!entry.is_directory && onOpenFile && !isBulkSelection && (
          <ContextMenuItem onSelect={handleOpen}>
            <FilePenLine className="mr-2 h-3.5 w-3.5" />
            Open
          </ContextMenuItem>
        )}

        <ContextMenuItem onSelect={handleRevealInExplorer}>
          <FolderInput className="mr-2 h-3.5 w-3.5" />
          {entry.is_directory ? "Open in System Explorer" : "Reveal in System Explorer"}
        </ContextMenuItem>

        <div className="my-1 h-px bg-zinc-700" />

        <ContextMenuItem onSelect={handleNewFile}>
          <FilePlus className="mr-2 h-3.5 w-3.5" />
          New File
        </ContextMenuItem>
        <ContextMenuItem onSelect={handleNewFolder}>
          <FolderPlus className="mr-2 h-3.5 w-3.5" />
          New Folder
        </ContextMenuItem>

        <div className="my-1 h-px bg-zinc-700" />

        <ContextMenuItem onSelect={() => void handleCopyPath()}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {isBulkSelection ? `Copy Paths (${effectiveSelection.size})` : "Copy Path"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void handleCopyRelativePath()}>
          <Copy className="mr-2 h-3.5 w-3.5" />
          {isBulkSelection
            ? `Copy Relative Paths (${effectiveSelection.size})`
            : "Copy Relative Path"}
        </ContextMenuItem>

        <div className="my-1 h-px bg-zinc-700" />

        {!isBulkSelection && (
          <ContextMenuItem onSelect={handleRename}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            Rename
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() => void handleDelete()}
          className="text-red-400 focus:text-red-300"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {isBulkSelection ? `Delete (${effectiveSelection.size} items)` : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
