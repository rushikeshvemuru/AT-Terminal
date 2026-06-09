import { memo, useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { MaterialIcon } from "@/icons/MaterialIcon";
import { resolveFileIcon, resolveFolderIcon } from "@/icons/resolveIcon";
import { FileExplorerContextMenu } from "@/components/FileExplorerContextMenu";
import { FileExplorerInlineNameInput } from "@/components/FileExplorerInlineNameInput";
import { MatchHighlight } from "@/components/MatchHighlight";
import type { FileTreeRow as FileTreeRowModel } from "@/hooks/useFlattenedFileTree";

const INDENT_WIDTH = 12;

interface FileTreeRowProps {
  row: FileTreeRowModel;
  style: React.CSSProperties;
  rootDirectory: string;
  searchFilter: string;
  isSelected: boolean;
  isFocused: boolean;
  isDragOver: boolean;
  isRenaming: boolean;
  tabIndex: number;
  selectedPaths: Set<string>;
  directoryPaths: Set<string>;
  onSelectPath: (path: string, event: React.MouseEvent) => void;
  onContextSelectPath: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPreviewFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
  onCreateSubmit: (parentPath: string, name: string, type: "file" | "directory") => void;
  onCancelCreate: () => void;
  onRowPointerDown: (path: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onRowFocus: (path: string) => void;
  onRowKeyDown: (path: string, event: React.KeyboardEvent<HTMLDivElement>) => void;
  registerRowElement: (path: string, element: HTMLDivElement | null) => void;
  onBulkDelete: (paths: string[], dirs: Set<string>) => Promise<void>;
  onBulkCopyPaths: (paths: string[]) => Promise<void>;
}

interface FileTreeEntryContentProps {
  entryPath: string;
  entryName: string;
  isDirectory: boolean;
  isExpanded: boolean;
  depth: number;
  searchFilter: string;
  iconName: string;
  isSelected: boolean;
  isFocused: boolean;
  isDragOver: boolean;
  isRenaming: boolean;
  tabIndex: number;
  onRowPointerDown: (path: string, event: React.PointerEvent<HTMLDivElement>) => void;
  onRowFocus: (path: string) => void;
  onRowKeyDown: (path: string, event: React.KeyboardEvent<HTMLDivElement>) => void;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onCancelRename: () => void;
  registerRowElement: (path: string, element: HTMLDivElement | null) => void;
}

const FileTreeEntryContent = memo(function FileTreeEntryContent({
  entryPath,
  entryName,
  isDirectory,
  isExpanded,
  depth,
  searchFilter,
  iconName,
  isSelected,
  isFocused,
  isDragOver,
  isRenaming,
  tabIndex,
  onRowPointerDown,
  onRowFocus,
  onRowKeyDown,
  onClick,
  onContextMenu,
  onRenameSubmit,
  onCancelRename,
  registerRowElement,
}: FileTreeEntryContentProps) {
  const rowClass = [
    "flex h-full cursor-pointer select-none items-center gap-1 rounded px-2 outline-none",
    isSelected ? "bg-zinc-800" : "hover:bg-zinc-800",
    isFocused ? "ring-1 ring-zinc-500" : "",
    isDragOver ? "ring-1 ring-zinc-500 ring-offset-0" : "",
  ].join(" ");

  return (
    <div
      ref={(element) => registerRowElement(entryPath, element)}
      id={`file-tree-row-${encodeURIComponent(entryPath)}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      aria-expanded={isDirectory ? isExpanded : undefined}
      data-file-row-path={entryPath}
      data-file-row-is-directory={isDirectory ? "1" : "0"}
      data-drop-dir={isDirectory ? entryPath : undefined}
      className={rowClass}
      style={{ paddingLeft: `${depth * INDENT_WIDTH + 8}px` }}
      tabIndex={tabIndex}
      onPointerDown={(event) => onRowPointerDown(entryPath, event)}
      onFocus={() => onRowFocus(entryPath)}
      onKeyDown={(event) => onRowKeyDown(entryPath, event)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
        {isDirectory && (
          <ChevronRight
            className={`h-3 w-3 text-zinc-500 transition-transform duration-150 motion-reduce:transition-none ${isExpanded ? "rotate-90" : ""}`}
          />
        )}
      </span>
      <MaterialIcon name={iconName} size={16} />
      {isRenaming ? (
        <FileExplorerInlineNameInput
          initialValue={entryName}
          type={isDirectory ? "directory" : "file"}
          onSubmit={(name) => onRenameSubmit(entryPath, name)}
          onCancel={onCancelRename}
        />
      ) : (
        <MatchHighlight
          text={entryName}
          highlight={searchFilter}
          className="ml-1 truncate text-xs text-zinc-300"
          highlightClassName="rounded-sm bg-zinc-700 px-0.5 text-zinc-100"
        />
      )}
    </div>
  );
});

export const FileTreeRow = memo(function FileTreeRow({
  row,
  style,
  rootDirectory,
  searchFilter,
  isSelected,
  isFocused,
  isDragOver,
  isRenaming,
  tabIndex,
  selectedPaths,
  directoryPaths,
  onSelectPath,
  onContextSelectPath,
  onToggleDirectory,
  onPreviewFile,
  onOpenFile,
  onRenameSubmit,
  onCancelRename,
  onCreateSubmit,
  onCancelCreate,
  onRowPointerDown,
  onRowFocus,
  onRowKeyDown,
  registerRowElement,
  onBulkDelete,
  onBulkCopyPaths,
}: FileTreeRowProps) {
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
      }
      if (row.kind === "entry") {
        registerRowElement(row.entry.path, null);
      }
    };
  }, [registerRowElement, row]);

  if (row.kind === "create") {
    return (
      <div style={style}>
        <div
          className="flex h-full items-center"
          style={{ paddingLeft: `${row.depth * INDENT_WIDTH + 8}px` }}
        >
          <FileExplorerInlineNameInput
            type={row.createType}
            onSubmit={(name) => onCreateSubmit(row.parentPath, name, row.createType)}
            onCancel={onCancelCreate}
          />
        </div>
      </div>
    );
  }

  if (row.kind === "loading") {
    return (
      <div style={style}>
        <div
          className="flex h-full items-center text-xs text-zinc-500"
          style={{ paddingLeft: `${row.depth * INDENT_WIDTH + 8}px` }}
        >
          Loading...
        </div>
      </div>
    );
  }

  if (row.kind === "error") {
    return (
      <div style={style}>
        <div
          className="flex h-full items-center text-xs text-red-400"
          style={{ paddingLeft: `${row.depth * INDENT_WIDTH + 8}px` }}
        >
          Error: {row.message}
        </div>
      </div>
    );
  }

  if (row.kind !== "entry") {
    return null;
  }

  const { entry } = row;
  const iconName = entry.is_directory
    ? resolveFolderIcon(entry.name, row.isExpanded)
    : resolveFileIcon(entry.name, entry.extension ?? undefined);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.focus();
    onSelectPath(entry.path, event);

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      return;
    }

    if (entry.is_directory) {
      onToggleDirectory(entry.path);
      return;
    }

    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }

    if (event.detail > 1) {
      onOpenFile(entry.path);
      return;
    }

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onPreviewFile(entry.path);
    }, 250);
  };

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.focus();
    onContextSelectPath(entry.path);
  };

  return (
    <div style={style}>
      <FileExplorerContextMenu
        entry={entry}
        rootDirectory={rootDirectory}
        selectedPaths={selectedPaths}
        selectedDirectoryPaths={directoryPaths}
        onOpenFile={onOpenFile}
        onBulkDelete={onBulkDelete}
        onBulkCopyPaths={onBulkCopyPaths}
      >
        <FileTreeEntryContent
          entryPath={entry.path}
          entryName={entry.name}
          isDirectory={entry.is_directory}
          isExpanded={row.isExpanded}
          depth={row.depth}
          searchFilter={searchFilter}
          iconName={iconName}
          isSelected={isSelected}
          isFocused={isFocused}
          isDragOver={isDragOver}
          isRenaming={isRenaming}
          tabIndex={tabIndex}
          onRowPointerDown={onRowPointerDown}
          onRowFocus={onRowFocus}
          onRowKeyDown={onRowKeyDown}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onRenameSubmit={onRenameSubmit}
          onCancelRename={onCancelRename}
          registerRowElement={registerRowElement}
        />
      </FileExplorerContextMenu>
    </div>
  );
});
