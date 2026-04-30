import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { state, sleep, abort } from "../src/state.js";

describe("state machine", () => {
  it("starts with default values", () => {
    assert.equal(state.retryCount, 0);
    assert.equal(state.repairCount, 0);
    assert.equal(state.isFixing, false);
    assert.equal(state.suppressNextNewSession, false);
    assert.equal(state.timer, null);
    assert.equal(state.rejecter, null);
  });

  it("sleep resolves after ms", async () => {
    const start = Date.now();
    await sleep(10);
    assert.ok(Date.now() - start >= 8); // allow 2ms jitter
    assert.equal(state.timer, null);
    assert.equal(state.rejecter, null);
  });

  it("abort rejects sleep promise", async () => {
    const p = sleep(5000);
    abort();
    await assert.rejects(p, /User Aborted/);
    assert.equal(state.retryCount, 0);
    assert.equal(state.isFixing, false);
  });

  it("abort clears all fields", () => {
    state.retryCount = 5;
    state.repairCount = 3;
    state.isFixing = true;
    state.suppressNextNewSession = true;
    abort();
    assert.equal(state.retryCount, 0);
    assert.equal(state.repairCount, 0);
    assert.equal(state.isFixing, false);
    assert.equal(state.suppressNextNewSession, false);
  });
});

describe("agent-end handler factory", () => {
  it("returns a function with .negotiate property", async () => {
    const fakePi = { on: () => {} };
    const { createAgentEndHandler } = await import("../src/agent-end.js");
    const handler = createAgentEndHandler(fakePi);
    assert.equal(typeof handler, "function");
    assert.equal(typeof handler.negotiate, "function");
  });
});

describe("session-hijack factory", () => {
  it("returns a function", async () => {
    const fakePi = { on: () => {} };
    const { createSessionHijack } = await import("../src/session-hijack.js");
    const hijack = createSessionHijack(fakePi);
    assert.equal(typeof hijack, "function");
  });

  it("patches ctx.newSession when suppressNextNewSession is set", () => {
    const { createSessionHijack } = await import("../src/session-hijack.js");
    const notify = mock.fn();
    const ctx = {
      newSession: async () => ({ cancelled: true }),
      ui: { notify },
    };

    const hijack = createSessionHijack({});
    hijack({}, ctx);

    assert.ok(ctx.newSession.__guardianPatched);

    state.suppressNextNewSession = true;
    const urs = await ctx.newSession();
    assert.equal(urs.cancelled, false);
    assert.equal(state.suppressNextNewSession, false);
    assert.equal(notify.mock.calls.length, 1);
  });
});

describe("probe", () => {
  it("returns false when no auto.js found", async () => {
    const origHome = process.env.HOME;
    process.env.HOME = "/nonexistent";
    const { isAutoModeRunning } = await import("../src/probe.js");
    const result = await isAutoModeRunning();
    assert.equal(result, false);
  });
});
