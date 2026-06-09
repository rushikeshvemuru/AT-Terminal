(function () {
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId") || "";
  const popupId = params.get("popupId") || "";
  const atToken = params.get("atToken") || "";
  const tmuxActions = window.__AT_TMUX_ACTIONS__;

  if (!tmuxActions) {
    console.error("[base-terminal] tmux actions asset is unavailable");
    return;
  }

  const elements = {
    filterInput: document.getElementById("filter-input"),
    refreshButton: document.getElementById("refresh-button"),
    pinButton: document.getElementById("pin-button"),
    closeButton: document.getElementById("close-button"),
    treeSummary: document.getElementById("tree-summary"),
    statusChip: document.getElementById("status-chip"),
    treeRoot: document.getElementById("tree-root"),
    selectionTitle: document.getElementById("selection-title"),
    selectionBadge: document.getElementById("selection-badge"),
    selectionMeta: document.getElementById("selection-meta"),
    selectionActions: document.getElementById("selection-actions"),
    globalActions: document.getElementById("global-actions"),
    commandForm: document.getElementById("command-form"),
    commandInput: document.getElementById("command-input"),
    activityPanel: document.getElementById("activity-panel"),
    activityLog: document.getElementById("activity-log"),
    dialogRoot: document.getElementById("dialog-root"),
  };

  const POLL_INTERVAL_MS = 2500;
  const PINNED_WIDTH_STORAGE_KEY = "at-terminal-tmux-pinned-width";
  const PINNED_MIN_WIDTH = 260;
  const PINNED_MAX_WIDTH = 560;
  const shellQuote = tmuxActions.shellQuote;
  const pinnedRoot = document.getElementById("tmux-pinned-root");
  const activityEntries = [];
  let tmuxState = null;
  let selectedKey = "";
  let pollTimer = null;
  let fetchInFlight = false;

  if (pinnedRoot && !elements.filterInput) {
    initPinnedManager(pinnedRoot);
    return;
  }

  if (!elements.filterInput || !elements.refreshButton || !elements.closeButton) {
    return;
  }

  function nodeKey(kind, id) {
    return `${kind}:${id}`;
  }

  function scopedTmuxId(socketPath, id) {
    return `${socketPath || "default"}:${id}`;
  }

  function logActivity(message, tone = "info") {
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    activityEntries.unshift(`[${timestamp}] ${tone.toUpperCase()}  ${message}`);
    activityEntries.splice(16);
    elements.activityLog.textContent = activityEntries.join("\n");
  }

  function closePopup() {
    window.parent.postMessage(
      {
        type: "at.panelPopup.close",
        popupId,
      },
      "*",
    );
  }

  function sendTmuxCommandToTerminal(command) {
    window.parent.postMessage(
      {
        type: "at.tmuxCommand",
        panelId,
        command,
      },
      "*",
    );
  }

  function tmuxSocketArgs(socketPath) {
    return socketPath ? `-S ${shellQuote(socketPath)} ` : "";
  }

  function nodeSocketPath(node) {
    return node?.session?.socketPath || tmuxState?.targetSocketPath || "";
  }

  function selectedSocketPath() {
    return nodeSocketPath(getSelectedNode());
  }

  function activeClientName() {
    return tmuxState?.activeClientName || "";
  }

  function canTargetActiveClient(socketPath) {
    return Boolean(activeClientName()) && isActiveSocket(socketPath);
  }

  function socketCount() {
    if (!tmuxState || !Array.isArray(tmuxState.sessions)) {
      return 0;
    }
    return new Set(tmuxState.sessions.map((session) => session.socketPath || "default")).size;
  }

  function socketLabel(socketPath) {
    if (!socketPath) {
      return "default";
    }
    const parts = socketPath.split("/");
    return parts.slice(-2).join("/");
  }

  function attachSessionCommand(session) {
    const cwd = tmuxState?.rootDirectory || session.path || "/";
    return `${tmuxSocketArgs(session.socketPath)}new-session -A -s ${shellQuote(session.name)} -c ${shellQuote(cwd)}`;
  }

  function switchClientCommand(session) {
    return `switch-client -c ${shellQuote(activeClientName())} -t ${shellQuote(session.id)}`;
  }

  function joinTmuxCommands(session, commands) {
    return commands.join(`; tmux ${tmuxSocketArgs(session.socketPath)}`);
  }

  function selectWindowCommand(session, windowNode) {
    const commands = [`select-window -t ${shellQuote(windowNode.id)}`];
    if (windowNode.activePaneId) {
      commands.push(`select-pane -t ${shellQuote(windowNode.activePaneId)}`);
    }
    if (canTargetActiveClient(session.socketPath)) {
      commands.push(switchClientCommand(session));
    }
    return joinTmuxCommands(session, commands);
  }

  function selectPaneCommand(session, pane) {
    const commands = [`select-pane -t ${shellQuote(pane.id)}`];
    if (canTargetActiveClient(session.socketPath)) {
      commands.push(switchClientCommand(session));
    }
    return joinTmuxCommands(session, commands);
  }

  async function attachNodeInBackground(node, fetchReason) {
    if (node.kind === "session") {
      if (canTargetActiveClient(node.session.socketPath)) {
        await runTmuxCommand(
          switchClientCommand(node.session),
          "Attached session",
          node.session.socketPath,
        );
      } else {
        sendTmuxCommandToTerminal(attachSessionCommand(node.session));
        await fetchState(fetchReason);
      }
      return;
    }

    if (node.kind === "window") {
      await runTmuxCommand(
        selectWindowCommand(node.session, node.window),
        "Attached window",
        node.session.socketPath,
      );
      return;
    }

    if (node.kind === "pane") {
      await runTmuxCommand(
        selectPaneCommand(node.session, node.pane),
        "Attached pane",
        node.session.socketPath,
      );
    }
  }

  async function detachActiveClient(fetchReason) {
    if (activeClientName()) {
      await runTmuxCommand(
        `detach-client -t ${shellQuote(activeClientName())}`,
        "Detached terminal",
        tmuxState?.targetSocketPath,
      );
      return;
    }

    sendTmuxCommandToTerminal("detach-client");
    await fetchState(fetchReason);
  }

  function isActiveSocket(socketPath) {
    return (
      Boolean(tmuxState?.tmuxActive) &&
      (socketPath || "default") === (tmuxState?.targetSocketPath || "default")
    );
  }

  function buildStateUrl() {
    return buildApiUrl("/api/tmux/state", { panelId, debug: 1, t: Date.now() });
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

  function managerAction(key, onClick, options = {}) {
    const action = tmuxActions.getManagerAction(key);
    return actionSpec(
      action?.selectionLabel || action?.menuLabel || action?.toolbarText || key,
      onClick,
      options.tone,
      options.disabled,
    );
  }

  function menuActionLabel(key) {
    const action = tmuxActions.getManagerAction(key);
    return action?.menuLabel || action?.selectionLabel || action?.toolbarText || key;
  }

  async function fetchState(reason) {
    if (!panelId || fetchInFlight) {
      return;
    }

    fetchInFlight = true;
    try {
      const response = await fetch(buildStateUrl(), { cache: "no-store" });
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          payload && typeof payload.error === "string"
            ? payload.error
            : response.status === 404
              ? "The base module server needs a restart to serve the tmux manager API."
              : `State request failed with status ${response.status}`;
        throw new Error(message);
      }

      if (!payload || typeof payload !== "object") {
        throw new Error("tmux manager returned an invalid state payload");
      }

      tmuxState = payload;
      reconcileSelection();
      render();

      if (reason !== "poll") {
        logActivity(formatStateDiagnostics(payload), payload.tmuxActive ? "info" : "warn");
      }

      if (payload.error && reason !== "poll") {
        logActivity(payload.error, "warn");
      }
      if (
        Array.isArray(payload.diagnostics) &&
        payload.diagnostics.length > 0 &&
        reason !== "poll"
      ) {
        logActivity(payload.diagnostics.join("\n"), "info");
      }
    } catch (error) {
      logActivity(`State refresh failed: ${error.message || error}`, "error");
    } finally {
      fetchInFlight = false;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(() => {
      void fetchState("poll");
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function getFlattenedNodes() {
    if (!tmuxState || !Array.isArray(tmuxState.sessions)) {
      return [];
    }

    const nodes = [];
    for (const session of tmuxState.sessions) {
      nodes.push({
        key: nodeKey("session", scopedTmuxId(session.socketPath, session.id)),
        kind: "session",
        session,
        window: null,
        pane: null,
      });

      for (const window of session.windows || []) {
        nodes.push({
          key: nodeKey("window", scopedTmuxId(session.socketPath, window.id)),
          kind: "window",
          session,
          window,
          pane: null,
        });

        for (const pane of window.panes || []) {
          nodes.push({
            key: nodeKey("pane", scopedTmuxId(session.socketPath, pane.id)),
            kind: "pane",
            session,
            window,
            pane,
          });
        }
      }
    }

    return nodes;
  }

  function formatStateDiagnostics(state) {
    const sessionCount = Array.isArray(state.sessions) ? state.sessions.length : 0;
    return `State panel=${panelId || "missing"} panelConnected=${Boolean(state.panelConnected)} serverRunning=${Boolean(state.serverRunning)} tmuxActive=${Boolean(state.tmuxActive)} match=${state.matchMode || "none"} sessions=${sessionCount}${state.targetSocketPath ? ` socket=${state.targetSocketPath}` : ""}${state.startCommand ? " startCommand=yes" : ""}${state.error ? ` error=${state.error}` : ""}`;
  }

  function reconcileSelection() {
    const nodes = getFlattenedNodes();
    if (nodes.length === 0) {
      selectedKey = "";
      return;
    }

    if (selectedKey && nodes.some((node) => node.key === selectedKey)) {
      return;
    }

    selectedKey = nodes[0].key;
  }

  function getSelectedNode() {
    return getFlattenedNodes().find((node) => node.key === selectedKey) || null;
  }

  function render() {
    renderHeader();
    renderTree();
    renderSelection();
    renderGlobalActions();
  }

  function renderHeader() {
    const sessionCount = tmuxState?.sessions?.length || 0;
    const windowCount =
      tmuxState?.sessions?.reduce((sum, session) => sum + (session.windows?.length || 0), 0) || 0;
    const paneCount =
      tmuxState?.sessions?.reduce(
        (sum, session) =>
          sum +
          (session.windows || []).reduce(
            (windowSum, window) => windowSum + (window.panes?.length || 0),
            0,
          ),
        0,
      ) || 0;

    elements.treeSummary.textContent = `${sessionCount} sessions, ${windowCount} windows, ${paneCount} panes`;

    const chip = elements.statusChip;
    chip.className = "tmux-status-chip";
    if (!tmuxState) {
      chip.textContent = "Loading";
      return;
    }

    if (!tmuxState.available) {
      chip.textContent = "tmux missing";
      chip.classList.add("tmux-status-chip-error");
      return;
    }

    if (!tmuxState.serverRunning) {
      chip.textContent = "server idle";
      chip.classList.add("tmux-status-chip-warn");
      return;
    }

    if (!tmuxState.tmuxActive && sessionCount > 0) {
      chip.textContent = "server sessions";
      chip.classList.add("tmux-status-chip-warn");
      return;
    }

    if (!tmuxState.tmuxActive) {
      chip.textContent = "no sessions";
      chip.classList.add("tmux-status-chip-warn");
      return;
    }

    chip.textContent = tmuxState.version || "active";
    chip.classList.add("tmux-status-chip-ok");
  }

  function renderTree() {
    const filter = (elements.filterInput.value || "").trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    let matches = 0;

    if (!tmuxState || !Array.isArray(tmuxState.sessions) || tmuxState.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tmux-empty-state";
      empty.textContent = tmuxState?.error || "No tmux sessions are available for this terminal.";
      elements.treeRoot.replaceChildren(empty);
      return;
    }

    for (const session of tmuxState.sessions) {
      const sessionRows = [];
      let sessionVisible = matchesFilter(`session ${session.name} ${session.id}`, filter);

      for (const window of session.windows || []) {
        const windowRows = [];
        let windowVisible = matchesFilter(
          `window ${window.name} ${window.id} ${window.index}`,
          filter,
        );

        for (const pane of window.panes || []) {
          const paneVisible = matchesFilter(
            `pane ${pane.title} ${pane.currentCommand} ${pane.currentPath} ${pane.id}`,
            filter,
          );
          if (paneVisible) {
            windowVisible = true;
            sessionVisible = true;
            windowRows.push(
              renderTreeRow(
                "pane",
                scopedTmuxId(session.socketPath, pane.id),
                paneLabel(pane),
                paneBadges(pane),
              ),
            );
            matches += 1;
          }
        }

        if (windowVisible) {
          sessionVisible = true;
          const row = renderTreeRow(
            "window",
            scopedTmuxId(session.socketPath, window.id),
            windowLabel(window),
            windowBadges(window),
          );
          const group = document.createElement("div");
          group.className = "tmux-tree-group";
          group.appendChild(row);
          for (const child of windowRows) {
            child.classList.add("tmux-tree-row-child");
            group.appendChild(child);
          }
          sessionRows.push(group);
          matches += 1;
        }
      }

      if (sessionVisible) {
        const group = document.createElement("div");
        group.className = "tmux-tree-section";
        group.appendChild(
          renderTreeRow(
            "session",
            scopedTmuxId(session.socketPath, session.id),
            sessionLabel(session),
            sessionBadges(session),
          ),
        );
        for (const row of sessionRows) {
          row.classList.add("tmux-tree-section-child");
          group.appendChild(row);
        }
        fragment.appendChild(group);
        matches += 1;
      }
    }

    if (matches === 0) {
      const empty = document.createElement("div");
      empty.className = "tmux-empty-state";
      empty.textContent = "No tree entries match this filter.";
      elements.treeRoot.replaceChildren(empty);
      return;
    }

    elements.treeRoot.replaceChildren(fragment);
  }

  function renderTreeRow(kind, id, label, badges) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tmux-tree-row";
    if (selectedKey === nodeKey(kind, id)) {
      button.classList.add("tmux-tree-row-selected");
    }
    button.addEventListener("click", () => {
      selectedKey = nodeKey(kind, id);
      render();
    });
    button.addEventListener("dblclick", () => {
      selectedKey = nodeKey(kind, id);
      const node = getSelectedNode();
      if (!node) return;
      Promise.resolve(attachNodeInBackground(node, "action")).catch((error) => {
        logActivity(error.message || String(error), "error");
      });
    });

    const text = document.createElement("span");
    text.className = "tmux-tree-row-label";
    text.textContent = label;
    button.appendChild(text);

    const badgeWrap = document.createElement("span");
    badgeWrap.className = "tmux-tree-row-badges";
    for (const badge of badges) {
      const chip = document.createElement("span");
      chip.className = `tmux-inline-badge ${badge.tone ? `tmux-inline-badge-${badge.tone}` : ""}`;
      chip.textContent = badge.label;
      badgeWrap.appendChild(chip);
    }
    button.appendChild(badgeWrap);
    return button;
  }

  function renderSelection() {
    const node = getSelectedNode();
    const actions = [];

    if (!node) {
      elements.selectionTitle.textContent = "No selection";
      elements.selectionBadge.textContent = "tmux";
      elements.selectionMeta.replaceChildren();
      elements.selectionActions.replaceChildren();
      return;
    }

    const meta = [];
    if (node.kind === "session") {
      elements.selectionTitle.textContent = node.session.name;
      elements.selectionBadge.textContent = "Session";
      meta.push(["Session ID", node.session.id]);
      meta.push(["Windows", String(node.session.windowCount)]);
      if (node.session.path) {
        meta.push(["Path", node.session.path]);
      }
      if (node.session.socketPath) {
        meta.push(["Socket", node.session.socketPath]);
      }

      actions.push(actionSpec("Attach", () => attachNodeInBackground(node, "action")));
      actions.push(
        managerAction("newWindow", () =>
          promptForName("New window", "Optional window name", "").then((name) => {
            if (name === null) return;
            return runTmuxCommand(
              tmuxActions.buildNewWindowCommand({
                target: node.session.id,
                name,
              }),
              "Created window",
              node.session.socketPath,
            );
          }),
        ),
      );
      actions.push(
        actionSpec("Rename", () =>
          promptForName("Rename session", "Session name", node.session.name).then((name) => {
            if (name === null) return;
            return runTmuxCommand(
              `rename-session -t ${shellQuote(node.session.id)} ${shellQuote(name)}`,
              "Renamed session",
              node.session.socketPath,
            );
          }),
        ),
      );
      actions.push(
        actionSpec(
          "Kill",
          () =>
            confirmAndRun("Kill session?", `This will destroy session ${node.session.name}.`, () =>
              runTmuxCommand(
                `kill-session -t ${shellQuote(node.session.id)}`,
                "Killed session",
                node.session.socketPath,
              ),
            ),
          "danger",
        ),
      );
    }

    if (node.kind === "window") {
      elements.selectionTitle.textContent = `${node.window.index}: ${node.window.name}`;
      elements.selectionBadge.textContent = "Window";
      meta.push(["Window ID", node.window.id]);
      meta.push(["Session", node.session.name]);
      meta.push(["Layout Flags", node.window.flags || "none"]);
      meta.push(["Pane Count", String(node.window.paneCount)]);
      if (node.window.activePaneId) {
        meta.push(["Active Pane", node.window.activePaneId]);
      }

      actions.push(
        actionSpec(
          "Attach",
          () => attachNodeInBackground(node, "action"),
          "",
          !isActiveSocket(node.session.socketPath),
        ),
      );
      actions.push(
        managerAction(
          "splitVertical",
          () =>
            runTmuxCommand(
              tmuxActions.buildSplitVerticalCommand({
                target: node.window.activePaneId || node.window.id,
              }),
              "Split pane vertically",
              node.session.socketPath,
            ),
          { disabled: !node.window.activePaneId },
        ),
      );
      actions.push(
        managerAction(
          "splitHorizontal",
          () =>
            runTmuxCommand(
              tmuxActions.buildSplitHorizontalCommand({
                target: node.window.activePaneId || node.window.id,
              }),
              "Split pane horizontally",
              node.session.socketPath,
            ),
          { disabled: !node.window.activePaneId },
        ),
      );
      actions.push(
        actionSpec("Rename", () =>
          promptForName("Rename window", "Window name", node.window.name).then((name) => {
            if (name === null) return;
            return runTmuxCommand(
              `rename-window -t ${shellQuote(node.window.id)} ${shellQuote(name)}`,
              "Renamed window",
              node.session.socketPath,
            );
          }),
        ),
      );
      actions.push(
        actionSpec(
          "Kill",
          () =>
            confirmAndRun("Kill window?", `This will close window ${node.window.name}.`, () =>
              runTmuxCommand(
                `kill-window -t ${shellQuote(node.window.id)}`,
                "Killed window",
                node.session.socketPath,
              ),
            ),
          "danger",
        ),
      );
    }

    if (node.kind === "pane") {
      elements.selectionTitle.textContent = paneLabel(node.pane);
      elements.selectionBadge.textContent = "Pane";
      meta.push(["Pane ID", node.pane.id]);
      meta.push(["Session", node.session.name]);
      meta.push(["Window", `${node.window.index}: ${node.window.name}`]);
      meta.push(["Command", node.pane.currentCommand || "shell"]);
      meta.push(["Path", node.pane.currentPath || tmuxState.rootDirectory]);
      meta.push(["Size", `${node.pane.width}x${node.pane.height}`]);

      actions.push(
        actionSpec(
          "Attach",
          () => attachNodeInBackground(node, "action"),
          "",
          !isActiveSocket(node.session.socketPath),
        ),
      );
      actions.push(
        managerAction("splitVertical", () =>
          runTmuxCommand(
            tmuxActions.buildSplitVerticalCommand({
              target: node.pane.id,
              cwd: node.pane.currentPath || tmuxState.rootDirectory,
            }),
            "Split pane vertically",
            node.session.socketPath,
          ),
        ),
      );
      actions.push(
        managerAction("splitHorizontal", () =>
          runTmuxCommand(
            tmuxActions.buildSplitHorizontalCommand({
              target: node.pane.id,
              cwd: node.pane.currentPath || tmuxState.rootDirectory,
            }),
            "Split pane horizontally",
            node.session.socketPath,
          ),
        ),
      );
      actions.push(
        managerAction("newWindow", () =>
          promptForName("New window", "Optional window name", "").then((name) => {
            if (name === null) return;
            return runTmuxCommand(
              tmuxActions.buildNewWindowCommand({
                target: node.session.id,
                name,
                cwd: node.pane.currentPath || tmuxState.rootDirectory,
              }),
              "Created window",
              node.session.socketPath,
            );
          }),
        ),
      );
      actions.push(
        actionSpec(
          "Kill",
          () =>
            confirmAndRun("Kill pane?", `This will close pane ${node.pane.id}.`, () =>
              runTmuxCommand(
                `kill-pane -t ${shellQuote(node.pane.id)}`,
                "Killed pane",
                node.session.socketPath,
              ),
            ),
          "danger",
        ),
      );
    }

    const metaFragment = document.createDocumentFragment();
    for (const [label, value] of meta) {
      const row = document.createElement("div");
      row.className = "tmux-meta-row";

      const key = document.createElement("span");
      key.className = "tmux-meta-key";
      key.textContent = label;
      row.appendChild(key);

      const content = document.createElement("span");
      content.className = "tmux-meta-value";
      content.textContent = value;
      row.appendChild(content);

      metaFragment.appendChild(row);
    }
    elements.selectionMeta.replaceChildren(metaFragment);
    renderActionGrid(elements.selectionActions, actions);
  }

  function renderGlobalActions() {
    const actions = [];
    actions.push(
      actionSpec(
        "New Session",
        () =>
          promptForName("New session", "Optional session name", "").then((name) => {
            if (name === null) return;
            return runTmuxCommand(
              `new-session -d${name ? ` -s ${shellQuote(name)}` : ""} -c ${shellQuote(tmuxState?.rootDirectory || "/")}`,
              "Created session",
            );
          }),
        "primary",
      ),
    );
    if (tmuxState && tmuxState.tmuxActive) {
      actions.push(
        actionSpec(
          "Detach",
          () =>
            confirmAndRun(
              "Detach from tmux?",
              "The current terminal will leave tmux and return to the shell.",
              async () => {
                await detachActiveClient("detach");
                closePopup();
              },
            ),
          "danger",
        ),
      );
    }

    renderActionGrid(elements.globalActions, actions);
  }

  function renderActionGrid(root, actions) {
    const fragment = document.createDocumentFragment();
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tmux-button ${buttonToneClass(action.tone)}`;
      button.textContent = action.label;
      button.disabled = !!action.disabled;
      button.addEventListener("click", () => {
        Promise.resolve(action.onClick()).catch((error) => {
          logActivity(error.message || String(error), "error");
        });
      });
      fragment.appendChild(button);
    }
    root.replaceChildren(fragment);
  }

  function actionSpec(label, onClick, tone, disabled) {
    return { label, onClick, tone, disabled };
  }

  function buttonToneClass(tone) {
    switch (tone) {
      case "primary":
        return "tmux-button-primary";
      case "danger":
        return "tmux-button-danger";
      case "secondary":
        return "tmux-button-secondary";
      default:
        return "tmux-button-secondary";
    }
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
        socketPath: socketPath || selectedSocketPath() || undefined,
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

  async function runTmuxCommand(command, successMessage, socketPath) {
    const data = await executeTmuxCommand(command, socketPath);

    const socketText = data.socketPath ? ` -S ${data.socketPath}` : "";
    const blocks = [`Ran: tmux${socketText} ${command}`];
    if (successMessage && data.ok) {
      blocks.push(successMessage);
    }
    if (data.stdout) {
      blocks.push(data.stdout);
    }
    if (data.stderr) {
      blocks.push(data.stderr);
    }
    logActivity(blocks.join("\n"), data.ok ? "info" : "warn");
    await fetchState("command");
  }

  function matchesFilter(value, filter) {
    if (!filter) {
      return true;
    }
    return value.toLowerCase().includes(filter);
  }

  function sessionLabel(session) {
    return session.name;
  }

  function windowLabel(window) {
    return `${window.index}: ${window.name}`;
  }

  function paneLabel(pane) {
    const command = pane.currentCommand || "shell";
    return `${pane.id} ${command}`;
  }

  function sessionBadges(session) {
    const badges = [];
    if (session.attached > 0) {
      badges.push({ label: "attached", tone: "ok" });
    }
    if (socketCount() > 1) {
      badges.push({ label: socketLabel(session.socketPath) });
    }
    badges.push({ label: pluralize(session.windowCount, "window") });
    return badges;
  }

  function windowBadges(window) {
    const badges = [];
    if (window.active) {
      badges.push({ label: "active", tone: "ok" });
    }
    if (window.zoomed) {
      badges.push({ label: "zoomed" });
    }
    badges.push({ label: pluralize(window.paneCount, "pane") });
    return badges;
  }

  function paneBadges(pane) {
    const badges = [];
    if (pane.active) {
      badges.push({ label: "active", tone: "ok" });
    }
    if (pane.dead) {
      badges.push({ label: "dead", tone: "danger" });
    }
    return badges;
  }

  function pluralize(count, singular) {
    return `${count} ${count === 1 ? singular : `${singular}s`}`;
  }

  function activePanePath(window) {
    const pane = (window.panes || []).find((entry) => entry.id === window.activePaneId);
    return pane ? pane.currentPath : "";
  }

  function promptForName(title, label, initialValue) {
    return openDialog({
      title,
      description: label,
      confirmLabel: "Continue",
      input: {
        value: initialValue || "",
        placeholder: "Enter a value",
      },
    });
  }

  function confirmAndRun(title, description, callback) {
    return openDialog({
      title,
      description,
      confirmLabel: "Confirm",
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return;
      }
      return callback();
    });
  }

  function openDialog(options) {
    return new Promise((resolve) => {
      const dialogRoot = elements.dialogRoot || document.body;
      const overlay = document.createElement("div");
      overlay.className = "tmux-dialog-overlay";

      const dialog = document.createElement("div");
      dialog.className = "tmux-dialog";
      overlay.appendChild(dialog);

      const title = document.createElement("h3");
      title.textContent = options.title;
      dialog.appendChild(title);

      const description = document.createElement("p");
      description.textContent = options.description;
      dialog.appendChild(description);

      let input = null;
      if (options.input) {
        input = document.createElement("input");
        input.type = "text";
        input.className = "tmux-dialog-input";
        input.value = options.input.value || "";
        input.placeholder = options.input.placeholder || "";
        dialog.appendChild(input);
      }

      const actions = document.createElement("div");
      actions.className = "tmux-dialog-actions";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "tmux-button tmux-button-ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        overlay.remove();
        resolve(options.input ? null : false);
      });
      actions.appendChild(cancel);

      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = `tmux-button ${options.destructive ? "tmux-button-danger" : "tmux-button-primary"}`;
      confirm.textContent = options.confirmLabel || "Confirm";
      confirm.addEventListener("click", () => {
        const value = input ? input.value.trim() : true;
        overlay.remove();
        resolve(value);
      });
      actions.appendChild(confirm);

      dialog.appendChild(actions);
      if (elements.dialogRoot) {
        elements.dialogRoot.replaceChildren(overlay);
      } else {
        dialogRoot.appendChild(overlay);
      }

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
          overlay.remove();
          resolve(options.input ? null : false);
        }
      });

      if (input) {
        input.focus();
        input.select();
      } else {
        confirm.focus();
      }
    });
  }

  function initPinnedManager(root) {
    const pinned = {
      active: false,
      collapsed: false,
      expanded: new Set(),
      expandedDefaults: new Set(),
      menu: null,
      status: null,
      summary: null,
      tree: null,
      collapseButton: null,
      resizeHandle: null,
      width: readPinnedWidth(),
      lastStateSignature: "",
    };

    root.replaceChildren();
    root.classList.add("tmux-pinned");
    applyPinnedWidth(pinned.width);
    root.hidden = true;

    const header = document.createElement("div");
    header.className = "tmux-pinned-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "tmux-pinned-title-wrap";

    const title = document.createElement("div");
    title.className = "tmux-pinned-title";
    title.textContent = "tmux";
    titleWrap.appendChild(title);

    pinned.summary = document.createElement("div");
    pinned.summary.className = "tmux-pinned-summary";
    pinned.summary.textContent = "Waiting";
    titleWrap.appendChild(pinned.summary);
    header.appendChild(titleWrap);

    const controls = document.createElement("div");
    controls.className = "tmux-pinned-controls";

    const refreshButton = pinnedIconButton("Refresh", "↻");
    refreshButton.addEventListener("click", () => {
      void fetchPinnedState("refresh");
    });
    controls.appendChild(refreshButton);

    pinned.collapseButton = pinnedIconButton("Collapse tmux panel", "‹");
    pinned.collapseButton.addEventListener("click", () => {
      patchPinnedPanelState({
        tmuxManagerPinned: true,
        tmuxManagerCollapsed: !pinned.collapsed,
      });
    });
    controls.appendChild(pinned.collapseButton);

    const unpinButton = pinnedIconButton("Unpin tmux panel", "×");
    unpinButton.addEventListener("click", () => {
      patchPinnedPanelState({
        tmuxManagerPinned: false,
        tmuxManagerCollapsed: false,
      });
    });
    controls.appendChild(unpinButton);
    header.appendChild(controls);
    root.appendChild(header);

    pinned.status = document.createElement("div");
    pinned.status.className = "tmux-pinned-status";
    pinned.status.textContent = "Loading tmux state";
    root.appendChild(pinned.status);

    pinned.tree = document.createElement("div");
    pinned.tree.className = "tmux-pinned-tree";
    root.appendChild(pinned.tree);

    pinned.resizeHandle = document.createElement("div");
    pinned.resizeHandle.className = "tmux-pinned-resize-handle";
    pinned.resizeHandle.title = "Resize tmux panel";
    pinned.resizeHandle.addEventListener("mousedown", handlePinnedResizeStart);
    root.appendChild(pinned.resizeHandle);

    function pinnedIconButton(titleText, label) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tmux-pinned-icon-button";
      button.title = titleText;
      button.textContent = label;
      return button;
    }

    function readPinnedWidth() {
      const stored = Number(window.localStorage.getItem(PINNED_WIDTH_STORAGE_KEY));
      return clampPinnedWidth(Number.isFinite(stored) && stored > 0 ? stored : 320);
    }

    function clampPinnedWidth(width) {
      const availableWidth = Math.max(
        PINNED_MIN_WIDTH,
        Math.min(PINNED_MAX_WIDTH, Math.floor(window.innerWidth * 0.5)),
      );
      return Math.min(availableWidth, Math.max(PINNED_MIN_WIDTH, Math.round(width)));
    }

    function applyPinnedWidth(width) {
      pinned.width = clampPinnedWidth(width);
      if (!pinned.collapsed) {
        root.style.setProperty("--tmux-pinned-width", `${pinned.width}px`);
      }
    }

    function handlePinnedResizeStart(event) {
      if (pinned.collapsed) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = pinned.width;
      root.classList.add("tmux-pinned-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handleMouseMove = (moveEvent) => {
        applyPinnedWidth(startWidth + moveEvent.clientX - startX);
        window.__AT_TERMINAL_RUNTIME__?.fit?.();
      };

      const handleMouseUp = () => {
        root.classList.remove("tmux-pinned-resizing");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.localStorage.setItem(PINNED_WIDTH_STORAGE_KEY, String(pinned.width));
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        window.__AT_TERMINAL_RUNTIME__?.fit?.();
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    function patchPinnedPanelState(panelState) {
      window.parent.postMessage(
        {
          type: "at.panelState.patch",
          panelId,
          panelState,
        },
        "*",
      );
    }

    function applyPinnedState(panelState) {
      const nextActive = panelState.tmuxManagerPinned === true;
      const nextCollapsed = panelState.tmuxManagerCollapsed === true;
      const wasActive = pinned.active;
      const wasCollapsed = pinned.collapsed;
      pinned.active = nextActive;
      pinned.collapsed = nextCollapsed;
      root.hidden = !nextActive;
      root.classList.toggle("tmux-pinned-collapsed", nextCollapsed);
      if (nextCollapsed) {
        root.style.removeProperty("--tmux-pinned-width");
      } else {
        applyPinnedWidth(pinned.width);
      }
      if (pinned.collapseButton) {
        pinned.collapseButton.textContent = nextCollapsed ? "›" : "‹";
        pinned.collapseButton.title = nextCollapsed ? "Expand tmux panel" : "Collapse tmux panel";
      }

      if (nextActive) {
        startPinnedPolling();
        if (!wasActive) {
          renderPinned();
          void fetchPinnedState("pin");
        }
      } else {
        stopPolling();
        closePinnedMenu();
      }

      if (wasActive !== nextActive || wasCollapsed !== nextCollapsed) {
        requestAnimationFrame(() => {
          window.__AT_TERMINAL_RUNTIME__?.fit?.();
        });
      }
    }

    async function fetchPinnedState(reason) {
      if (!pinned.active || !panelId || fetchInFlight) {
        return;
      }

      fetchInFlight = true;
      try {
        const response = await fetch(buildStateUrl(), { cache: "no-store" });
        const responseText = await response.text();
        let payload = null;
        try {
          payload = responseText ? JSON.parse(responseText) : {};
        } catch {
          payload = null;
        }
        if (!response.ok || !payload || typeof payload !== "object") {
          throw new Error(`State request failed with status ${response.status}`);
        }
        const nextSignature = pinnedStateSignature(payload);
        const changed = nextSignature !== pinned.lastStateSignature;
        pinned.lastStateSignature = nextSignature;
        tmuxState = payload;
        reconcileSelection();
        ensureExpandedDefaults();
        if (changed) {
          renderPinned();
        }
      } catch (error) {
        if (pinned.status) {
          pinned.status.textContent = `State refresh failed: ${error.message || error}`;
          pinned.status.classList.add("tmux-pinned-status-error");
        }
      } finally {
        fetchInFlight = false;
      }

      if (reason !== "poll") {
        window.setTimeout(() => {
          if (pinned.active) {
            void fetchPinnedState("settle");
          }
        }, 350);
      }
    }

    function startPinnedPolling() {
      if (pollTimer !== null) {
        return;
      }
      pollTimer = window.setInterval(() => {
        void fetchPinnedState("poll");
      }, POLL_INTERVAL_MS);
    }

    function pinnedStateSignature(payload) {
      if (!payload || typeof payload !== "object") {
        return "";
      }
      return JSON.stringify({
        available: payload.available,
        serverRunning: payload.serverRunning,
        tmuxActive: payload.tmuxActive,
        panelConnected: payload.panelConnected,
        version: payload.version,
        error: payload.error,
        targetSocketPath: payload.targetSocketPath,
        activeSessionName: payload.activeSessionName,
        activeClientName: payload.activeClientName,
        sessions: payload.sessions,
      });
    }

    function ensureExpandedDefaults() {
      if (!tmuxState || !Array.isArray(tmuxState.sessions)) {
        return;
      }

      for (const session of tmuxState.sessions) {
        const sessionId = scopedTmuxId(session.socketPath, session.id);
        const sessionKey = nodeKey("session", sessionId);
        if (!pinned.expandedDefaults.has(sessionKey)) {
          pinned.expanded.add(sessionKey);
          pinned.expandedDefaults.add(sessionKey);
        }
        for (const window of session.windows || []) {
          const windowId = scopedTmuxId(session.socketPath, window.id);
          const windowKey = nodeKey("window", windowId);
          if (!pinned.expandedDefaults.has(windowKey)) {
            pinned.expanded.add(windowKey);
            pinned.expandedDefaults.add(windowKey);
          }
        }
      }
    }

    function renderPinned() {
      if (!pinned.active || !pinned.tree || !pinned.status || !pinned.summary) {
        return;
      }

      const sessionCount = tmuxState?.sessions?.length || 0;
      const windowCount =
        tmuxState?.sessions?.reduce((sum, session) => sum + (session.windows?.length || 0), 0) || 0;
      const paneCount =
        tmuxState?.sessions?.reduce(
          (sum, session) =>
            sum +
            (session.windows || []).reduce(
              (windowSum, window) => windowSum + (window.panes?.length || 0),
              0,
            ),
          0,
        ) || 0;

      pinned.summary.textContent = `${sessionCount}s ${windowCount}w ${paneCount}p`;
      pinned.status.className = "tmux-pinned-status";
      if (!tmuxState) {
        pinned.status.textContent = "Loading tmux state";
      } else if (!tmuxState.available) {
        pinned.status.textContent = "tmux is not installed";
        pinned.status.classList.add("tmux-pinned-status-error");
      } else if (!tmuxState.serverRunning) {
        pinned.status.textContent = "No tmux server";
        pinned.status.classList.add("tmux-pinned-status-warn");
      } else if (!tmuxState.tmuxActive && sessionCount > 0) {
        pinned.status.textContent = "Server sessions available";
        pinned.status.classList.add("tmux-pinned-status-warn");
      } else {
        pinned.status.textContent = tmuxState.version || "tmux active";
        pinned.status.classList.add("tmux-pinned-status-ok");
      }

      if (!tmuxState || !Array.isArray(tmuxState.sessions) || tmuxState.sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tmux-pinned-empty";
        empty.textContent = tmuxState?.error || "No sessions";
        pinned.tree.replaceChildren(empty);
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const session of tmuxState.sessions) {
        const sessionId = scopedTmuxId(session.socketPath, session.id);
        const sessionKey = nodeKey("session", sessionId);
        const sessionGroup = document.createElement("div");
        sessionGroup.className = "tmux-pinned-group";
        sessionGroup.appendChild(
          renderPinnedRow({
            key: sessionKey,
            kind: "session",
            label: sessionLabel(session),
            meta: `${session.windowCount || (session.windows || []).length}w`,
            hasChildren: (session.windows || []).length > 0,
            active: session.associated || isActiveSocket(session.socketPath),
            onToggle: () => togglePinnedExpanded(sessionKey),
            onOpen: () => openPinnedNode({ kind: "session", session }),
            onMenu: (event) => openPinnedMenu(event, { kind: "session", session }),
          }),
        );

        if (pinned.expanded.has(sessionKey)) {
          for (const window of session.windows || []) {
            const windowId = scopedTmuxId(session.socketPath, window.id);
            const windowKey = nodeKey("window", windowId);
            const windowGroup = document.createElement("div");
            windowGroup.className = "tmux-pinned-group tmux-pinned-nested";
            windowGroup.appendChild(
              renderPinnedRow({
                key: windowKey,
                kind: "window",
                label: windowLabel(window),
                meta: `${window.paneCount || (window.panes || []).length}p`,
                hasChildren: (window.panes || []).length > 0,
                active: window.active,
                onToggle: () => togglePinnedExpanded(windowKey),
                onOpen: () => openPinnedNode({ kind: "window", session, window }),
                onMenu: (event) => openPinnedMenu(event, { kind: "window", session, window }),
              }),
            );

            if (pinned.expanded.has(windowKey)) {
              for (const pane of window.panes || []) {
                const paneId = scopedTmuxId(session.socketPath, pane.id);
                const paneKey = nodeKey("pane", paneId);
                const row = renderPinnedRow({
                  key: paneKey,
                  kind: "pane",
                  label: paneLabel(pane),
                  meta: pane.currentPath || "",
                  hasChildren: false,
                  active: pane.active,
                  onOpen: () => openPinnedNode({ kind: "pane", session, window, pane }),
                  onMenu: (event) => openPinnedMenu(event, { kind: "pane", session, window, pane }),
                });
                row.classList.add("tmux-pinned-pane-row");
                windowGroup.appendChild(row);
              }
            }
            sessionGroup.appendChild(windowGroup);
          }
        }
        fragment.appendChild(sessionGroup);
      }
      pinned.tree.replaceChildren(fragment);
    }

    function renderPinnedRow(options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tmux-pinned-row tmux-pinned-row-${options.kind}`;
      if (selectedKey === options.key) {
        button.classList.add("tmux-pinned-row-selected");
      }
      if (options.active) {
        button.classList.add("tmux-pinned-row-active");
      }
      button.addEventListener("click", (event) => {
        selectedKey = options.key;
        if (options.hasChildren) {
          const bounds = button.getBoundingClientRect();
          if (event.clientX <= bounds.left + 28) {
            options.onToggle();
            return;
          }
        }
        renderPinned();
      });
      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        selectedKey = options.key;
        Promise.resolve(options.onOpen()).catch((error) => {
          if (pinned.status) {
            pinned.status.textContent = error.message || String(error);
            pinned.status.classList.add("tmux-pinned-status-error");
          }
        });
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        selectedKey = options.key;
        renderPinned();
        options.onMenu(event);
      });

      const toggle = document.createElement("span");
      toggle.className = "tmux-pinned-row-toggle";
      toggle.textContent = options.hasChildren
        ? pinned.expanded.has(options.key)
          ? "▾"
          : "▸"
        : "";
      toggle.title = options.hasChildren ? "Expand or collapse" : "";
      if (options.hasChildren) {
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          options.onToggle();
        });
      }
      button.appendChild(toggle);

      const label = document.createElement("span");
      label.className = "tmux-pinned-row-label";
      label.textContent = options.label;
      button.appendChild(label);

      const meta = document.createElement("span");
      meta.className = "tmux-pinned-row-meta";
      meta.textContent = options.meta || "";
      button.appendChild(meta);

      return button;
    }

    function togglePinnedExpanded(key) {
      if (pinned.expanded.has(key)) {
        pinned.expanded.delete(key);
      } else {
        pinned.expanded.add(key);
      }
      renderPinned();
    }

    async function openPinnedNode(node) {
      if (node.kind === "session") {
        if (canTargetActiveClient(node.session.socketPath)) {
          await runPinnedCommand(switchClientCommand(node.session), node.session.socketPath);
        } else {
          sendPinnedTmuxCommand(attachSessionCommand(node.session));
          window.setTimeout(() => {
            void fetchPinnedState("open");
          }, 300);
        }
        return;
      }

      if (node.kind === "window") {
        await runPinnedCommand(
          selectWindowCommand(node.session, node.window),
          node.session.socketPath,
        );
        return;
      }

      if (node.kind === "pane") {
        await runPinnedCommand(selectPaneCommand(node.session, node.pane), node.session.socketPath);
      }
    }

    function sendPinnedTmuxCommand(command) {
      const runtime = window.__AT_TERMINAL_RUNTIME__;
      if (!runtime || !runtime.isSocketOpen()) {
        return;
      }
      runtime.sendCommand(`tmux ${command}`);
    }

    function openPinnedMenu(event, node) {
      closePinnedMenu();
      const menu = document.createElement("div");
      menu.className = "tmux-pinned-context-menu";
      const rect = root.getBoundingClientRect();
      menu.style.left = `${Math.max(8, event.clientX - rect.left)}px`;
      menu.style.top = `${Math.max(8, event.clientY - rect.top)}px`;

      const addItem = (label, callback, danger) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = danger ? "tmux-pinned-menu-danger" : "";
        item.textContent = label;
        item.addEventListener("click", () => {
          closePinnedMenu();
          Promise.resolve(callback()).catch((error) => {
            if (pinned.status) {
              pinned.status.textContent = error.message || String(error);
              pinned.status.classList.add("tmux-pinned-status-error");
            }
          });
        });
        menu.appendChild(item);
      };

      addItem("Attach", () => openPinnedNode(node));

      if (node.kind === "session") {
        addItem(menuActionLabel("newWindow"), () => createPinnedWindow(node.session, null));
        addItem("Rename session", () => renamePinnedSession(node.session));
        addItem("Kill session", () => killPinnedSession(node.session), true);
      }

      if (node.kind === "window") {
        addItem(menuActionLabel("splitVertical"), () =>
          runPinnedCommand(
            tmuxActions.buildSplitVerticalCommand({
              target: node.window.activePaneId || node.window.id,
            }),
            node.session.socketPath,
          ),
        );
        addItem(menuActionLabel("splitHorizontal"), () =>
          runPinnedCommand(
            tmuxActions.buildSplitHorizontalCommand({
              target: node.window.activePaneId || node.window.id,
            }),
            node.session.socketPath,
          ),
        );
        addItem("Rename window", () => renamePinnedWindow(node.session, node.window));
        addItem("Kill window", () => killPinnedWindow(node.session, node.window), true);
      }

      if (node.kind === "pane") {
        addItem(menuActionLabel("splitVertical"), () =>
          runPinnedCommand(
            tmuxActions.buildSplitVerticalCommand({
              target: node.pane.id,
              cwd: node.pane.currentPath || tmuxState?.rootDirectory || "/",
            }),
            node.session.socketPath,
          ),
        );
        addItem(menuActionLabel("splitHorizontal"), () =>
          runPinnedCommand(
            tmuxActions.buildSplitHorizontalCommand({
              target: node.pane.id,
              cwd: node.pane.currentPath || tmuxState?.rootDirectory || "/",
            }),
            node.session.socketPath,
          ),
        );
        addItem(menuActionLabel("newWindow"), () => createPinnedWindow(node.session, node.pane));
        addItem("Kill pane", () => killPinnedPane(node.session, node.pane), true);
      }

      addItem("Detach", () => {
        if (activeClientName()) {
          return runPinnedCommand(
            `detach-client -t ${shellQuote(activeClientName())}`,
            tmuxState?.targetSocketPath,
          );
        }
        sendPinnedTmuxCommand("detach-client");
        return fetchPinnedState("detach");
      });

      pinned.menu = menu;
      root.appendChild(menu);
    }

    function closePinnedMenu() {
      if (pinned.menu) {
        pinned.menu.remove();
        pinned.menu = null;
      }
    }

    async function runPinnedCommand(command, socketPath) {
      const data = await executeTmuxCommand(command, socketPath);
      if (!data.ok) {
        throw new Error(data.stderr || data.stdout || "tmux command failed");
      }
      await fetchPinnedState("command");
    }

    async function createPinnedWindow(session, pane) {
      const name = await promptForName("New window", "Optional window name", "");
      if (name === null) return;
      const cwd = pane?.currentPath || session.path || tmuxState?.rootDirectory || "/";
      await runPinnedCommand(
        tmuxActions.buildNewWindowCommand({
          target: session.id,
          name: name.trim(),
          cwd,
        }),
        session.socketPath,
      );
    }

    async function renamePinnedSession(session) {
      const name = await promptForName("Rename session", "Session name", session.name);
      if (name === null || !name.trim()) return;
      await runPinnedCommand(
        `rename-session -t ${shellQuote(session.id)} ${shellQuote(name.trim())}`,
        session.socketPath,
      );
    }

    async function renamePinnedWindow(session, windowNode) {
      const name = await promptForName("Rename window", "Window name", windowNode.name);
      if (name === null || !name.trim()) return;
      await runPinnedCommand(
        `rename-window -t ${shellQuote(windowNode.id)} ${shellQuote(name.trim())}`,
        session.socketPath,
      );
    }

    async function killPinnedSession(session) {
      await confirmAndRun("Kill session?", `This will destroy session ${session.name}.`, () =>
        runPinnedCommand(`kill-session -t ${shellQuote(session.id)}`, session.socketPath),
      );
    }

    async function killPinnedWindow(session, windowNode) {
      await confirmAndRun("Kill window?", `This will close window ${windowNode.name}.`, () =>
        runPinnedCommand(`kill-window -t ${shellQuote(windowNode.id)}`, session.socketPath),
      );
    }

    async function killPinnedPane(session, pane) {
      await confirmAndRun("Kill pane?", `This will close pane ${pane.id}.`, () =>
        runPinnedCommand(`kill-pane -t ${shellQuote(pane.id)}`, session.socketPath),
      );
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type !== "at.panelState.sync" || message.panelId !== panelId) return;
      const panelState =
        message.panelState && typeof message.panelState === "object" ? message.panelState : {};
      applyPinnedState(panelState);
    });

    window.addEventListener("click", (event) => {
      if (pinned.menu && !pinned.menu.contains(event.target)) {
        closePinnedMenu();
      }
    });

    window.addEventListener("beforeunload", () => {
      stopPolling();
    });
  }

  elements.filterInput.addEventListener("input", () => {
    renderTree();
  });

  elements.refreshButton.addEventListener("click", () => {
    void fetchState("refresh");
  });

  if (elements.pinButton) {
    elements.pinButton.addEventListener("click", () => {
      window.parent.postMessage(
        {
          type: "at.panelState.patch",
          panelId,
          popupId,
          panelState: {
            tmuxManagerPinned: true,
            tmuxManagerCollapsed: false,
          },
        },
        "*",
      );
      closePopup();
    });
  }

  elements.closeButton.addEventListener("click", () => {
    closePopup();
  });

  elements.commandForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const command = elements.commandInput.value.trim();
    if (!command) {
      return;
    }

    void runTmuxCommand(command)
      .then(() => {
        elements.commandInput.value = "";
      })
      .catch((error) => {
        logActivity(error.message || String(error), "error");
      });
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTextEntry =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if (event.key === "Escape") {
      closePopup();
      return;
    }

    if (event.key === "/" && !isTextEntry) {
      event.preventDefault();
      elements.filterInput.focus();
      return;
    }

    if (event.key === "Enter" && !isTextEntry) {
      const node = getSelectedNode();
      if (!node) return;
      event.preventDefault();
      Promise.resolve(attachNodeInBackground(node, "action")).catch((error) => {
        logActivity(error.message || String(error), "error");
      });
    }
  });

  window.addEventListener("beforeunload", () => {
    stopPolling();
  });

  logActivity("Opening tmux manager", "info");
  render();
  void fetchState("initial");
  startPolling();
})();
