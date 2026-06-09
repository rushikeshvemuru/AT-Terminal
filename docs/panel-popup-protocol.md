# Panel Popup Protocol

This document defines the runtime contract between an iframe-backed module panel and the AT-Terminal host for module-triggered popup panels.

The implementation lives in:

- [`src/components/panels/ModulePanelHost.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/panels/ModulePanelHost.tsx)
- [`src/components/ModulePanelPopupLayer.tsx`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/components/ModulePanelPopupLayer.tsx)
- [`src/store/usePanelPopupStore.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/store/usePanelPopupStore.ts)

Shared frontend message shapes are exported from [`src/lib/panelRegistry.ts`](/home/rushikesh-vemuru/Main/Projects/AT-Terminal/src/lib/panelRegistry.ts):

- `PanelPopupOpenMessage`
- `PanelPopupCloseMessage`

## Scope

This protocol applies only to iframe-backed module panels.

The host owns:

- rendering the popup shell
- title bar chrome and close behavior
- one active popup per source panel
- popup lifetime across route replacements

The module owns:

- deciding when to open or close a popup
- serving the popup route from the same module origin
- rendering popup iframe content

## Lifecycle

### Open

1. A source module panel sends `at.panelPopup.open`.
2. The host resolves the requested route against the module's own origin.
3. If the route crosses origins or is invalid, the request is ignored.
4. The host opens a modal popup and loads the iframe route.

### Replace

- A second `at.panelPopup.open` from the same source panel replaces the existing popup for that panel.
- A popup opened from a different source panel is tracked independently.

### Close

- The module may close its popup with `at.panelPopup.close`.
- The host also closes the popup when the user clicks the close button, presses Escape, clicks the backdrop, the source panel unmounts, or the active session changes.

### Persistence

- Popup state is not written into session JSON.
- Restoring a session does not restore popups.

## Source Panel To Host Message

Type: `at.panelPopup.open`

```json
{
  "type": "at.panelPopup.open",
  "panelId": "panel-123",
  "route": "/panels/popup-demo",
  "title": "Base Module Popup",
  "width": 680,
  "height": 440
}
```

Fields:

- `type`: fixed message discriminator
- `panelId`: source panel instance ID
- `route`: popup route served by the same module origin
- `title`: optional popup title shown in host chrome
- `width`: optional desired popup width in CSS pixels
- `height`: optional desired popup height in CSS pixels

Rules:

- `route` is required.
- The host resolves the route against the module panel's resolved URL template.
- The resolved popup URL must stay on the same origin as the module panel.
- Width and height are clamped by the host.

## Popup Iframe Query Params

The host does not forward normal panel context such as `panelId` or `rootDirectory`.

The popup iframe receives only popup-specific query params appended by the host:

- `atPopup=1`
- `popupId=<generated-popup-id>`

If popup content needs more context, the source panel should encode it into the popup route itself or the popup can fetch it from the module backend.

## Popup Iframe To Host Message

Type: `at.panelPopup.close`

```json
{
  "type": "at.panelPopup.close",
  "popupId": "panel-123-popup-abc"
}
```

Fields:

- `type`: fixed message discriminator
- `popupId`: popup instance ID from the popup iframe query params

## Example

Source panel:

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

Popup iframe:

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

## Troubleshooting

### The popup does not open

Check:

- the request came from an iframe-backed module panel
- `panelId` matches the source panel instance
- `route` is not empty
- the route resolves to the same module origin

### The popup opens but shows the wrong page

Check:

- the module server is actually serving the requested route
- the route is correct relative to the module panel URL template
- query parameters encoded into the route are correct

### The popup cannot close itself

Check:

- the popup iframe reads `popupId` from `window.location.search`
- `at.panelPopup.close` includes that `popupId`
- the message is sent from the popup iframe itself, not another window
