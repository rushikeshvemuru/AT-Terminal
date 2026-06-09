import { invoke } from "@tauri-apps/api/core";

export interface ApprovedRoot {
  path: string;
}

export function selectWorkspaceRoot(title?: string): Promise<ApprovedRoot | null> {
  return invoke<ApprovedRoot | null>("select_workspace_root", { title: title ?? null });
}
