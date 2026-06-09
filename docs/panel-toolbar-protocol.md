# Panel Toolbar Protocol

This document defines the runtime contract between an iframe-backed module panel and the AT-Terminal host for the contextual panel toolbar.

The implementation lives in:

- [`src/components/panels/ModulePanelHost.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/panels/ModulePanelHost.tsx)
- [`src/components/Toolbar.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/Toolbar.tsx)
- [`src/store/usePanelToolbarStore.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/store/usePanelToolbarStore.ts)

Shared frontend message shapes are exported from [`src/lib/panelRegistry.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts):

- `PanelToolbarClickMessage`
- `PanelToolbarChangeMessage`
- `PanelToolbarPatchMessage`
- `PanelToolbarSetMessage`
- `PanelToolbarItemPatch`

## Scope

This protocol applies only to iframe-backed module panels. Metadata toolbars are optional when a module creates its toolbar at runtime.

Metadata owns the startup defaults. A running module may replace the effective toolbar for its panel with `at.panelToolbar.set`.

The module owns:

- handling toolbar clicks and value changes
- adding, removing, updating, and reordering runtime widgets with `at.panelToolbar.set`
- patching existing widget fields with `at.panelToolbar.patch`

## Lifecycle

### Initial load

1. The host reads toolbar metadata from `panel_tool_bar`.
2. The top toolbar renders metadata defaults for the active panel, if any exist.
3. The host keeps every interactive item disabled until the iframe finishes loading.
4. Once the iframe is ready, the host enables items according to effective state.
5. The iframe may send `at.panelToolbar.set` to replace the effective runtime toolbar.

### During runtime

- Clicking a button sends `at.panelToolbar.click` from host to iframe.
- Changing a select, text field, or toggle sends `at.panelToolbar.change` from host to iframe.
- The module may respond with `at.panelToolbar.set` or `at.panelToolbar.patch`.
- Runtime toolbar state is stored per panel instance.
- Patches are stored per panel instance, not per module or per panel type.

### Reloads and reconnects

- If the iframe reloads, errors, or reconnects, runtime toolbar items and patches are discarded.
- The host returns to metadata defaults.
- The module must re-send any desired runtime toolbar state.

## Widget Schema

Every toolbar widget includes:

- `id`: non-empty stable item ID
- `kind`: `button`, `select`, `text`, `toggle`, `number`, `slider`, `segmented`, `menu`, `buttonGroup`, `status`, `progress`, `separator`, `label`, or `spacer`; omitted metadata defaults to `button`
- `text`, `iconPath`, `color`, `tooltip`, `command`, `visible`, and `disabled`

Kind-specific fields:

- `select`: `value`, `placeholder`, `options: [{ value, label, disabled }]`
- `text`: `value`, `placeholder`
- `toggle`: `checked`
- `number`: numeric `value`, `min`, `max`, `step`, `placeholder`
- `slider`: numeric `value`, `min`, `max`, `step`, `showValue`
- `segmented`: string `value`, `options: [{ value, label, disabled }]`
- `menu`: `items: [{ id, text, iconPath, tooltip, command, visible, disabled }]`
- `buttonGroup`: `items: [{ id, text, iconPath, tooltip, command, visible, disabled }]`
- `status`: `text`, `tone`
- `progress`: `progress`, `indeterminate`, `showValue`, `tone`, optional `text`
- `label`: `text`
- `separator` and `spacer`: no interactive value

Metadata uses `icon_path`; runtime messages use `iconPath`.
For `menu` and `buttonGroup` child actions, metadata uses `icon_path`; runtime messages use `iconPath`.

### Persistence

- Toolbar runtime state is not written into session JSON.
- Restoring a session restores static metadata only.

## Host To Iframe Message

Type: `at.panelToolbar.click`

```json
{
  "type": "at.panelToolbar.click",
  "panelId": "panel-123",
  "itemId": "save",
  "command": "save"
}
```

Fields:

- `type`: fixed message discriminator
- `panelId`: current panel instance ID
- `itemId`: effective toolbar item ID
- `command`: immutable command string from the effective item
- `parentItemId`: optional parent item ID for `menu` and `buttonGroup` child actions

Child action example:

```json
{
  "type": "at.panelToolbar.click",
  "panelId": "panel-123",
  "itemId": "format",
  "command": "format",
  "parentItemId": "actions"
}
```

Notes:

- The host does not add optimistic loading behavior after click.
- The module should patch disabled or text state itself if it wants click feedback.

## Host To Iframe Value Message

Type: `at.panelToolbar.change`

```json
{
  "type": "at.panelToolbar.change",
  "panelId": "panel-123",
  "itemId": "mode",
  "command": "mode:change",
  "value": "review"
}
```

Fields:

- `value`: string for `select`, `text`, and `segmented`; boolean for `toggle`; number for `number` and `slider`

## Iframe To Host Set Message

Type: `at.panelToolbar.set`

