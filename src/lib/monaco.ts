import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type WorkerConstructor = new () => Worker;

const workerByLabel: Record<string, WorkerConstructor> = {
  css: cssWorker,
  scss: cssWorker,
  less: cssWorker,
  html: htmlWorker,
  handlebars: htmlWorker,
  razor: htmlWorker,
  json: jsonWorker,
  javascript: tsWorker,
  typescript: tsWorker,
};

(
  self as unknown as {
    MonacoEnvironment: { getWorker: (_moduleId: string, label: string) => Worker };
  }
).MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    const WorkerClass = workerByLabel[label] ?? editorWorker;
    return new WorkerClass();
  },
};

loader.config({ monaco });
