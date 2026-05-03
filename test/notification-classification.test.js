import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRecoverFromNotification } from "../src/notification-listener.js";

describe("notification classification", () => {
  it("ignores benign sibling extension chatter", () => {
    const benignMessages = [
      "magic-todo: session_start restored 0 todos and 0 backlog reports.",
      "pruner: HINTS load warning — missing optional project file",
      "[dag] dispatch registry synchronized.",
      "[dag] spawning tasks: T01, T02",
      "[dag] completed 1/2",
    ];

    for (const message of benignMessages) {
      assert.equal(
        shouldRecoverFromNotification({ severity: "warning", message }, message),
        false,
        message,
      );
    }
  });

  it("lets critical DAG notifications trigger recovery before benign DAG prefixes can mask them", () => {
    const recoverableMessages = [
      "[DAG] Task T01 error: missing gsd_task_complete tool — FAILED",
      "[DAG] CRITICAL: failed to write REPLAN-TRIGGER — slice replan will not be triggered automatically: EACCES",
    ];

    for (const message of recoverableMessages) {
      assert.equal(
        shouldRecoverFromNotification({ severity: "warning", message }, message),
        true,
        message,
      );
    }
  });
});
