import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry } from "@/types/filesystem";
import {
  getCachedDirectoryListing,
  loadDirectoryListing,
  normalizeDirectoryPath,
  subscribeDirectoryInvalidations,
} from "@/hooks/useDirectoryListing";

type DirectoryStatus = "idle" | "loading" | "loaded" | "error";

interface DirectoryState {
  status: DirectoryStatus;
  entries: DirEntry[];
  error: string | null;
}

interface FlattenContext {
  normalizedSearchFilter: string;
  expandedPaths: Set<string>;
  creatingInPath: string | null;
  creatingType: "file" | "directory" | null;
  listings: Record<string, DirectoryState>;
}

export interface FileTreeEntryRow {
  kind: "entry";
  key: string;
  path: string;
  depth: number;
  entry: DirEntry;
  isExpanded: boolean;
}

export interface FileTreeCreateRow {
  kind: "create";
  key: string;
  path: string;
  depth: number;
  parentPath: string;
  createType: "file" | "directory";
}

export interface FileTreeStatusRow {
  kind: "loading" | "error";
  key: string;
  path: string;
  depth: number;
  parentPath: string;
  message?: string;
}

export type FileTreeRow = FileTreeEntryRow | FileTreeCreateRow | FileTreeStatusRow;

export interface UseFlattenedFileTreeResult {
  rows: FileTreeRow[];
  rootEntries: DirEntry[];
  rootLoading: boolean;
  rootError: string | null;
  visibleEntryPaths: string[];
  visibleDirectoryPaths: Set<string>;
  visibleIndexByPath: Map<string, number>;
  entryRowByPath: Map<string, FileTreeEntryRow>;
  firstVisiblePath: string | null;
  totalEntryCount: number;
  shownEntryCount: number;
  invalidateAllLoaded: () => Promise<void>;
}

interface BuildRowsResult {
  rows: FileTreeRow[];
  visibleEntryPaths: string[];
  visibleDirectoryPaths: string[];
  hasVisibleEntries: boolean;
  totalEntryCount: number;
}

