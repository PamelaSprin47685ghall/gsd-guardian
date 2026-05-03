import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getState, sleep, cancelSleepOnly, resetRecoveryState, resetForNewSession } from "../src/state.js";

const REPAIR_MAX = 5;
let _tmpDir = null;

// ── Temp GSD auto.js helpers ─────────────────────────────────────────────
function setupTempAuto() {
  _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-test-"));
  const gsdDir = path.join(_tmpDir, "extensions", "gsd");
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, "auto.js"),
    `export function getAutoDashboardData() {
  return { active: true, stepMode: false, paused: false };
}\n`,
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

// Force a fresh ESM module evaluation via cache-busting query param
function importFresh(modulePath) {
  const url = new URL(modulePath, import.meta.url);
  url.search = `?t=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return import(url.href);
}

async function createHandlerCtx() {
  const mod = await importFresh("../src/agent-end.js");
  const absorb = mock.fn((_fn) => {});
  const notify = mock.fn(() => {});
  const pi = { on: () => {}, sendUserMessage: mock.fn(() => {}) };
  const handler = mod.createAgentEndHandler(pi);
  return { handler, ctx: { absorb, ui: { notify } }, pi, mod };
}

// ── State machine ────────────────────────────────────────────────────────
describe("state machine", () => {
  const mockPi = {};

  it("starts with default values", () => {
    const s = getState(mockPi);
    assert.equal(s.retryCount, 0);
    assert.equal(s.repairCount, 0);
    assert.equal(s.isFixing, false);
    assert.equal(s.repairExhaustedThisTurn, false);
    assert.equal(s.timer, null);
    assert.equal(s.rejecter, null);
  });

  it("sleep resolves after ms", async () => {
    const start = Date.now();
    await sleep(mockPi, 10);
    assert.ok(Date.now() - start >= 8);
    const s = getState(mockPi);
    assert.equal(s.timer, null);
    assert.equal(s.rejecter, null);
  });

  it("cancelSleepOnly rejects sleep promise without resetting counters", async () => {
    const s = getState(mockPi);
    s.retryCount = 5;
    s.repairCount = 3;
    s.isFixing = true;

    const p = sleep(mockPi, 5000);
    cancelSleepOnly(mockPi);
    await assert.rejects(p, /User Aborted/);

    assert.equal(s.retryCount, 5);
    assert.equal(s.repairCount, 3);
    assert.equal(s.isFixing, true);

    resetRecoveryState(mockPi);
  });

  it("resetRecoveryState clears all recovery fields", () => {
    const s = getState(mockPi);
    s.retryCount = 5;
    s.repairCount = 3;
    s.isFixing = true;
    s.repairExhaustedThisTurn = true;

    resetRecoveryState(mockPi);

    assert.equal(s.retryCount, 0);
    assert.equal(s.repairCount, 0);
    assert.equal(s.isFixing, false);
    assert.equal(s.repairExhaustedThisTurn, false);
  });

  it("resetForNewSession cancels in-flight sleep and resets all fields", async () => {
    const s = getState(mockPi);
    s.retryCount = 5;
    s.isFixing = true;
    const spyRejecter = mock.fn();
    s.timer = setTimeout(() => {}, 10000);
    s.rejecter = spyRejecter;

    resetForNewSession(mockPi);

    assert.equal(s.retryCount, 0);
    assert.equal(s.isFixing, false);
    assert.equal(s.timer, null);
    assert.equal(s.rejecter, null);
    assert.equal(spyRejecter.mock.callCount(), 1);
  });
});

// ── Handler factory ──────────────────────────────────────────────────────
describe("agent-end handler factory", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("returns a function with .negotiate property", async () => {
    const mod = await importFresh("../src/agent-end.js");
    const handler = mod.createAgentEndHandler({ on: () => {} });
    assert.equal(typeof handler, "function");
    assert.equal(typeof handler.negotiate, "function");
  });
});

describe("agent-end repair completion semantics", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("does NOT announce resumed or send /gsd auto when auto is already active", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    const s = getState(pi);
    resetRecoveryState(pi);
    s.isFixing = true;
    s.resumeAutoAfterRepair = true;

    await handler(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      { ui: { notify: ctx.ui.notify } },
    );

    const notifications = ctx.ui.notify.mock.calls.map((call) => String(call.arguments?.[0] ?? ""));
    assert.ok(notifications.some((line) => line.includes("Repair done")), "must report repair completion");
    assert.equal(
      notifications.some((line) => line.includes("Auto-mode resumed")),
      false,
      "must not claim resumed when auto is already running",
    );
    assert.equal(pi.sendUserMessage.mock.calls.length, 0, "must not send /gsd auto when already active");
  });
});

// ── Negotiate absorb decisions ───────────────────────────────────────────
describe("agent-end negotiate — absorb decisions", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("does NOT absorb on success when not recovering", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
  });

  it("clears state on success when recovering", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    getState(pi).retryCount = 3;

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
    assert.equal(getState(pi).retryCount, 0, "retryCount should be reset");
  });

  it("does NOT absorb successful turns while fixing", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    getState(pi).isFixing = true;
    getState(pi).resumeAutoAfterRepair = true;

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0, "successful turns must pass through to GSD");
  });

  it("resets state on repair exhaustion and does NOT absorb", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    getState(pi).isFixing = true;
    getState(pi).repairCount = REPAIR_MAX - 1;

    await handler.negotiate(
      {
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "test" },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
    assert.equal(getState(pi).repairExhaustedThisTurn, true);
    assert.equal(getState(pi).isFixing, false, "isFixing reset in negotiate");
    assert.equal(getState(pi).repairCount, 0, "repairCount reset");
    assert.equal(getState(pi).retryCount, 0, "retryCount reset");
  });

  it("absorbs on error during repair when not exhausted", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    getState(pi).isFixing = true;
    getState(pi).repairCount = 2;

    await handler.negotiate(
      {
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "test" },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1);
    assert.equal(getState(pi).repairCount, 3);
  });

  it("absorbs on error during retry phase (not fixing)", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    await handler.negotiate(
      {
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "test" },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1);
  });
});

// ── Handler repair exhausted flag ───────────────────────────────────────
describe("agent-end handler — repair exhausted flag consumption", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("consumes repairExhaustedThisTurn before guardAutoMode", async () => {
    const mod = await importFresh("../src/agent-end.js");
    const pi = { on: () => {} };
    const handler = mod.createAgentEndHandler(pi);
    getState(pi).repairExhaustedThisTurn = true;

    await handler(
      { messages: [{ role: "assistant", stopReason: "error" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(getState(pi).repairExhaustedThisTurn, false);
  });
});

// ── clear-tool-error ─────────────────────────────────────────────────────
describe("clear-tool-error module", () => {
  it("returns false when no auto-runtime-state.js found", async () => {
    const origGSD = process.env.GSD_CODING_AGENT_DIR;
    const origHome = process.env.HOME;
    process.env.GSD_CODING_AGENT_DIR = "/nonexistent";
    process.env.HOME = "/nonexistent";

    try {
      const { clearLastToolInvocationError } = await import(
        "../src/clear-tool-error.js"
      );
      const result = await clearLastToolInvocationError();
      assert.equal(result, false);
    } finally {
      process.env.GSD_CODING_AGENT_DIR = origGSD;
      process.env.HOME = origHome;
    }
  });
});

// ── Mode Switch ─────────────────────────────────────────────────────────
describe("agent-end mode switch", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("retries current-turn manual errors", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    getState(pi).lastAutoMode = false;

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "test" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1, "current-turn manual errors should be retried");

    const manualHandler = (await importFresh("../src/agent-end.js")).createAgentEndHandler(pi);

    await manualHandler(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "test" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(pi.sendUserMessage.mock.calls.length, 1, "manual errors should issue retry prompt");
  });

  it("skips stale agent_end during session switch", async () => {
    const mod = await importFresh("../src/agent-end.js");
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    mod.markNextAgentEndAsSessionSwitch(pi);

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "old error" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1, "stale switch-turn agent_end should be swallowed");

    await handler(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "old error" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(pi.sendUserMessage.mock.calls.length, 0, "stale switch-turn agent_end must not trigger retry");
  });
});

// ── Probe ────────────────────────────────────────────────────────────────
describe("probe", () => {
  it("returns false when no auto.js found", async () => {
    const origHome = process.env.HOME;
    const origGSD = process.env.GSD_CODING_AGENT_DIR;
    process.env.HOME = "/nonexistent";
    delete process.env.GSD_CODING_AGENT_DIR;

    try {
      const { isAutoModeRunning } = await import("../src/probe.js");
      const result = await isAutoModeRunning();
      assert.equal(result, false);
    } finally {
      process.env.HOME = origHome;
      if (origGSD) process.env.GSD_CODING_AGENT_DIR = origGSD;
    }
  });

  it("returns true when mock auto.js exists", async () => {
    const origGSD = process.env.GSD_CODING_AGENT_DIR;
    setupTempAuto();
    try {
      const url = new URL("../src/probe.js", import.meta.url);
      url.search = `?t=${Date.now()}_probe`;
      const { isAutoModeRunning } = await import(url.href);
      const result = await isAutoModeRunning();
      assert.equal(result, true);
    } finally {
      teardownTempAuto();
      if (origGSD) process.env.GSD_CODING_AGENT_DIR = origGSD;
    }
  });
});

// ── Non-user-cancellation errors ────────────────────────────────────────
describe("Non-user-cancellation errors", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("does NOT absorb user cancellation (aborted + empty content)", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    await handler.negotiate(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            content: [],
          },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
  });

  it("absorbs aborted with error message (not user cancellation)", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);
    
    await handler.negotiate({ messages: [{ role: "assistant", stopReason: "end_turn" }] }, ctx);

    await handler.negotiate(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Dispatch stop: validation failed"
          },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1);
  });

  it("does NOT absorb 'Operation aborted' (user cancellation)", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    await handler.negotiate(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Operation aborted"
          },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
  });

  it("absorbs validation failure (non-normal completion)", async () => {
    const { handler, ctx, pi } = await createHandlerCtx();
    resetRecoveryState(pi);

    await handler.negotiate(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Milestone M013 has planned operational verification but the validation output does not address it."
          },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1, "validation failures should be absorbed and recovered");
  });
});

// ── Notification warning handling ───────────────────────────────────────
describe("notification-listener warning handling", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("triggers repair on auto-mode validation warning notifications", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");
    
    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({ 
            kind: "warning", 
            content: "Milestone M013 has planned operational verification but the validation output does not address it.", 
            id: "test-warning-1" 
          }), 10);
        }
      },
      sendUserMessage,
      ui: { notify }
    };

    setupNotificationListener(pi);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.ok(sendUserMessage.mock.calls.length > 0, "should trigger repair on warning notifications");
  });

  it("ignores unknown auto-loop phase warnings from extension ecosystem", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");

    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({
            severity: "warning",
            source: "workflow-logger",
            message: "[ecosystem] unknown auto-loop phase: dag-execution",
            id: "test-warning-unknown-phase",
          }), 10);
        }
      },
      sendUserMessage,
      ui: { notify },
    };

    setupNotificationListener(pi);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(sendUserMessage.mock.calls.length, 0, "unknown phase warning should not trigger repair");
  });

  it("ignores user-cancellation warning text", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");

    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({
            severity: "warning",
            message: "Operation aborted",
            id: "test-warning-operation-aborted",
          }), 10);
        }
      },
      sendUserMessage,
      ui: { notify },
    };

    setupNotificationListener(pi);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(sendUserMessage.mock.calls.length, 0, "user cancellation warning should not trigger repair");
  });

  it("ignores guardian self-generated retry warning text", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");

    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({
            severity: "warning",
            message: "[Guardian] Retry 1/10 in 1.0s",
            id: "test-warning-guardian-retry",
          }), 10);
        }
      },
      sendUserMessage,
      ui: { notify },
    };

    setupNotificationListener(pi);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(sendUserMessage.mock.calls.length, 0, "guardian self-retry warning must not trigger repair");
  });

  it("repair flow no longer injects /gsd stop", async () => {
    const { startRepairFlow } = await import("../src/repair-flow.js");

    const mockPi = {};
    resetRecoveryState(mockPi);

    const sendUserMessage = mock.fn(() => {});
    const pi = { sendUserMessage };
    const ctx = { ui: { notify: () => {} } };

    await startRepairFlow(pi, ctx, "notification", "synthetic failure");

    const allMessages = sendUserMessage.mock.calls.map((call) => String(call.arguments?.[0] ?? ""));
    assert.equal(allMessages.some((msg) => msg.trim() === "/gsd stop"), false, "must not emit /gsd stop");
    assert.equal(allMessages.length >= 1, true, "should still send repair prompt");
  });
});
