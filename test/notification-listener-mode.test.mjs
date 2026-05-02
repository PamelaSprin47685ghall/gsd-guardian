import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let _tmpDir = null;

function setupTempAuto(active = true) {
  _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-notif-test-"));
  const gsdDir = path.join(_tmpDir, "extensions", "gsd");
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, "auto.js"),
    `export function getAutoDashboardData() {
  return { active: ${active}, stepMode: false, paused: false };
}
`,
  );
  process.env.GSD_CODING_AGENT_DIR = _tmpDir;
}

function teardownTempAuto() {
  if (_tmpDir) {
    fs.rmSync(_tmpDir, { recursive: true, force: true });
    _tmpDir = null;
  }
  delete process.env.GSD_CODING_AGENT_DIR;
}

describe("notification-listener auto-mode check", () => {
  before(() => setupTempAuto(true));
  after(() => teardownTempAuto());

  it("triggers repair in auto-mode", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");
    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({ kind: "error", errorMessage: "test error", id: "test-1" }), 10);
        }
      },
      sendUserMessage,
      ui: { notify }
    };

    setupNotificationListener(pi);
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(sendUserMessage.mock.calls.length > 0, "should trigger repair in auto-mode");
  });
});

describe("notification-listener manual mode", () => {
  before(() => setupTempAuto(false));
  after(() => teardownTempAuto());

  it("does NOT trigger repair in manual mode", async () => {
    const url = new URL("../src/notification-listener.js", import.meta.url);
    url.search = `?t=${Date.now()}_manual`;
    const { setupNotificationListener } = await import(url.href);
    
    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({ kind: "error", errorMessage: "test error", id: "test-2" }), 10);
        }
      },
      sendUserMessage,
      ui: { notify }
    };

    setupNotificationListener(pi);
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(sendUserMessage.mock.calls.length, 0, "should NOT trigger repair in manual mode");
  });
});
