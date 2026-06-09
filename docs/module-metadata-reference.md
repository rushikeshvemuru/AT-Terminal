# Module Metadata Reference

This document is the field-by-field reference for `AT-modules/{module}/metadata.json`.

The runtime loader lives in [`src-tauri/src/commands/modules.rs`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src-tauri/src/commands/modules.rs). Frontend runtime types live in [`src/lib/panelRegistry.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts).

Popup panels do not add any new metadata fields in v1. They are a runtime host protocol initiated by iframe-backed module panels. See [panel-popup-protocol.md](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/docs/panel-popup-protocol.md).

## File Location

Each module must define one of:

- `AT-modules/{module}/metadata.json`
- `AT-modules/{module}/meta-data.json`

`metadata.json` is the preferred name. The legacy `meta-data.json` name is still accepted for compatibility.

## Top-Level Schema

```json
{
  "module_name": "editor",
  "panel_types": ["workspace"],
  "panel_display_names": {
    "workspace": "Editor"
  },
  "panel_colors": {
    "workspace": "#22c55e"
  },
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
          "command": "save",
          "visible": true,
          "disabled": false
        }
      ]
    }
  },
  "startup_script_location": "scripts/start.sh",
  "startup_script_command": "bash scripts/start.sh",
  "panel_url_template": "http://127.0.0.1:48100/panels/{panel_type}",
  "healthcheck_url": "http://127.0.0.1:48100/health",
  "validation_urls": ["/panels/popup-demo", "/api/status"]
}
```

## Field Reference

### `module_name`

- Type: `string`
- Required: yes
- Purpose: namespace prefix for panel types and module registry identity

Example:

```json
{
  "module_name": "editor"
}
```

### `panel_types`

- Type: `string[]`
- Required: yes
- Purpose: local panel type names exposed by the module

Each value is local only. The host converts `workspace` into `editor.workspace` using `module_name`.

### `panel_display_names`

- Type: `Record<string, string>`
- Required: no
- Default: derived from the local panel type, for example `"workspace"` -> `"Workspace"`
- Purpose: overrides the UI display label for specific panel types without changing their runtime or persisted IDs

The record key must match a local panel type from `panel_types`. Empty or whitespace-only values are ignored and fall back to the derived display name.

Example:

```json
{
  "panel_display_names": {
    "workspace": "Editor",
    "preview": "Preview"
  }
}
```

### `panel_colors`

- Type: `Record<string, string>`
- Required: no
- Default: `"#ffffff"` for each panel type
- Purpose: defines the visual accent color for specific panel types

The record key must match a local panel type from `panel_types`. The host currently applies this color to the panel workspace border and the panel bar pill border, and exposes it in runtime panel metadata for future UI surfaces.

Example:

```json
{
  "panel_colors": {
    "workspace": "#22c55e",
    "preview": "hsl(199 89% 48%)"
  }
}
```

### `panel_tool_bar`

- Type: `Record<string, PanelToolbarDefinition>`
- Required: no
- Default: empty object
- Purpose: defines the contextual toolbar for specific iframe panel types

The record key must match a local panel type from `panel_types`.

Example:

```json
{
  "panel_tool_bar": {
    "workspace": {
      "items": [
        {
          "id": "save",
          "text": "Save",
          "command": "save"
        }
      ]
    }
  }
}
```

Toolbar definitions are surfaced to the frontend as `RuntimePanelToolbar` and `RuntimePanelToolbarItem`.

### `startup_script_location`

- Type: `string`
- Required: no
- Default: `""`
- Purpose: descriptive path to the startup entrypoint

This field is currently informational. The host executes `startup_script_command`.

### `startup_script_command`

- Type: `string`
- Required: no
- Default: `""`
- Purpose: shell command executed from the module directory at startup

If this is empty, the host does not spawn a module process.

Operational note:

- For iframe panels with toolbar icons, the host may validate declared `icon_path` asset URLs alongside `healthcheck_url` and `validation_urls`. If a process still answers healthchecks but no longer serves the current toolbar assets or validation routes from metadata, it may be treated as stale and restarted.

### `panel_url_template`

- Type: `string`
- Required: no
- Default: `""`
- Purpose: URL template used by iframe-backed module panels

Supported placeholders:

- `{panel_type}` for the local type
- `{namespaced_type}` for the fully qualified panel type

Example:

```json
{
  "panel_url_template": "http://127.0.0.1:48100/panels/{panel_type}"
}
```

### `healthcheck_url`

- Type: `string`
- Required: no
- Default: `""`
- Purpose: readiness probe used before the host loads the iframe

If it is empty, the host skips health polling and loads the iframe immediately.

### `validation_urls`

- Type: `string[]`
- Required: no
- Default: `[]`
- Purpose: additional HTTP routes or assets that must return `200` before the module is treated as healthy

Use this when a module serves important routes beyond its main `healthcheck_url`, for example popup pages, JSON APIs, or other assets that would otherwise let a stale server look healthy.

Resolution behavior:

- Absolute `http://` URLs are used unchanged
- Relative and root-relative paths are resolved against the module origin derived from `panel_url_template`, or `healthcheck_url` if needed
- Empty entries are ignored
- `https://` entries are ignored for the same reason external toolbar asset validation is ignored

