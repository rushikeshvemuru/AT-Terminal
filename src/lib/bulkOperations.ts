import { deletePath, movePath } from "@/lib/filesystem";

export async function deletePaths(
  rootDirectory: string,
  paths: string[],
  directorySet: Set<string>,
) {
  for (const path of paths) {
    const isDirectory = directorySet.has(path);
    await deletePath(rootDirectory, path, isDirectory);
  }
}

export async function movePaths(rootDirectory: string, paths: string[], destinationDir: string) {
  const moved = new Map<string, string>();
  for (const path of paths) {
    const next = await movePath(rootDirectory, path, destinationDir);
    moved.set(path, next);
  }
  return moved;
}

export async function copyPathsToClipboard(paths: string[]) {
  await navigator.clipboard.writeText(paths.join("\n"));
}
