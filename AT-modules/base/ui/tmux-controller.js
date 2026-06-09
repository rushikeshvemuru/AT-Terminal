(function () {
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId") || `panel-${Date.now()}`;
  const atToken = params.get("atToken") || "";
  const tmuxActions = window.__AT_TMUX_ACTIONS__;
  const TMUX_DEFAULT_TOOLTIP = "Start tmux in this terminal";
  const TMUX_ACTIVE_COLOR = "#22c55e";
  const TMUX_ERROR_COLOR = "#ef4444";
  const TMUX_CONFIRM_ATTEMPTS = 40;
  const TMUX_CONFIRM_DELAY_MS = 500;
  const TMUX_STATUS_POLL_MS = 2500;

  if (!tmuxActions) {
    console.error("[base-terminal] tmux actions asset is unavailable");
    return;
  }

  let runtime = window.__AT_TERMINAL_RUNTIME__ || null;
  let mode = "idle";
  let actionBusy = false;
  let lastPersistedTmuxMode = null;
  let pinnedToPanel = false;
  let tmuxMouseMode = false;
  let statusPollTimer = null;
  let startSequence = 0;
  let lastTargetSocketPath = "";

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

  function patchPanelState(nextPanelState) {
    window.parent.postMessage(
      {
        type: "at.panelState.patch",
        panelId,
        panelState: nextPanelState,
      },
      "*",
    );
  }

  function pinTmuxManagerToPanel() {
    pinnedToPanel = true;
    patchPanelState({
      tmuxManagerPinned: true,
      tmuxManagerCollapsed: false,
    });
  }

  function unpinTmuxManagerFromPanel() {
    pinnedToPanel = false;
    patchPanelState({
      tmuxManagerPinned: false,
      tmuxManagerCollapsed: false,
    });
  }

  function persistTmuxMode(active) {
    if (lastPersistedTmuxMode === active) {
      return;
    }

    lastPersistedTmuxMode = active;
    patchPanelState({ tmuxMode: active });
  }

  function setToolbarMode(nextMode, options = {}) {
    mode = nextMode;
    patchToolbar(
      tmuxActions.toolbarItemsForMode(nextMode, {
        busy: options.busy,
        tooltip: options.tooltip,
        pinChecked: options.pinChecked ?? pinnedToPanel,
        mouseChecked: options.mouseChecked ?? tmuxMouseMode,
        defaultTooltip: TMUX_DEFAULT_TOOLTIP,
        activeColor: TMUX_ACTIVE_COLOR,
        errorColor: TMUX_ERROR_COLOR,
      }),
    );
    if (nextMode === "active") {
      persistTmuxMode(true);
      return;
    }

    if (nextMode !== "starting") {
      persistTmuxMode(false);
    }
  }

  function isRuntimeReady() {
    return !!runtime && runtime.isSocketOpen();
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function fetchTmuxState() {
    const response = await fetch(buildApiUrl("/api/tmux/state", { panelId, t: Date.now() }), {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`tmux state request failed with status ${response.status}`);
    }
    return response.json();
  }

  function buildApiUrl(path, values = {}) {
    const url = new URL(path, window.location.href);
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value).length > 0) {
        url.searchParams.set(key, String(value));
      }
    });
    if (atToken) {
      url.searchParams.set("atToken", atToken);
    }
    return url.toString();
  }

  function applyBackendState(payload, reason) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    lastTargetSocketPath =
      typeof payload.targetSocketPath === "string" ? payload.targetSocketPath : "";
    tmuxMouseMode = payload.mouseMode === true;

    if (payload.panelConnected === false) {
      if (reason === "connect" && isRuntimeReady()) {
        return;
      }
      setToolbarMode("disconnected");
      return;
    }

    if (payload.available === false) {
      setToolbarMode("unavailable");
      return;
    }

    if (payload.tmuxActive) {
      setToolbarMode("active", { busy: actionBusy });
      return;
    }

    if (Array.isArray(payload.sessions) && payload.sessions.length > 0) {
      setToolbarMode("server", { busy: actionBusy });
      return;
    }

    setToolbarMode("idle");
  }

  async function syncTmuxState(reason) {
    try {
      const payload = await fetchTmuxState();
      applyBackendState(payload, reason);
      return payload;
    } catch (error) {
      console.warn("[base-terminal] tmux state sync failed:", error);
      if (!isRuntimeReady()) {
        setToolbarMode("disconnected");
      }
      return null;
    }
  }

  async function waitForTmuxActivation(sequence) {
    for (let attempt = 0; attempt < TMUX_CONFIRM_ATTEMPTS; attempt += 1) {
      if (sequence !== startSequence) {
        return false;
      }

      const payload = await syncTmuxState("start-confirm");
      if (payload && payload.tmuxActive) {
        return true;
      }
      await sleep(TMUX_CONFIRM_DELAY_MS);
    }

    return false;
  }

  async function startTmux() {
    if (actionBusy || mode === "starting" || mode === "active") {
      return;
    }

    if (!isRuntimeReady()) {
      setToolbarMode("disconnected");
      return;
    }

    actionBusy = true;
    const sequence = startSequence + 1;
    startSequence = sequence;
    try {
      const before = await syncTmuxState("start-probe");
      if (before && before.tmuxActive) {
        return;
      }
      if (before && before.available === false) {
        setToolbarMode("unavailable");
        return;
      }

      setToolbarMode("starting");
      runtime.sendCommand(before?.startCommand || "tmux");

      const activated = await waitForTmuxActivation(sequence);
      if (!activated && sequence === startSequence) {
        runtime.writeLine("\r\n\x1b[33m[tmux did not attach to this terminal]\x1b[0m");
        await syncTmuxState("start-timeout");
      }
    } catch (error) {
      console.error("[base-terminal] tmux launch failed:", error);
      runtime.writeLine("\r\n\x1b[31m[tmux could not start]\x1b[0m");
      await syncTmuxState("start-error");
    } finally {
      actionBusy = false;
      await syncTmuxState("start-final");
    }
  }

  function sendTmuxCommand(command) {
    if (!isRuntimeReady()) {
      return;
    }
    runtime.sendCommand(`tmux ${command}`);
  }

  async function executeTmuxCommand(command, socketPath) {
    const response = await fetch(buildApiUrl("/api/tmux/command"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        panelId,
        command,
        socketPath: socketPath || undefined,
      }),
    });
    const responseText = await response.text();
    let data = null;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = null;
    }

    if (!response.ok || !data || data.error) {
      throw new Error(
        (data && data.error) ||
          (response.status === 404
            ? "The base module server needs a restart to serve tmux commands."
            : "tmux command failed"),
      );
    }

    return data;
  }

  async function runToolbarTmuxCommand(command) {
    await executeTmuxCommand(command, lastTargetSocketPath);
    await syncTmuxState("action");
  }

  function openTmuxManagerPopup() {
    if (mode !== "active" && mode !== "server") {
      return;
    }

    const route = `/panels/tmux-manager?panelId=${encodeURIComponent(panelId)}`;
    window.parent.postMessage(
      {
        type: "at.panelPopup.open",
        panelId,
        route,
        title: "Tmux Manager",
        width: 1180,
        height: 780,
      },
      "*",
    );
  }

  async function handleTmuxAuxClick(command) {
    if (command === tmuxActions.COMMANDS.pinPanel) {
      if (pinnedToPanel) {
        unpinTmuxManagerFromPanel();
      } else {
        pinTmuxManagerToPanel();
      }
      setToolbarMode(mode, { busy: actionBusy });
      return;
    }

    if (command === tmuxActions.COMMANDS.mouseOn) {
      const tmuxCommand = tmuxMouseMode
        ? "set-option -g mouse off"
        : tmuxActions.toolbarCommandToTmuxSubcommand(command);
      if (!tmuxCommand) {
        return;
      }
      await runToolbarTmuxCommand(tmuxCommand);
      return;
    }

    const tmuxCommand = tmuxActions.toolbarCommandToTmuxSubcommand(command);
    if (!tmuxCommand) {
      return;
    }
    await runToolbarTmuxCommand(tmuxCommand);
  }

  async function handleTmuxToggleChange(command, value) {
    if (command === tmuxActions.COMMANDS.pinPanel) {
      if (value === true) {
        pinTmuxManagerToPanel();
      } else {
        unpinTmuxManagerFromPanel();
      }
      setToolbarMode(mode, { busy: actionBusy });
      return;
    }

    if (command === tmuxActions.COMMANDS.mouseOn) {
      await runToolbarTmuxCommand(
        value === true ? "set-option -g mouse on" : "set-option -g mouse off",
      );
    }
  }

  function startStatusPolling() {
    stopStatusPolling();
    statusPollTimer = window.setInterval(() => {
      void syncTmuxState("poll");
    }, TMUX_STATUS_POLL_MS);
  }

  function stopStatusPolling() {
    if (statusPollTimer !== null) {
      window.clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  }

  function handleRuntimeReady(nextRuntime) {
    runtime = nextRuntime;
    if (isRuntimeReady()) {
      void syncTmuxState("connect");
      startStatusPolling();
    }
  }

  window.addEventListener("at-terminal:runtime-ready", (event) => {
    handleRuntimeReady(event.detail);
  });

  window.addEventListener("at-terminal:socket-open", (event) => {
    handleRuntimeReady(event.detail);
    window.setTimeout(() => {
      void syncTmuxState("connect");
    }, 150);
  });

  window.addEventListener("at-terminal:socket-close", () => {
    stopStatusPolling();
    setToolbarMode("disconnected");
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "at.panelToolbar.click") {
      if (message.panelId !== panelId) return;
      if (message.command === tmuxActions.COMMANDS.start) {
        void startTmux();
        return;
      }
      if (message.command === tmuxActions.COMMANDS.manager) {
        openTmuxManagerPopup();
        return;
      }
      void handleTmuxAuxClick(message.command).catch((error) => {
        console.error("[base-terminal] tmux toolbar action failed:", error);
        runtime?.writeLine?.(`\r\n\x1b[31m[${error.message || String(error)}]\x1b[0m`);
        void syncTmuxState("action-error");
      });
      return;
    }

    if (message.type === "at.panelToolbar.change") {
      if (message.panelId !== panelId) return;
      void handleTmuxToggleChange(message.command, message.value).catch((error) => {
        console.error("[base-terminal] tmux toolbar toggle failed:", error);
        runtime?.writeLine?.(`\r\n\x1b[31m[${error.message || String(error)}]\x1b[0m`);
        void syncTmuxState("action-error");
      });
      return;
    }

    if (message.type === "at.tmuxCommand" && message.panelId === panelId) {
      if (!isRuntimeReady()) return;
      const command = message.command;
      if (!command) return;
      sendTmuxCommand(command);
      window.setTimeout(() => {
        void syncTmuxState("command");
      }, 300);
      return;
    }

    if (message.type === "at.panelState.sync") {
      if (message.panelId !== panelId) return;
      const nextPanelState =
        message.panelState && typeof message.panelState === "object" ? message.panelState : {};
      if (typeof nextPanelState.tmuxMode === "boolean") {
        lastPersistedTmuxMode = nextPanelState.tmuxMode;
      }
      pinnedToPanel = nextPanelState.tmuxManagerPinned === true;
      setToolbarMode(mode, { busy: actionBusy });
      if (nextPanelState.tmuxMode === true) {
        void syncTmuxState("restore");
      }
    }
  });

  window.addEventListener("beforeunload", () => {
    stopStatusPolling();
  });

  setToolbarMode("idle");
  if (runtime) {
    handleRuntimeReady(runtime);
  }
})();
