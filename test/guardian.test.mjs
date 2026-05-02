import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { state, sleep, cancelSleepOnly, resetRecoveryState } from "../src/state.js";

const REPAIR_MAX = 5;
let _tmpDir = null;

// ── Temp GSD auto.js helpers ─────────────────────────────────────────────
// agent-end.js calls isAutoModeRunning() which probes for GSD's auto.js.
// We create a minimal auto.js in a temp directory so probe finds it.

function setupTempAuto() {
  _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-test-"));
  const gsdDir = path.join(_tmpDir, "extensions", "gsd");
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, "auto.js"),
    `export function getAutoDashboardData() {
  return { active: true, stepMode: false, paused: false };
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
  const handler = mod.createAgentEndHandler({ on: () => {} });
  return { handler, ctx: { absorb, ui: { notify } } };
}

// ── State machine ────────────────────────────────────────────────────────
describe("state machine", () => {
  it("starts with default values", () => {
    assert.equal(state.retryCount, 0);
    assert.equal(state.repairCount, 0);
    assert.equal(state.isFixing, false);
    assert.equal(state.repairExhaustedThisTurn, false);
    assert.equal(state.timer, null);
    assert.equal(state.rejecter, null);
  });

  it("sleep resolves after ms", async () => {
    const start = Date.now();
    await sleep(10);
    assert.ok(Date.now() - start >= 8);
    assert.equal(state.timer, null);
    assert.equal(state.rejecter, null);
  });

  it("cancelSleepOnly rejects sleep promise without resetting counters", async () => {
    state.retryCount = 5;
    state.repairCount = 3;
    state.isFixing = true;

    const p = sleep(5000);
    cancelSleepOnly();
    await assert.rejects(p, /User Aborted/);

    assert.equal(state.retryCount, 5);
    assert.equal(state.repairCount, 3);
    assert.equal(state.isFixing, true);

    resetRecoveryState();
  });

  it("resetRecoveryState clears all recovery fields", () => {
    state.retryCount = 5;
    state.repairCount = 3;
    state.isFixing = true;
    state.repairExhaustedThisTurn = true;

    resetRecoveryState();

    assert.equal(state.retryCount, 0);
    assert.equal(state.repairCount, 0);
    assert.equal(state.isFixing, false);
    assert.equal(state.repairExhaustedThisTurn, false);
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

// ── Negotiate absorb decisions ───────────────────────────────────────────
describe("agent-end negotiate — absorb decisions", () => {
  before(() => setupTempAuto());
  after(() => teardownTempAuto());

  it("does NOT absorb on success when not recovering", async () => {
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
  });

  it("clears state on success when recovering", async () => {
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();
    state.retryCount = 3;

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
    assert.equal(state.retryCount, 0, "retryCount should be reset");
  });

  it("resets state on repair exhaustion and does NOT absorb", async () => {
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();
    state.isFixing = true;
    state.repairCount = REPAIR_MAX - 1;

    await handler.negotiate(
      {
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "test" },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 0);
    assert.equal(state.repairExhaustedThisTurn, true);
    assert.equal(state.isFixing, false, "isFixing reset in negotiate");
    assert.equal(state.repairCount, 0, "repairCount reset");
    assert.equal(state.retryCount, 0, "retryCount reset");
  });

  it("absorbs on error during repair when not exhausted", async () => {
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();
    state.isFixing = true;
    state.repairCount = 2;

    await handler.negotiate(
      {
        messages: [
          { role: "assistant", stopReason: "error", errorMessage: "test" },
        ],
      },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1);
    assert.equal(state.repairCount, 3);
  });

  it("absorbs on error during retry phase (not fixing)", async () => {
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

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
    const handler = mod.createAgentEndHandler({ on: () => {} });
    state.repairExhaustedThisTurn = true;

    await handler(
      { messages: [{ role: "assistant", stopReason: "error" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(state.repairExhaustedThisTurn, false);
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
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();
    state.lastAutoMode = false;

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "test" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1, "current-turn manual errors should be retried");

    const sendUserMessage = mock.fn(() => {});
    const manualHandler = (await importFresh("../src/agent-end.js")).createAgentEndHandler({
      on: () => {},
      sendUserMessage,
    });

    await manualHandler(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "test" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(sendUserMessage.mock.calls.length, 1, "manual errors should issue retry prompt");
  });

  it("skips stale agent_end during session switch", async () => {
    const mod = await importFresh("../src/agent-end.js");
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

    mod.markNextAgentEndAsSessionSwitch();

    await handler.negotiate(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "old error" }] },
      ctx,
    );

    assert.equal(ctx.absorb.mock.calls.length, 1, "stale switch-turn agent_end should be swallowed");

    const sendUserMessage = mock.fn(() => {});
    const runHandler = mod.createAgentEndHandler({ on: () => {}, sendUserMessage });
    await runHandler(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "old error" }] },
      { ui: { notify: () => {} } },
    );

    assert.equal(sendUserMessage.mock.calls.length, 0, "stale switch-turn agent_end must not trigger retry");
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
      // Fresh import with temp auto.js
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
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

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
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();
    
    // Simulate auto-mode was running
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
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

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
    const { handler, ctx } = await createHandlerCtx();
    resetRecoveryState();

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

  it("triggers repair on warning notifications in auto-mode", async () => {
    const { setupNotificationListener } = await import("../src/notification-listener.js");
    
    const sendUserMessage = mock.fn(() => {});
    const notify = mock.fn(() => {});
    const pi = {
      on: (event, handler) => {
        if (event === "notification") {
          setTimeout(() => handler({ 
            kind: "warning", 
            content: "Milestone M013 has planned operational verification", 
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
});
