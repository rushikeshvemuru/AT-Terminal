import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "@/types/filesystem";

const directoryCache = new Map<string, DirEntry[]>();
const directoryLoadCache = new Map<string, Promise<DirEntry[]>>();
const invalidationListeners = new Set<(normalizedDirs: string[]) => void>();

export function normalizeDirectoryPath(path: string): string {
  if (!path) return path;
  const slash = path.replace(/\\/g, "/");
  if (slash === "/" || /^[A-Za-z]:\/$/.test(slash)) return slash;
  return slash.replace(/\/+$/, "");
}

function getCacheKey(path: string, includeHidden: boolean): string {
  return `${normalizeDirectoryPath(path)}:${includeHidden}`;
}

export function subscribeDirectoryInvalidations(
  listener: (normalizedDirs: string[]) => void,
): () => void {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

function notifyInvalidations(normalizedDirs: string[]) {
  invalidationListeners.forEach((listener) => {
    listener(normalizedDirs);
  });
}

export function getCachedDirectoryListing(
  path: string,
  includeHidden = false,
): DirEntry[] | undefined {
  return directoryCache.get(getCacheKey(path, includeHidden));
}

export async function loadDirectoryListing(
  path: string,
  includeHidden = false,
): Promise<DirEntry[]> {
  const cacheKey = getCacheKey(path, includeHidden);
  const cached = directoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const existingRequest = directoryLoadCache.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = invoke<DirEntry[]>("list_directory", { path, includeHidden }).then((result) => {
    directoryCache.set(cacheKey, result);
    return result;
  });

  directoryLoadCache.set(cacheKey, request);

  try {
    return await request;
  } finally {
    directoryLoadCache.delete(cacheKey);
  }
}

export function useDirectoryListing(path: string | null, includeHidden?: boolean) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const normalizedPath = path ? normalizeDirectoryPath(path) : null;
  const hidden = includeHidden ?? false;

  useEffect(() => {
    if (!normalizedPath) return;
    return subscribeDirectoryInvalidations((dirs) => {
      if (dirs.includes(normalizedPath)) {
        setRefreshKey((key) => key + 1);
      }
    });
  }, [normalizedPath]);

  useEffect(() => {
    let cancelled = false;
    const applyState = (
      nextEntries: DirEntry[],
      nextError: string | null,
      nextLoading: boolean,
    ) => {
      if (cancelled) return;
      setEntries(nextEntries);
      setError(nextError);
      setLoading(nextLoading);
    };

    if (!path || !normalizedPath) {
      queueMicrotask(() => applyState([], null, false));
      return () => {
        cancelled = true;
      };
    }

    const cached = getCachedDirectoryListing(path, hidden);
    if (cached) {
      queueMicrotask(() => applyState(cached, null, false));
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });

    loadDirectoryListing(path, hidden)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(typeof err === "string" ? err : String(err));
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, normalizedPath, hidden, refreshKey]);

  const invalidate = useCallback((dirPath: string) => {
    invalidateDirectories(new Set([dirPath]));
  }, []);

  return { entries, loading, error, invalidate };
}

export function invalidateDirectories(dirPaths: Set<string>) {
  const normalizedDirs = Array.from(dirPaths)
    .map((dir) => normalizeDirectoryPath(dir))
    .filter(Boolean);
  if (normalizedDirs.length === 0) return;
  const normalizedDirSet = new Set(normalizedDirs);

  for (const key of directoryCache.keys()) {
    const [cachedDir] = key.split(":");
    if (normalizedDirSet.has(cachedDir)) {
      directoryCache.delete(key);
      directoryLoadCache.delete(key);
    }
  }

  notifyInvalidations(normalizedDirs);
}

export function invalidateDirectoryCache(dirPath: string) {
  invalidateDirectories(new Set([dirPath]));
}
