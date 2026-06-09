import { invoke } from "@tauri-apps/api/core";

export interface ModuleDiagnostics {
  moduleName: string;
  healthcheckUrl: string;
  healthy: boolean;
  runtimePort?: number;
  panelCount: number;
}

export interface AppDiagnostics {
  modules: ModuleDiagnostics[];
}

export function getAppDiagnostics(): Promise<AppDiagnostics> {
  return invoke<AppDiagnostics>("get_app_diagnostics");
}
