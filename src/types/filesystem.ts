export interface DirEntry {
  name: string;
  path: string;
  is_directory: boolean;
  extension: string | null;
}

export interface TextFile {
  path: string;
  content: string;
  size: number;
  modifiedMs: number;
}

export interface ImportExternalPathConflict {
  sourcePath: string;
  destinationPath: string;
  name: string;
}

export interface ImportExternalPathFailure {
  sourcePath: string;
  destinationPath: string | null;
  error: string;
}

export interface ImportExternalPathsResult {
  importedPaths: string[];
  conflicts: ImportExternalPathConflict[];
  failures: ImportExternalPathFailure[];
}

export interface FileChangeBatchEvent {
  changedDirs: string[];
  changedPaths?: string[];
  includesGitMetadata?: boolean;
  kind: string;
}
