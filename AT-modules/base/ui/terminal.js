(function () {
  const params = new URLSearchParams(window.location.search);
  const panelId = params.get("panelId") || `panel-${Date.now()}`;
  const atToken = params.get("atToken") || "";
  const rootDirectory = params.get("rootDirectory") || "";
  const terminalElement = document.getElementById("terminal");
  const TerminalCtor =
    typeof window.Terminal === "function"
      ? window.Terminal
      : window.Terminal && window.Terminal.Terminal;
  const FitAddonCtor =
    typeof window.FitAddon === "function"
      ? window.FitAddon
      : window.FitAddon && window.FitAddon.FitAddon;

  if (!TerminalCtor || !FitAddonCtor || !terminalElement) {
    document.body.textContent = "Terminal runtime failed to load";
    return;
  }

  const term = new TerminalCtor({
    cursorBlink: true,
    fontSize: 13,
    scrollback: 10000,
    fontFamily: '"IBM Plex Mono", Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: "#09090b",
      foreground: "#a1a1aa",
      cursor: "#a1a1aa",
      selectionBackground: "#27272a",
    },
  });
  const fitAddon = new FitAddonCtor();
  let socket = null;
  let socketOpened = false;
  let connectionFailureReported = false;

  term.loadAddon(fitAddon);
  term.open(terminalElement);

  const storageKey = `at-terminal-buffer:${panelId}`;
  const savedBuffer = window.localStorage.getItem(storageKey);
  if (savedBuffer) {
    term.write(savedBuffer);
    term.write(
      "\r\n\x1b[90m------------------------------------------------\x1b[0m\r\n\x1b[32m[Session restored]\x1b[0m\r\n",
    );
  }

  function isSocketOpen() {
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  function sendSocketMessage(prefix, value) {
    if (!isSocketOpen()) {
      throw new Error("terminal connection is unavailable");
    }

    socket.send(`${prefix}${value}`);
  }

  function fit() {
    try {
      fitAddon.fit();
    } catch {
      return;
    }

    if (isSocketOpen()) {
      socket.send(`r:${Math.max(term.cols, 10)}:${Math.max(term.rows, 5)}`);
    }
  }

  function reportConnectionFailure(message) {
    if (connectionFailureReported) return;
    connectionFailureReported = true;
    term.writeln(`\r\n\x1b[31m[${message}]\x1b[0m`);
  }

  const runtime = {
    panelId,
    rootDirectory,
    isSocketOpen,
    sendInput(input) {
      sendSocketMessage("i", input);
    },
    sendCommand(command) {
      sendSocketMessage("c", command);
    },
    writeLine(message) {
      term.writeln(message);
    },
    fit,
  };

  window.__AT_TERMINAL_RUNTIME__ = runtime;
  window.dispatchEvent(new CustomEvent("at-terminal:runtime-ready", { detail: runtime }));

  requestAnimationFrame(fit);
  new ResizeObserver(fit).observe(terminalElement);

  const wsUrl = new URL("/ws/terminal", window.location.href);
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("panelId", panelId);
  wsUrl.searchParams.set("rootDirectory", rootDirectory);
  wsUrl.searchParams.set("cols", String(Math.max(term.cols, 10)));
  wsUrl.searchParams.set("rows", String(Math.max(term.rows, 5)));
  if (atToken) {
    wsUrl.searchParams.set("atToken", atToken);
  }

  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    socketOpened = true;
    fit();
    window.dispatchEvent(new CustomEvent("at-terminal:socket-open", { detail: runtime }));
  });

  socket.addEventListener("message", (event) => {
    term.write(String(event.data));
  });

  socket.addEventListener("close", () => {
    window.dispatchEvent(new CustomEvent("at-terminal:socket-close", { detail: runtime }));
    if (socketOpened) {
      term.writeln("\r\n\x1b[90m[Module terminal disconnected]\x1b[0m");
    } else {
      reportConnectionFailure("Module terminal disconnected before a shell could start");
    }
  });

  socket.addEventListener("error", () => {
    window.dispatchEvent(new CustomEvent("at-terminal:socket-error", { detail: runtime }));
    reportConnectionFailure("Module terminal connection failed");
  });

  term.onData((data) => {
    if (isSocketOpen()) {
      socket.send(`i${data}`);
    }
  });

  setInterval(() => {
    const lines = [];
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - 2000);
    for (let index = start; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    window.localStorage.setItem(storageKey, lines.join("\r\n"));
  }, 10000);

  window.addEventListener("beforeunload", () => {
    if (isSocketOpen()) {
      socket.close();
    }
  });
})();
