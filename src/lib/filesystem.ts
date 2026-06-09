import { invoke } from "@tauri-apps/api/core";
import type { DirEntry, ImportExternalPathsResult, TextFile } from "@/types/filesystem";

export function readTextFile(rootDirectory: string, path: string): Promise<TextFile> {
  return invoke<TextFile>("read_text_file", { rootDirectory, path });
}

export function writeTextFile(
  rootDirectory: string,
  path: string,
  content: string,
  expectedModifiedMs: number,
): Promise<TextFile> {
  return invoke<TextFile>("write_text_file", {
    rootDirectory,
    path,
    content,
    expectedModifiedMs,
  });
}

export function listDirectory(path: string, includeHidden?: boolean): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_directory", { path, includeHidden: includeHidden ?? false });
}

export async function directoryExists(path: string): Promise<boolean> {
  try {
    await listDirectory(path);
    return true;
  } catch {
    return false;
  }
}

export function createFile(
  rootDirectory: string,
  parentPath: string,
  name: string,
): Promise<string> {
  return invoke<string>("create_file", { rootDirectory, parentPath, name });
}

export function createDirectory(
  rootDirectory: string,
  parentPath: string,
  name: string,
): Promise<string> {
  return invoke<string>("create_directory", { rootDirectory, parentPath, name });
}

export function renamePath(rootDirectory: string, path: string, newName: string): Promise<string> {
  return invoke<string>("rename_path", { rootDirectory, path, newName });
}

export function movePath(
  rootDirectory: string,
  sourcePath: string,
  destDir: string,
): Promise<string> {
  return invoke<string>("move_path", { rootDirectory, sourcePath, destDir });
}

export function importExternalPaths(
  rootDirectory: string,
  destinationDir: string,
  sourcePaths: string[],
  replaceExisting?: boolean,
): Promise<ImportExternalPathsResult> {
  return invoke<ImportExternalPathsResult>("import_external_paths", {
    rootDirectory,
    destinationDir,
    sourcePaths,
    replaceExisting: replaceExisting ?? false,
  });
}

export function deletePath(
  rootDirectory: string,
  path: string,
  recursive?: boolean,
): Promise<void> {
  return invoke<void>("delete_path", { rootDirectory, path, recursive: recursive ?? false });
}

export function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

export function setWatchedRoot(rootPath: string): Promise<void> {
  return invoke<void>("set_watched_root", { rootPath });
}

export function stopWatchingRoot(): Promise<void> {
  return invoke<void>("stop_watching_root");
}
