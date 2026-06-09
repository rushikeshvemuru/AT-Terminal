# Module Authoring Guide

This guide explains how to add a new AT-Terminal module, how the host discovers it, and how to build iframe panels that integrate with the panel toolbar and popup protocol.

## Overview

AT-Terminal loads modules from `AT-modules/` at app startup. Each active module contributes one or more panel types. Panel types are always namespaced as `module.localType`, for example `base.terminal` or `editor.monaco`.

There are two ways a module can surface UI:

1. Iframe-backed module panels
   These are discovered entirely from `AT-modules/{module}/metadata.json`. The host renders them through [`ModulePanelHost.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/panels/ModulePanelHost.tsx).
2. Native React panels
   These still need module metadata for discovery, but the frontend must register a React component with [`registerNativePanel()`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts).

The panel toolbar and popup features apply only to iframe-backed module panels in v1.

## Directory Layout

Recommended layout:

```text
AT-modules/
  module_config.json
  editor/
    metadata.json
    scripts/
      start.sh
    server/
      ...
    ui/
      panel.html
      assets/
        save.svg
```

Only `metadata.json` is required by the loader. Startup scripts, servers, and static UI assets are module-defined.

## Activating A Module

AT-Terminal reads `AT-modules/module_config.json` and only loads modules listed in `active_modules`.

```json
{
  "active_modules": ["base", "editor"]
}
```

If a module is not listed there, it will not be initialized and its panel types will not appear in the panel registry.

## Writing `metadata.json`

Every module needs a `metadata.json` file in its module root.

```json
{
  "module_name": "editor",
  "panel_types": ["workspace", "preview"],
  "panel_display_names": {
    "workspace": "Editor"
  },
  "panel_colors": {
    "workspace": "#22c55e",
    "preview": "#38bdf8"
  },
  "startup_script_location": "scripts/start.sh",
  "startup_script_command": "bash scripts/start.sh",
  "panel_url_template": "http://127.0.0.1:48100/panels/{panel_type}",
  "healthcheck_url": "http://127.0.0.1:48100/health",
  "panel_tool_bar": {
    "workspace": {
      "items": [
        {
          "id": "save",
          "kind": "button",
          "text": "Save",
          "icon_path": "/assets/save.svg",
          "color": "#22c55e",
          "tooltip": "Save current file",
          "command": "save"
        },
        {
          "id": "format",
          "kind": "button",
          "text": "Format",
          "icon_path": "/assets/format.svg",
          "tooltip": "Format current file",
          "command": "format"
        }
      ]
    }
  }
}
```

Important rules:

- `module_name` must match the module directory and the namespace prefix you want in panel IDs.
- `panel_types` uses local type names only. The host turns `workspace` into `editor.workspace`.
- `panel_display_names` is optional and keyed by local panel type. Use it to override the UI label shown for that panel type without changing its internal namespaced ID.
- `panel_colors` is optional and keyed by local panel type. Missing or empty entries default to white.
- `panel_url_template` must be a resolvable URL template. The host replaces `{panel_type}` with the local type and `{namespaced_type}` with the fully qualified type.
- `healthcheck_url` is used before the iframe is loaded. If it is empty, the host skips health polling and loads the iframe immediately.
- `panel_tool_bar` is optional and keyed by local panel type, not namespaced type.

## Startup Scripts, Healthchecks, And URL Templates

Startup and health behavior is handled by [`modules.rs`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src-tauri/src/commands/modules.rs).

At startup the host:

1. Reads `module_config.json`.
2. Loads each active module's `metadata.json`.
3. Spawns `startup_script_command` from the module directory.
4. Polls `healthcheck_url`.
5. Exposes the runtime registry to the frontend.

Behavior details:

- `startup_script_location` is informational today. `startup_script_command` is the field that is executed.
- The startup command runs with the module directory as its working directory.
- If a module process exits, the host will retry with backoff.
- For iframe panels with toolbar icons, the host may also validate declared `icon_path` asset URLs as part of module readiness. A server that still answers `/health` but is missing current toolbar assets can be treated as stale and restarted.
- Modules are not required to use dedicated ports. The host trusts the URLs declared in metadata.

## How Iframe Panels Receive Context

When the host builds a panel URL in [`ModulePanelHost.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/panels/ModulePanelHost.tsx), it appends query parameters for panel context:

- `panelId`
- `panelType`
- `localType`
- `rootDirectory`
- `startupCommand` when present in panel state
- `startupNonce` when present in panel state