Operational note:

- Validation URLs participate in the same startup stale-server detection as toolbar icon assets
- A module is considered healthy only when `healthcheck_url` and every resolved validation URL return `200`

## `panel_tool_bar` Schema

### Toolbar Definition

```json
{
  "items": [
    {
      "id": "save",
      "kind": "button",
      "text": "Save",
      "icon_path": "/assets/save.svg",
      "color": "#22c55e",
      "tooltip": "Save current file",
      "command": "save",
      "visible": true,
      "disabled": false,
      "value": "",
      "placeholder": "",
      "checked": false,
      "options": []
    }
  ]
}
```

Fields:

- `items`: ordered array of toolbar items

Ordering is preserved exactly as declared in metadata.

### Toolbar Item Fields

#### `id`

- Type: `string`
- Required: yes
- Meaning: stable runtime key for patches and click routing

Constraints:

- Must be unique within a single panel toolbar definition
- Empty IDs are ignored by the loader
- Duplicate IDs are ignored after the first occurrence

#### `kind`

- Type: `string`
- Required: no
- Default: `"button"`
- Meaning: widget renderer used by the host toolbar

Supported values:

- `button`
- `select`
- `text`
- `toggle`
- `number`
- `slider`
- `segmented`
- `menu`
- `buttonGroup`
- `status`
- `progress`
- `separator`
- `label`
- `spacer`

Unknown metadata kinds fall back to `button`.

#### `text`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: user-facing widget label

#### `icon_path`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: icon asset path or absolute URL

Resolution behavior:

- Absolute URLs are used unchanged
- Relative and root-relative paths are resolved against the module origin derived from `panel_url_template`
- The frontend helper for this is `resolvePanelToolbarIconUrl()`
- Same-origin SVG toolbar icons may be rendered by the host in a color-inheriting path so they can follow toolbar `color`
- Non-SVG assets, external URLs, fetch failures, and unsupported SVG cases fall back to normal image rendering
- Missing declared icon assets can also affect module readiness checks for iframe panels, because the host may validate them at startup to detect stale module servers

Tintable SVG recommendation:

- Author toolbar SVGs with `fill="currentColor"` and/or `stroke="currentColor"` if you want them to inherit host toolbar color
- Hardcoded SVG colors still render, but they will stay fixed instead of tinting with the toolbar

#### `color`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: accent color applied by the host

V1 uses this as a restrained accent, not full custom styling.

#### `tooltip`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: button tooltip shown by the host

#### `command`

- Type: `string`
- Required: no, but strongly recommended
- Default: `""`
- Meaning: action identifier sent back to the iframe when the item is clicked or changed

`command` is static for an effective item. Runtime patches cannot change it; use `at.panelToolbar.set` to replace runtime items.

#### `visible`

