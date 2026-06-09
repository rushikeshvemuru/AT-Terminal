import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ORIGIN = "http://127.0.0.1:47831";
const EXPECTED_BASE_VERSION = "tmux-state-25";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE_MODULE_DIR = path.join(REPO_ROOT, "AT-modules/base");

type BaseVersionResponse = {
  module?: string;
  version?: string;
};

type TmuxStateResponse = {
  available: boolean;
  serverRunning: boolean;
  tmuxActive: boolean;
  panelConnected: boolean;
  matchMode?: "clientTty" | "foregroundTmux" | "socket" | "none";
  activeSessionName?: string | null;
  startCommand?: string | null;
  sessions: Array<{
    name?: string;
    associated?: boolean;
    socketPath?: string | null;
    windows?: Array<{ panes?: unknown[] }>;
  }>;
  error: string | null;
};

declare global {
  interface Window {
    __toolbarPatches?: Array<{
      id?: string;
      color?: string;
      disabled?: boolean;
      tooltip?: string;
      visible?: boolean;
    }>;
    __panelStatePatches?: unknown[];
    __popupMessages?: Array<{ route?: string; title?: string }>;
  }
}

let baseServer: ChildProcessWithoutNullStreams | null = null;
const tmuxSessionsToCleanup = new Set<{ sessionName: string; socketPath?: string }>();

test.skip(!hasTmux(), "tmux is not installed on this machine");

test.beforeAll(async () => {
  let runningVersion = await readBaseVersion();
  if (runningVersion && runningVersion.version !== EXPECTED_BASE_VERSION) {
    console.warn(
      `stale base module server is running: expected ${EXPECTED_BASE_VERSION}, got ${runningVersion.version ?? "unknown"}; restarting through scripts/start.sh`,
    );
    runningVersion = null;
  }

  if (!runningVersion) {
    baseServer = spawn("bash", ["scripts/start.sh"], {
      cwd: BASE_MODULE_DIR,
      env: {
        ...process.env,
        TMUX: "",
        TMUX_PANE: "",
      },
    });

    baseServer.stdout.on("data", (chunk) => {
      process.stdout.write(`[base-module] ${chunk}`);
    });
    baseServer.stderr.on("data", (chunk) => {
      process.stderr.write(`[base-module] ${chunk}`);
    });
  }

  await expect
    .poll(async () => (await readBaseVersion())?.version, {
      message: "base module server should expose the expected test version",
      timeout: 20_000,
      intervals: [250, 500, 1_000],
    })
    .toBe(EXPECTED_BASE_VERSION);
});

test.afterAll(() => {
  if (baseServer) {
    baseServer.kill();
    baseServer = null;
  }
});

test.afterEach(() => {
  cleanupTmuxSessions();
});