Your iframe can read those values from `window.location.search`.

## Native React Panels Versus Iframe Panels

Use an iframe-backed panel when the module owns its own web UI or server and can communicate through `postMessage`.

Use a native React panel when:

- the panel should live inside the main frontend bundle
- you want direct access to shared Zustand state and React primitives
- you do not need module-hosted isolation

Native panels require a frontend registration step:

```ts
import { registerNativePanel } from "@/lib/panelRegistry";
import { EditorPanel } from "@/components/panels/EditorPanel";

registerNativePanel({
  type: "editor.workspace",
  component: EditorPanel,
});
```

Iframe panels do not need a React registration. Metadata is enough.

## End-To-End Toolbar Example

This is the recommended flow for a toolbar-enabled iframe module panel.

### 1. Declare the toolbar in `metadata.json`

```json
{
  "module_name": "editor",
  "panel_types": ["workspace"],
  "startup_script_command": "bash scripts/start.sh",
  "panel_url_template": "http://127.0.0.1:48100/panels/{panel_type}",
  "healthcheck_url": "http://127.0.0.1:48100/health",
  "panel_tool_bar": {
    "workspace": {
      "items": [
        {
          "id": "save",
          "kind": "button",
          "text": "Save",
          "icon_path": "/assets/save.svg",
          "color": "#22c55e",
          "tooltip": "Save current file",
          "command": "save"
        },
        {
          "id": "run",
          "kind": "button",
          "text": "Run",
          "icon_path": "/assets/play.svg",
          "color": "#38bdf8",
          "tooltip": "Run current file",
          "command": "run"
        }
      ]
    }
  }
}
```

### 2. Handle toolbar clicks and runtime widgets in the iframe

```html
<script>
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId");

  function patchToolbar(items) {
    window.parent.postMessage(
      {
        type: "at.panelToolbar.patch",
        panelId,
        items,
      },
      "*",
    );
  }

  function setToolbar(items) {
    window.parent.postMessage(
      {
        type: "at.panelToolbar.set",
        panelId,
        items,
      },
      "*",
    );
  }

  setToolbar([
    {
      id: "mode",
      kind: "select",
      text: "Mode",
      command: "mode:change",
      value: "edit",
      options: [
        { value: "edit", label: "Edit" },
        { value: "review", label: "Review" }
      ]
    },
    {
      id: "filter",
      kind: "text",
      placeholder: "Filter",
      command: "filter:change"
    },
    {
      id: "watch",
      kind: "toggle",
      text: "Watch",
      command: "watch:toggle",
      checked: false
    },
    {
      id: "timeout",
      kind: "number",
      text: "Timeout",
      value: 30,
      min: 0,
      step: 5,
      command: "timeout:change"
    },
    {
      id: "zoom",
      kind: "slider",
      text: "Zoom",
      value: 100,
      min: 50,
      max: 200,
      step: 10,
      showValue: true,
      command: "zoom:change"
    },
    {
      id: "view",
      kind: "segmented",
      value: "logs",
      command: "view:change",
      options: [
        { value: "view", label: "View" },
        { value: "diff", label: "Diff" },
        { value: "logs", label: "Logs" }
      ]
    },
    {
      id: "actions",
      kind: "menu",
      text: "Actions",
      items: [
        { id: "format", text: "Format", command: "format" },
        { id: "restart", text: "Restart", command: "restart" }
      ]
    },
    {
      id: "nav",
      kind: "buttonGroup",
      items: [
        { id: "prev", text: "Prev", command: "nav:prev" },
        { id: "next", text: "Next", command: "nav:next" }
      ]
    },
    {
      id: "state",
      kind: "status",
      text: "Connected",
      tone: "success"
    },
    {
      id: "indexing",
      kind: "progress",
      text: "Indexing",
      progress: 42,
      showValue: true,
      tone: "info"
    },
    { id: "divide-actions", kind: "separator" },
    {
      id: "run",
      kind: "button",
      text: "Run",
      iconPath: "/assets/play.svg",
      tooltip: "Run current file",
      command: "run"
    }
  ]);

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.panelId !== panelId) return;

    if (message.type === "at.panelToolbar.click" && message.command === "save") {
      patchToolbar([{ id: "save", disabled: true, text: "Saving..." }]);
      await saveFile();
      patchToolbar([{ id: "save", disabled: false, text: "Save" }]);
    }

    if (message.type === "at.panelToolbar.click" && message.command === "run") {
      patchToolbar([{ id: "run", disabled: true }]);
      await runCurrentFile();
      patchToolbar([{ id: "run", disabled: false }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "filter:change") {
      patchToolbar([{ id: "filter", value: message.value }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "watch:toggle") {
      patchToolbar([{ id: "watch", checked: message.value }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "timeout:change") {
      patchToolbar([{ id: "timeout", value: message.value }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "zoom:change") {
      patchToolbar([{ id: "zoom", value: message.value }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "view:change") {
      patchToolbar([{ id: "view", value: message.value }]);
    }

    if (message.type === "at.panelToolbar.click" && message.parentItemId === "actions") {
      await runAction(message.command);
    }
  });
<\/script>
```

