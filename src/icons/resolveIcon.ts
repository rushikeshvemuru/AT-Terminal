import {
  fileExtensions,
  fileNames,
  folderNames,
  folderNamesExpanded,
  defaults,
} from "./generated/iconManifest";
import { getIconSvg } from "./iconSvgs";

export function resolveFileIcon(fileName: string, extension?: string): string {
  const lowerName = fileName.toLowerCase();

  // Priority: exact filename match > extension match > fallback
  if (fileNames[lowerName]) {
    return fileNames[lowerName];
  }

  if (extension) {
    const lowerExt = extension.toLowerCase();
    if (fileExtensions[lowerExt]) {
      return fileExtensions[lowerExt];
    }
  }

  return defaults.file;
}

export function resolveFolderIcon(folderName: string, expanded: boolean): string {
  const lowerName = folderName.toLowerCase();

  if (expanded) {
    return folderNamesExpanded[lowerName] ?? defaults.folderExpanded;
  }

  return folderNames[lowerName] ?? defaults.folder;
}

export { getIconSvg };