test("terminal tmux toolbar state and manager data stay in sync", async ({ page }) => {
  const panelId = `tmux-e2e-${Date.now()}`;
  const rootDetachedSessionName = `at-terminal-root-${Date.now()}`;
  const outsideSessionName = `at-terminal-outside-${Date.now()}`;
  const tmuxSocketPath = isolatedTmuxSocketPath(panelId);
  await installToolbarCapture(page);
  createDetachedTmuxSession(rootDetachedSessionName, REPO_ROOT, tmuxSocketPath);
  createDetachedTmuxSession(outsideSessionName, "/tmp", tmuxSocketPath);

  await page.goto(
    `${MODULE_ORIGIN}/panels/terminal?panelId=${encodeURIComponent(panelId)}&rootDirectory=${encodeURIComponent(REPO_ROOT)}`,
  );

  await expect
    .poll(() => fetchTmuxState(panelId), {
      message: "terminal websocket should register the panel before tmux starts",
      timeout: 10_000,
      intervals: [250, 500, 1_000],
    })
    .toMatchObject({ panelConnected: true });

  const initialState = await fetchTmuxState(panelId);
  expect(initialState.sessions.some((session) => session.name === rootDetachedSessionName)).toBe(
    true,
  );
  expect(initialState.sessions.some((session) => session.name === outsideSessionName)).toBe(true);
  expect(
    initialState.sessions.find((session) => session.name === rootDetachedSessionName)?.associated,
  ).toBe(true);
  expect(
    initialState.sessions.find((session) => session.name === outsideSessionName)?.associated,
  ).toBe(false);
  expect(initialState.tmuxActive).toBe(false);
  expect(initialState.matchMode).toBe("socket");
  expect(initialState.startCommand).toContain(rootDetachedSessionName);

  const detachedManagerPage = await page.context().newPage();
  await detachedManagerPage.goto(
    `${MODULE_ORIGIN}/panels/tmux-manager?panelId=${encodeURIComponent(panelId)}&popupId=e2e-detached-popup`,
  );
  await expect(detachedManagerPage.locator("#status-chip")).toContainText(/server sessions/i);
  await expect(detachedManagerPage.locator("#tree-summary")).not.toContainText(/^0 sessions/);
  await expect(detachedManagerPage.locator("#tree-root")).toContainText(rootDetachedSessionName);
  await expect(detachedManagerPage.locator("#tree-root")).toContainText(outsideSessionName);
  await detachedManagerPage.close();

  await expect
    .poll(() => latestToolbarPatch(page, "tmux"))
    .toMatchObject({
      id: "tmux",
      disabled: false,
    });
  await expect
    .poll(() => latestToolbarPatch(page, "tmux-manager"))
    .toMatchObject({
      id: "tmux-manager",
      visible: true,
      disabled: false,
    });

  await page.evaluate((id) => {
    window.postMessage(
      {
        type: "at.panelState.sync",
        panelId: id,
        panelState: { tmuxMode: true },
      },
      "*",
    );
  }, panelId);
  await page.waitForTimeout(1_000);
  expect(await fetchTmuxState(panelId)).toMatchObject({ tmuxActive: false });

  await page.evaluate((id) => {
    window.postMessage(
      {
        type: "at.panelToolbar.click",
        panelId: id,
        itemId: "tmux",
        command: "tmux",
      },
      "*",
    );
  }, panelId);

  const activeState = await waitForActiveTmuxState(panelId);
  expect(activeState.serverRunning).toBe(true);
  expect(activeState.tmuxActive).toBe(true);
  expect(activeState.matchMode).toBe("clientTty");
  expect(activeState.activeSessionName).toBe(rootDetachedSessionName);
  expect(activeState.sessions.length).toBeGreaterThan(0);
  expect(
    activeState.sessions.some((session) =>
      (session.windows ?? []).some((window) => (window.panes ?? []).length > 0),
    ),
  ).toBe(true);

  await page.waitForTimeout(5_500);
  await expect
    .poll(() => latestToolbarPatch(page, "tmux"))
    .toMatchObject({
      id: "tmux",
      color: "#22c55e",
      disabled: true,
    });
  await expect
    .poll(() => latestToolbarPatch(page, "tmux-manager"))
    .toMatchObject({
      id: "tmux-manager",
      visible: true,
      disabled: false,
    });
  await expect
    .poll(() => latestToolbarPatch(page, "tmux-new-window"))
    .toMatchObject({
      id: "tmux-new-window",
      visible: true,
      disabled: false,
    });

  await page.evaluate((id) => {
    window.postMessage(
      {
        type: "at.panelToolbar.click",
        panelId: id,
        itemId: "tmux-manager",
        command: "tmux:manager",
      },
      "*",
    );
  }, panelId);
  await expect
    .poll(() => latestPopupMessage(page))
    .toMatchObject({
      route: `/panels/tmux-manager?panelId=${encodeURIComponent(panelId)}`,
      title: "Tmux Manager",
    });

  const beforeWindowCount = activeState.sessions.reduce(
    (count, session) => count + (session.windows?.length ?? 0),
    0,
  );
  await page.evaluate((id) => {
    window.postMessage(
      {
        type: "at.panelToolbar.click",
        panelId: id,
        itemId: "tmux-new-window",
        command: "tmux:new-window",
      },
      "*",
    );
  }, panelId);
  await expect
    .poll(async () => {
      const state = await fetchTmuxState(panelId);
      return state.sessions.reduce((count, session) => count + (session.windows?.length ?? 0), 0);
    })
    .toBeGreaterThan(beforeWindowCount);

  await expect(page.locator("body")).not.toContainText("sessions should be nested with care");
  await expect(page.locator("body")).not.toContainText("TMUX_ACTIVE");
  await expect(page.locator("body")).not.toContainText("TMUX_TTY");

  const managerPage = await page.context().newPage();
  await managerPage.goto(
    `${MODULE_ORIGIN}/panels/tmux-manager?panelId=${encodeURIComponent(panelId)}&popupId=e2e-popup`,
  );

  await expect(managerPage.locator("#status-chip")).toContainText(/tmux|active/i);
  await expect(managerPage.locator("#status-chip")).not.toContainText("client detached");
  await expect(managerPage.locator("#tree-summary")).not.toContainText(/^0 sessions/);
  await expect(managerPage.locator("#tree-root")).not.toContainText(
    "No tmux sessions are available for this terminal.",
  );
  await managerPage.close();
});