### 3. Use metadata defaults and runtime structure intentionally

Toolbar metadata is the startup default. `at.panelToolbar.patch` updates existing effective items. `at.panelToolbar.set` replaces the effective runtime toolbar, so modules can add widgets, remove widgets, and reorder the toolbar while the panel is loaded.

### 4. Re-send state after reloads

Runtime toolbar state is not persisted. If the iframe reloads, reconnects, or the session is restored, the host falls back to metadata defaults and your module should send fresh `set` or `patch` messages.

## Best Practices

- Keep toolbar item IDs stable. They are the key used for runtime patches and value changes.
- Treat `command` values as module-internal action names, not user-facing labels.
- Use relative `icon_path` values when the asset is served by the same module origin.
- Use `icon_path` in metadata and `iconPath` in runtime messages.
- Prefer `at.panelToolbar.set` for add/remove/reorder and `at.panelToolbar.patch` for lightweight state updates.
- Prefer SVG toolbar icons authored with `fill="currentColor"` and/or `stroke="currentColor"` so the host can tint them when it renders same-origin SVGs in its color-inheriting path.
- If you change toolbar asset routes or filenames on a long-running module server, make sure startup replaces any older process still bound to the same port. The bundled base module does this in its startup script.
- If the host cannot inline the SVG, or if the icon is not an SVG, the toolbar falls back to normal image rendering.
- Keep click handlers idempotent. The host forwards clicks but does not add optimistic loading behavior.
- Use the toolbar for short, contextual actions. Do not try to turn it into a full secondary menu system in v1.

## Module Popup Panels

Use a module popup when the module needs a host-managed modal surface but still wants to render its own iframe content.

Popup behavior in v1:

- the source panel opens the popup through `postMessage`
- the host renders the popup shell and close controls
- popup content is loaded from the same module origin
- the popup is ephemeral and is not restored from session state
- the popup iframe receives `popupId`, not the normal panel context params

### 1. Open the popup from a source panel

```html
<script>
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId");

  function openPopup() {
    window.parent.postMessage(
      {
        type: "at.panelPopup.open",
        panelId,
        route: "/panels/popup-demo",
        title: "Module Popup",
        width: 720,
        height: 480,
      },
      "*",
    );
  }
<\/script>
```

Guidelines:

- `route` should normally reuse the module's existing route namespace, for example `/panels/...`
- the host resolves the route against the module's current panel URL template
- the route must stay on the same origin as the module panel

### 2. Close the popup from popup content

```html
<script>
  const params = new URLSearchParams(window.location.search);
  const popupId = params.get("popupId");

  function closePopup() {
    window.parent.postMessage(
      {
        type: "at.panelPopup.close",
        popupId,
      },
      "*",
    );
  }
<\/script>
```

### 3. Understand replacement behavior

- each source panel may have one active popup at a time
- sending another open request from the same source panel replaces the current popup
- closing the source panel or changing sessions also closes the popup

## Source Of Truth In Code

These files define the current contract:

- Runtime metadata loader: [`modules.rs`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src-tauri/src/commands/modules.rs)
- Frontend registry types: [`panelRegistry.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts)
- Iframe host messaging: [`ModulePanelHost.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/panels/ModulePanelHost.tsx)
- Top toolbar rendering: [`Toolbar.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/Toolbar.tsx)
- Popup host rendering: [`ModulePanelPopupLayer.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/ModulePanelPopupLayer.tsx)

For the full metadata field reference, see [module-metadata-reference.md](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/docs/module-metadata-reference.md).
For toolbar runtime message details, see [panel-toolbar-protocol.md](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/docs/panel-toolbar-protocol.md).
For popup runtime message details, see [panel-popup-protocol.md](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/docs/panel-popup-protocol.md).