function createDirectoryState(entries?: DirEntry[]): DirectoryState {
  if (entries) {
    return { status: "loaded", entries, error: null };
  }
  return { status: "idle", entries: [], error: null };
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function shouldIncludeEntry(entry: DirEntry, filter: string) {
  return filter.length === 0 || entry.name.toLowerCase().includes(filter);
}

function buildRowsForEntries(
  entries: DirEntry[],
  depth: number,
  context: FlattenContext,
): BuildRowsResult {
  const rows: FileTreeRow[] = [];
  const visibleEntryPaths: string[] = [];
  const visibleDirectoryPaths: string[] = [];
  let hasVisibleEntries = false;
  let totalEntryCount = 0;

  for (const entry of entries) {
    totalEntryCount += 1;
    const isExpanded = entry.is_directory && context.expandedPaths.has(entry.path);
    const childState = entry.is_directory ? context.listings[entry.path] : undefined;
    const childRows: FileTreeRow[] = [];
    let childHasVisibleEntries = false;
    let childVisibleEntryPaths: string[] = [];
    let childVisibleDirectoryPaths: string[] = [];

    if (isExpanded) {
      if (context.creatingInPath === entry.path && context.creatingType) {
        childRows.push({
          kind: "create",
          key: `create:${entry.path}:${context.creatingType}`,
          path: `${entry.path}::create`,
          depth: depth + 1,
          parentPath: entry.path,
          createType: context.creatingType,
        });
      }

      if (!childState || childState.status === "idle" || childState.status === "loading") {
        childRows.push({
          kind: "loading",
          key: `loading:${entry.path}`,
          path: `${entry.path}::loading`,
          depth: depth + 1,
          parentPath: entry.path,
        });
      } else if (childState.status === "error") {
        childRows.push({
          kind: "error",
          key: `error:${entry.path}`,
          path: `${entry.path}::error`,
          depth: depth + 1,
          parentPath: entry.path,
          message: childState.error ?? "Failed to load directory",
        });
      } else {
        const nested = buildRowsForEntries(childState.entries, depth + 1, context);
        childRows.push(...nested.rows);
        childHasVisibleEntries = nested.hasVisibleEntries;
        childVisibleEntryPaths = nested.visibleEntryPaths;
        childVisibleDirectoryPaths = nested.visibleDirectoryPaths;
        totalEntryCount += nested.totalEntryCount;
      }
    }

    const matchesFilter = shouldIncludeEntry(entry, context.normalizedSearchFilter);
    const includeEntry =
      context.normalizedSearchFilter.length === 0 || matchesFilter || childHasVisibleEntries;
    if (!includeEntry) {
      continue;
    }

    rows.push({
      kind: "entry",
      key: entry.path,
      path: entry.path,
      depth,
      entry,
      isExpanded,
    });
    visibleEntryPaths.push(entry.path);
    if (entry.is_directory) {
      visibleDirectoryPaths.push(entry.path);
    }

    if (isExpanded) {
      rows.push(...childRows);
      visibleEntryPaths.push(...childVisibleEntryPaths);
      visibleDirectoryPaths.push(...childVisibleDirectoryPaths);
    }

    hasVisibleEntries = true;
  }

  return {
    rows,
    visibleEntryPaths,
    visibleDirectoryPaths,
    hasVisibleEntries,
    totalEntryCount,
  };
}

export function useFlattenedFileTree(
  rootDirectory: string | null,
  includeHidden: boolean,
  expandedPaths: Set<string>,
  searchFilter: string,
  creatingInPath: string | null,
  creatingType: "file" | "directory" | null,
): UseFlattenedFileTreeResult {
  const [listings, setListings] = useState<Record<string, DirectoryState>>({});
  const flattenedCacheRef = useRef<{
    visibleEntryPaths: string[];
    visibleDirectoryPaths: Set<string>;
  } | null>(null);
  const normalizedRootDirectory = rootDirectory ? normalizeDirectoryPath(rootDirectory) : null;

  const loadDirectory = useCallback(
    async (path: string, options?: { force?: boolean }) => {
      const normalizedPath = normalizeDirectoryPath(path);
      const force = options?.force ?? false;
      const cached = !force ? getCachedDirectoryListing(path, includeHidden) : undefined;

      setListings((current) => {
        const existing = current[normalizedPath];
        if (cached) {
          return {
            ...current,
            [normalizedPath]: createDirectoryState(cached),
          };
        }
        if (!force && (existing?.status === "loading" || existing?.status === "loaded")) {
          return current;
        }
        return {
          ...current,
          [normalizedPath]: {
            status: "loading",
            entries: existing?.entries ?? [],
            error: null,
          },
        };
      });

      if (cached) {
        return;
      }

      try {
        const entries = await loadDirectoryListing(path, includeHidden);
        setListings((current) => ({
          ...current,
          [normalizedPath]: {
            status: "loaded",
            entries,
            error: null,
          },
        }));
      } catch (error) {
        setListings((current) => ({
          ...current,
          [normalizedPath]: {
            status: "error",
            entries: [],
            error: typeof error === "string" ? error : String(error),
          },
        }));
      }
    },
    [includeHidden],
  );

  useEffect(() => {
    if (!normalizedRootDirectory || !rootDirectory) {
      setListings({});
      return;
    }
    setListings({});
    void loadDirectory(rootDirectory, { force: true });
  }, [loadDirectory, normalizedRootDirectory, rootDirectory]);

  useEffect(() => {
    if (!normalizedRootDirectory) return;
    expandedPaths.forEach((path) => {
      void loadDirectory(path);
    });
  }, [expandedPaths, loadDirectory, normalizedRootDirectory]);

  useEffect(() => {
    if (!normalizedRootDirectory) return;
    return subscribeDirectoryInvalidations((directories) => {
      directories.forEach((directory) => {
        if (directory === normalizedRootDirectory || listings[directory]) {
          void loadDirectory(directory, { force: true });
        }
      });
    });
  }, [listings, loadDirectory, normalizedRootDirectory]);

  const rootState = normalizedRootDirectory
    ? (listings[normalizedRootDirectory] ?? createDirectoryState())
    : createDirectoryState();
  const rootEntries = rootState.entries;

  const flattenedTree = useMemo(() => {
    const previous = flattenedCacheRef.current;
    if (!normalizedRootDirectory) {
      const next = {
        rows: [] as FileTreeRow[],
        visibleEntryPaths: [] as string[],
        visibleDirectoryPaths: new Set<string>(),
        totalEntryCount: 0,
      };
      flattenedCacheRef.current = {
        visibleEntryPaths: next.visibleEntryPaths,
        visibleDirectoryPaths: next.visibleDirectoryPaths,
      };
      return next;
    }

    const baseRows: FileTreeRow[] = [];
    if (creatingInPath === normalizedRootDirectory && creatingType) {
      baseRows.push({
        kind: "create",
        key: `create:${normalizedRootDirectory}:${creatingType}`,
        path: `${normalizedRootDirectory}::create`,
        depth: 0,
        parentPath: normalizedRootDirectory,
        createType: creatingType,
      });
    }

    if (rootState.status !== "loaded") {
      const next = {
        rows: baseRows,
        visibleEntryPaths: [] as string[],
        visibleDirectoryPaths: new Set<string>(),
        totalEntryCount: 0,
      };
      flattenedCacheRef.current = {
        visibleEntryPaths: next.visibleEntryPaths,
        visibleDirectoryPaths: next.visibleDirectoryPaths,
      };
      return next;
    }

    const flattened = buildRowsForEntries(rootEntries, 0, {
      normalizedSearchFilter: searchFilter.trim().toLowerCase(),
      expandedPaths,
      creatingInPath,
      creatingType,
      listings,
    });

    const nextVisibleEntryPaths =
      previous && stringArraysEqual(previous.visibleEntryPaths, flattened.visibleEntryPaths)
        ? previous.visibleEntryPaths
        : flattened.visibleEntryPaths;
    const nextVisibleDirectoryPaths =
      previous &&
      stringArraysEqual(Array.from(previous.visibleDirectoryPaths), flattened.visibleDirectoryPaths)
        ? previous.visibleDirectoryPaths
        : new Set(flattened.visibleDirectoryPaths);

    const next = {
      rows: baseRows.concat(flattened.rows),
      visibleEntryPaths: nextVisibleEntryPaths,
      visibleDirectoryPaths: nextVisibleDirectoryPaths,
      totalEntryCount: flattened.totalEntryCount,
    };
    flattenedCacheRef.current = {
      visibleEntryPaths: next.visibleEntryPaths,
      visibleDirectoryPaths: next.visibleDirectoryPaths,
    };
    return next;
  }, [
    creatingInPath,
    creatingType,
    expandedPaths,
    listings,
    normalizedRootDirectory,
    rootEntries,
    rootState.status,
    searchFilter,
  ]);

  const invalidateAllLoaded = useCallback(async () => {
    const paths = Object.keys(listings);
    await Promise.all(paths.map((path) => loadDirectory(path, { force: true })));
  }, [listings, loadDirectory]);

  const visibleIndexByPath = useMemo(
    () => new Map(flattenedTree.visibleEntryPaths.map((path, index) => [path, index])),
    [flattenedTree.visibleEntryPaths],
  );
  const entryRowByPath = useMemo(() => {
    const next = new Map<string, FileTreeEntryRow>();
    for (const row of flattenedTree.rows) {
      if (row.kind === "entry") {
        next.set(row.path, row);
      }
    }
    return next;
  }, [flattenedTree.rows]);
  const firstVisiblePath = flattenedTree.visibleEntryPaths[0] ?? null;

  return {
    rows: flattenedTree.rows,
    rootEntries,
    rootLoading: rootState.status === "loading" && rootEntries.length === 0,
    rootError: rootState.status === "error" ? rootState.error : null,
    visibleEntryPaths: flattenedTree.visibleEntryPaths,
    visibleDirectoryPaths: flattenedTree.visibleDirectoryPaths,
    visibleIndexByPath,
    entryRowByPath,
    firstVisiblePath,
    totalEntryCount: flattenedTree.totalEntryCount,
    shownEntryCount: flattenedTree.visibleEntryPaths.length,
    invalidateAllLoaded,
  };
}
