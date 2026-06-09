(function () {
  const ACTIONS = Object.freeze({
    start: Object.freeze({
      key: "start",
      itemId: "tmux",
      command: "tmux",
      toolbarText: "TMUX",
      tooltip: "Start tmux in this terminal",
    }),
    manager: Object.freeze({
      key: "manager",
      itemId: "tmux-manager",
      command: "tmux:manager",
      toolbarText: "Manage",
      tooltip: "Open tmux manager",
    }),
    newWindow: Object.freeze({
      key: "newWindow",
      itemId: "tmux-new-window",
      command: "tmux:new-window",
      toolbarText: "New",
      selectionLabel: "New Window",
      menuLabel: "New window",
      tooltip: "Create a new tmux window",
      iconPath: "/assets/tmux-window-new.svg",
    }),
    prevWindow: Object.freeze({
      key: "prevWindow",
      itemId: "tmux-prev-window",
      command: "tmux:prev-window",
      toolbarText: "Prev",
      selectionLabel: "Prev",
      menuLabel: "Previous window",
      tooltip: "Go to the previous tmux window",
      iconPath: "/assets/tmux-window-prev.svg",
    }),
    nextWindow: Object.freeze({
      key: "nextWindow",
      itemId: "tmux-next-window",
      command: "tmux:next-window",
      toolbarText: "Next",
      selectionLabel: "Next",
      menuLabel: "Next window",
      tooltip: "Go to the next tmux window",
      iconPath: "/assets/tmux-window-next.svg",
    }),
    splitVertical: Object.freeze({
      key: "splitVertical",
      itemId: "tmux-split-vertical",
      command: "tmux:split-vertical",
      toolbarText: "",
      selectionLabel: "Split V",
      menuLabel: "Split vertical",
      tooltip: "Split the current tmux pane vertically",
      iconPath: "/assets/tmux-split-vertical.svg",
    }),
    splitHorizontal: Object.freeze({
      key: "splitHorizontal",
      itemId: "tmux-split-horizontal",
      command: "tmux:split-horizontal",
      toolbarText: "",
      selectionLabel: "Split H",
      menuLabel: "Split horizontal",
      tooltip: "Split the current tmux pane horizontally",
      iconPath: "/assets/tmux-split-horizontal.svg",
    }),
    pinPanel: Object.freeze({
      key: "pinPanel",
      itemId: "tmux-pin-panel",
      command: "tmux:pin-panel",
      toolbarText: "",
      selectionLabel: "Pin",
      menuLabel: "Pin to panel",
      tooltip: "Pin tmux manager to this panel",
      iconPath: "/assets/tmux-pin-panel.svg",
    }),
    mouseOn: Object.freeze({
      key: "mouseOn",
      itemId: "tmux-mouse-on",
      command: "tmux:mouse-on",
      toolbarText: "",
      selectionLabel: "Mouse",
      menuLabel: "Enable mouse",
      tooltip: "Enable tmux mouse mode",
      iconPath: "/assets/tmux-mouse-on.svg",
    }),
  });

  const AUX_ACTION_KEYS = Object.freeze([
    "newWindow",
    "prevWindow",
    "nextWindow",
    "splitVertical",
    "splitHorizontal",
    "pinPanel",
    "mouseOn",
  ]);

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
  }

  function buildNewWindowCommand(options = {}) {
    const target = String(options.target || "").trim();
    const name = String(options.name || "").trim();
    const cwd = String(options.cwd || "").trim();
    const parts = ["new-window"];

    if (target) {
      parts.push(`-t ${shellQuote(target)}`);
    }
    if (name) {
      parts.push(`-n ${shellQuote(name)}`);
    }
    if (cwd) {
      parts.push(`-c ${shellQuote(cwd)}`);
    }

    return parts.join(" ");
  }

  function buildSplitWindowCommand(flag, options = {}) {
    const target = String(options.target || "").trim();
    const cwd = String(options.cwd || "").trim();
    const parts = ["split-window", flag];

    if (target) {
      parts.push(`-t ${shellQuote(target)}`);
    }
    if (cwd) {
      parts.push(`-c ${shellQuote(cwd)}`);
    }

    return parts.join(" ");
  }

  function buildSplitVerticalCommand(options = {}) {
    return buildSplitWindowCommand("-v", options);
  }

  function buildSplitHorizontalCommand(options = {}) {
    return buildSplitWindowCommand("-h", options);
  }

  function toolbarItemsForMode(mode, options = {}) {
    const busy = Boolean(options.busy);
    const defaultTooltip = options.defaultTooltip || ACTIONS.start.tooltip;
    const activeColor = options.activeColor || "#22c55e";
    const errorColor = options.errorColor || "#ef4444";
    const pinChecked = Boolean(options.pinChecked);
    const mouseChecked = Boolean(options.mouseChecked);

    const auxItem = (action, visible, disabled) => ({
      id: action.itemId,
      visible,
      disabled,
      ...(action.key === "pinPanel"
        ? {
            checked: pinChecked,
            color: pinChecked ? activeColor : "",
            tooltip: pinChecked ? "Unpin tmux manager from this panel" : action.tooltip,
          }
        : {}),
      ...(action.key === "mouseOn"
        ? {
            checked: mouseChecked,
            color: mouseChecked ? activeColor : "",
            tooltip: mouseChecked ? "Disable tmux mouse mode" : action.tooltip,
          }
        : {}),
    });

    switch (mode) {
      case "idle":
        return [
          {
            id: ACTIONS.start.itemId,
            color: "",
            tooltip: options.tooltip || defaultTooltip,
            disabled: false,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: false,
            disabled: true,
          },
          ...AUX_ACTION_KEYS.map((key) => auxItem(ACTIONS[key], false, true)),
        ];
      case "starting":
        return [
          {
            id: ACTIONS.start.itemId,
            color: "",
            tooltip: "Starting tmux...",
            disabled: true,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: false,
            disabled: true,
          },
          ...AUX_ACTION_KEYS.map((key) => auxItem(ACTIONS[key], false, true)),
        ];
      case "active":
        return [
          {
            id: ACTIONS.start.itemId,
            color: activeColor,
            tooltip: "tmux is active",
            disabled: true,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: true,
            disabled: busy,
            tooltip: ACTIONS.manager.tooltip,
          },
          ...AUX_ACTION_KEYS.map((key) => auxItem(ACTIONS[key], true, busy)),
        ];
      case "server":
        return [
          {
            id: ACTIONS.start.itemId,
            color: "",
            tooltip: options.tooltip || "Attach tmux in this terminal",
            disabled: false,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: true,
            disabled: busy,
            tooltip: ACTIONS.manager.tooltip,
          },
          ...AUX_ACTION_KEYS.map((key) =>
            auxItem(ACTIONS[key], key === "pinPanel" || key === "mouseOn", busy),
          ),
        ];
      case "unavailable":
        return [
          {
            id: ACTIONS.start.itemId,
            color: errorColor,
            tooltip: "tmux is not installed",
            disabled: true,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: false,
            disabled: true,
          },
          ...AUX_ACTION_KEYS.map((key) => auxItem(ACTIONS[key], false, true)),
        ];
      case "disconnected":
      default:
        return [
          {
            id: ACTIONS.start.itemId,
            color: "",
            tooltip: "terminal connection is unavailable",
            disabled: true,
          },
          {
            id: ACTIONS.manager.itemId,
            visible: false,
            disabled: true,
          },
          ...AUX_ACTION_KEYS.map((key) => auxItem(ACTIONS[key], false, true)),
        ];
    }
  }

  function getActionByCommand(command) {
    return Object.values(ACTIONS).find((action) => action.command === command) || null;
  }

  function toolbarCommandToTmuxSubcommand(command) {
    switch (command) {
      case ACTIONS.newWindow.command:
        return "new-window";
      case ACTIONS.prevWindow.command:
        return "previous-window";
      case ACTIONS.nextWindow.command:
        return "next-window";
      case ACTIONS.splitVertical.command:
        return buildSplitVerticalCommand();
      case ACTIONS.splitHorizontal.command:
        return buildSplitHorizontalCommand();
      case ACTIONS.mouseOn.command:
        return "set-option -g mouse on";
      case "tmux:mouse-off":
        return "set-option -g mouse off";
      default:
        return null;
    }
  }

  function getManagerAction(key) {
    return ACTIONS[key] || null;
  }

  window.__AT_TMUX_ACTIONS__ = Object.freeze({
    ACTIONS,
    AUX_ACTION_KEYS,
    AUX_TOOLBAR_ITEM_IDS: Object.freeze(AUX_ACTION_KEYS.map((key) => ACTIONS[key].itemId)),
    ITEM_IDS: Object.freeze(
      Object.fromEntries(Object.entries(ACTIONS).map(([key, action]) => [key, action.itemId])),
    ),
    COMMANDS: Object.freeze(
      Object.fromEntries(Object.entries(ACTIONS).map(([key, action]) => [key, action.command])),
    ),
    shellQuote,
    buildNewWindowCommand,
    buildSplitVerticalCommand,
    buildSplitHorizontalCommand,
    toolbarItemsForMode,
    toolbarCommandToTmuxSubcommand,
    getActionByCommand,
    getManagerAction,
  });
})();