```json
{
  "type": "at.panelToolbar.set",
  "panelId": "panel-123",
  "items": [
    {
      "id": "mode",
      "kind": "select",
      "text": "Mode",
      "command": "mode:change",
      "value": "edit",
      "options": [
        { "value": "edit", "label": "Edit" },
        { "value": "review", "label": "Review" }
      ]
    },
    {
      "id": "query",
      "kind": "text",
      "placeholder": "Filter",
      "command": "query:change"
    },
    {
      "id": "timeout",
      "kind": "number",
      "text": "Timeout",
      "value": 30,
      "min": 0,
      "step": 5,
      "command": "timeout:change"
    },
    {
      "id": "zoom",
      "kind": "slider",
      "text": "Zoom",
      "value": 100,
      "min": 50,
      "max": 200,
      "step": 10,
      "showValue": true,
      "command": "zoom:change"
    },
    {
      "id": "view",
      "kind": "segmented",
      "value": "logs",
      "command": "view:change",
      "options": [
        { "value": "view", "label": "View" },
        { "value": "diff", "label": "Diff" },
        { "value": "logs", "label": "Logs" }
      ]
    },
    {
      "id": "actions",
      "kind": "menu",
      "text": "Actions",
      "items": [
        { "id": "format", "text": "Format", "command": "format" },
        { "id": "restart", "text": "Restart", "command": "restart" }
      ]
    },
    {
      "id": "nav",
      "kind": "buttonGroup",
      "items": [
        { "id": "prev", "text": "Prev", "command": "nav:prev" },
        { "id": "next", "text": "Next", "command": "nav:next" }
      ]
    },
    {
      "id": "state",
      "kind": "status",
      "text": "Connected",
      "tone": "success"
    },
    {
      "id": "indexing",
      "kind": "progress",
      "text": "Indexing",
      "progress": 42,
      "showValue": true,
      "tone": "info"
    },
    {
      "id": "run",
      "kind": "button",
      "text": "Run",
      "command": "run"
    }
  ]
}
```

Rules:

- `items` replaces the effective runtime toolbar for that panel.
- Sending an empty `items` array removes the effective runtime toolbar.
- Items with empty IDs, duplicate IDs, or unsupported kinds are ignored.
- Runtime items are not persisted.

## Iframe To Host Patch Message

Type: `at.panelToolbar.patch`

```json
{
  "type": "at.panelToolbar.patch",
  "panelId": "panel-123",
  "items": [
    {
      "id": "save",
      "disabled": true,
      "text": "Saving..."
    }
  ]
}
```

Fields:

- `type`: fixed message discriminator
- `panelId`: panel instance ID that owns the toolbar
- `items`: array of item patches

## Patch Schema

Each patch item must include `id` and may include any of:

- `text`
- `iconPath`
- `color`
- `tooltip`
- `visible`
- `disabled`
- `value`
- `placeholder`
- `checked`
- `options`
- `min`
- `max`
- `step`
- `showValue`
- `tone`
- `progress`
- `indeterminate`
- `items`

Example:

```json
{
  "id": "run",
  "color": "#38bdf8",
  "tooltip": "Running current file",
  "disabled": true,
  "progress": 70
}
```

## Patch Rules

- Only existing effective item IDs are accepted.
- Unknown item IDs are ignored with a console warning.
- Patches cannot change `kind` or `command`.
- Patches cannot add, remove, or reorder items. Use `at.panelToolbar.set` for structural changes.
- Inactive panels may still send patches. The host stores them and uses them when that panel becomes active again.

## Visibility Rules

- The host hides the entire pill if there are no visible effective items.
- `visible: false` hides an item but does not delete it.
- If every item is hidden, nothing is rendered for the panel toolbar.

## Readiness Rules

- Metadata defaults can render before the iframe is ready.
- The host forces every interactive item disabled until the iframe load completes.
- After readiness, each item uses its effective `disabled` state from metadata plus patches.

## Module Implementation Example

```html
<script>
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId");

  function patch(items) {
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
    { id: "mode", kind: "select", command: "mode", value: "edit", options: [
      { value: "edit", label: "Edit" },
      { value: "review", label: "Review" }
    ] },
    { id: "filter", kind: "text", placeholder: "Filter", command: "filter" },
    { id: "watch", kind: "toggle", text: "Watch", command: "watch", checked: false },
    { id: "divider", kind: "separator" },
    { id: "save", kind: "button", text: "Save", command: "save" }
  ]);

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.panelId !== panelId) return;

    if (message.type === "at.panelToolbar.click" && message.command === "save") {
      patch([{ id: "save", disabled: true, text: "Saving..." }]);
      await saveDocument();
      patch([{ id: "save", disabled: false, text: "Save" }]);
    }

    if (message.type === "at.panelToolbar.change" && message.command === "filter") {
      patch([{ id: "filter", value: message.value }]);
    }
  });
<\/script>
```

## Troubleshooting

### The toolbar never appears

Check:

- the active panel is iframe-backed, not a native React panel
- `metadata.json` includes `panel_tool_bar` for that local panel type, or the iframe sends `at.panelToolbar.set`
- at least one effective item is visible
- the module registry loaded successfully at app startup

### The toolbar appears but controls stay disabled

Check:

- the iframe actually loaded and did not stay in a healthcheck retry loop
- the panel is the active panel in the active tab
- the item is not explicitly disabled by metadata or a runtime patch

### A patch is ignored

Check:

- the patch includes a non-empty `id`
- the `id` exactly matches an effective metadata or runtime item
- the patched field is one of the allowed runtime fields

### Icons do not load

Check:

- the module server is serving the asset path
- `icon_path` is correct in metadata
- relative paths are valid when resolved against the module origin from `panel_url_template`
- if you expect SVG tinting, the host must be able to fetch the same-origin SVG asset successfully
- if the icon is meant to inherit toolbar color, author it with `fill="currentColor"` and/or `stroke="currentColor"`

Notes:

- Same-origin SVG toolbar icons may be rendered by the host in a color-inheriting path so they can inherit toolbar color.
- If inline SVG fetch/render is unavailable or unsupported, the toolbar falls back to normal image rendering.
- During module startup, declared toolbar icon assets may also be used as validation URLs so the host can detect stale module servers that still answer `/health` but no longer serve the current toolbar routes.

### State resets unexpectedly

Expected cases:

- iframe reload
- iframe error
- session restore
- module reconnect

When that happens, re-send the desired runtime toolbar state from the module.