- Type: `boolean`
- Required: no
- Default: `true`
- Meaning: initial visibility state

If every effective item is hidden, the host hides the entire pill.

#### `disabled`

- Type: `boolean`
- Required: no
- Default: `false`
- Meaning: initial disabled state

The host also forces interactive items disabled until the iframe reports ready.

#### `value`

- Type: `string | number`
- Required: no
- Default: `""`
- Meaning: current value for `select`, `text`, `segmented`, `number`, and `slider` widgets

#### `placeholder`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: placeholder text for `select` and `text` widgets

#### `checked`

- Type: `boolean`
- Required: no
- Default: `false`
- Meaning: current state for `toggle` widgets

#### `min`, `max`, and `step`

- Type: `number`
- Required: no
- Default: `0` for `min`, `0` or widget-specific default for `max`, `1` for `step`
- Meaning: numeric bounds for `number` and `slider`

For sliders, omitted `max` defaults to `100`. For number inputs, `max` is ignored by the frontend unless it is greater than `min`.

#### `show_value`

- Type: `boolean`
- Required: no
- Default: `false`
- Meaning: shows the current numeric value for `slider` and percentage for `progress`

Runtime messages use `showValue`.

#### `tone`

- Type: `string`
- Required: no
- Default: `""`
- Meaning: restrained status color for `status` and `progress`

Supported tones are `success`, `warning`, `danger`, `error`, `info`, and `muted`.

#### `progress`

- Type: `number`
- Required: no
- Default: `0`
- Meaning: determinate progress percentage for `progress` widgets

Values are clamped from `0` to `100`.

#### `indeterminate`

- Type: `boolean`
- Required: no
- Default: `false`
- Meaning: renders `progress` as a spinner/status indicator instead of a determinate bar

#### `options`

- Type: `{ value: string, label?: string, disabled?: boolean }[]`
- Required: no
- Default: `[]`
- Meaning: option list for `select` and `segmented` widgets

Empty option values are ignored. If `label` is empty, the host uses `value`.

#### `items`

- Type: `{ id: string, text?: string, icon_path?: string, tooltip?: string, command?: string, visible?: boolean, disabled?: boolean }[]`
- Required: no
- Default: `[]`
- Meaning: child actions for `menu` and `buttonGroup`

Child action IDs must be unique within their parent item. Runtime messages use `iconPath`.

Example select widget:

```json
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
}
```

Example numeric, grouped, and display widgets:

```json
[
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
    "show_value": true,
    "command": "zoom:change"
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
    "show_value": true,
    "tone": "info"
  }
]
```

## Runtime Rules

- Toolbar support is v1 iframe-only. Native React panels do not use `panel_tool_bar`.
- Runtime patches may change `text`, `iconPath`, `color`, `tooltip`, `visible`, `disabled`, `value`, `placeholder`, `checked`, `min`, `max`, `step`, `showValue`, `tone`, `progress`, `indeterminate`, `options`, and `items` for existing effective items.
- Runtime patches may not add new items, remove items, reorder items, or change `kind`/`command`.
- Runtime `at.panelToolbar.set` messages may add, remove, update, and reorder effective toolbar widgets for a panel.
- Runtime toolbar state is not persisted in session JSON.
- Reloads and reconnects reset runtime state back to metadata defaults.

## Compatibility Notes

- Keep `#[serde(default)]` behavior in mind when extending metadata. Optional fields should always tolerate older module files.
- The host does not assume one port per module. Use whatever origin your module needs, as long as the URLs in metadata are correct.
- If a module declares a toolbar for a local panel type that is never rendered in an iframe, the metadata is harmless but unused.

## Related Types In Code

The most relevant frontend exports are:

- [`RuntimePanelToolbar`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts)
- [`RuntimePanelToolbarItem`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts)
- [`PanelToolbarItemPatch`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts)
- [`resolvePanelToolbarIconUrl()`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts)

For message flow details, see [panel-toolbar-protocol.md](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/docs/panel-toolbar-protocol.md).