async function installToolbarCapture(page: Page) {
  await page.addInitScript(() => {
    window.__toolbarPatches = [];
    window.__panelStatePatches = [];
    window.__popupMessages = [];
    window.addEventListener("message", (event) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "at.panelToolbar.patch" && Array.isArray(message.items)) {
        window.__toolbarPatches?.push(...message.items);
      }
      if (message.type === "at.panelState.patch") {
        window.__panelStatePatches?.push(message.panelState);
      }
      if (message.type === "at.panelPopup.open") {
        window.__popupMessages?.push(message);
      }
    });
  });
}

async function latestToolbarPatch(page: Page, itemId: string) {
  return page
    .evaluate(() => {
      const patches = window.__toolbarPatches ?? [];
      return [...patches].reverse();
    })
    .then((patches) => patches.find((patch) => patch.id === itemId) ?? null);
}

async function latestPopupMessage(page: Page) {
  return page.evaluate(() => {
    const messages = window.__popupMessages ?? [];
    return [...messages].reverse()[0] ?? null;
  });
}

async function waitForActiveTmuxState(panelId: string): Promise<TmuxStateResponse> {
  let lastState: TmuxStateResponse | null = null;
  await expect
    .poll(
      async () => {
        lastState = await fetchTmuxState(panelId);
        return Boolean(lastState?.tmuxActive);
      },
      {
        message: "tmux state should report tmux as active with sessions",
        timeout: 20_000,
        intervals: [250, 500, 1_000],
      },
    )
    .toBe(true);

  return lastState!;
}

async function fetchTmuxState(panelId: string): Promise<TmuxStateResponse> {
  const response = await fetch(
    `${MODULE_ORIGIN}/api/tmux/state?panelId=${encodeURIComponent(panelId)}&t=${Date.now()}`,
  );
  if (!response.ok) {
    throw new Error(`tmux state request failed with ${response.status}`);
  }
  return (await response.json()) as TmuxStateResponse;
}

async function readBaseVersion(): Promise<BaseVersionResponse | null> {
  try {
    const response = await fetch(
      `${MODULE_ORIGIN}/api/base/version?expectedVersion=${encodeURIComponent(EXPECTED_BASE_VERSION)}`,
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as BaseVersionResponse;
      return payload.version ? payload : { version: "mismatch" };
    }
    return (await response.json()) as BaseVersionResponse;
  } catch {
    return null;
  }
}

function createDetachedTmuxSession(sessionName: string, cwd: string, socketPath?: string) {
  if (socketPath) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  }
  execFileSync(
    "tmux",
    [...tmuxSocketArgs(socketPath), "new-session", "-d", "-s", sessionName, "-c", cwd],
    {
      env: {
        ...process.env,
        TMUX: "",
        TMUX_PANE: "",
      },
      stdio: "ignore",
    },
  );
  tmuxSessionsToCleanup.add({ sessionName, socketPath });
}

function cleanupTmuxSessions() {
  for (const { sessionName, socketPath } of tmuxSessionsToCleanup) {
    try {
      execFileSync("tmux", [...tmuxSocketArgs(socketPath), "kill-session", "-t", sessionName], {
        env: {
          ...process.env,
          TMUX: "",
          TMUX_PANE: "",
        },
        stdio: "ignore",
      });
    } catch {
      // The tested terminal may have already changed the server state.
    }
  }
  tmuxSessionsToCleanup.clear();
}

function tmuxSocketArgs(socketPath?: string): string[] {
  return socketPath ? ["-S", socketPath] : [];
}

function isolatedTmuxSocketPath(panelId: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return path.join("/tmp", `tmux-${uid}`, `aaa-${panelId}`);
}

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
