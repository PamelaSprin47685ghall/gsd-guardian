import { isAutoModeRunning } from "./probe.js";
import { getLastDispatchStopReason } from "./journal-reader.js";
import { state } from "./state.js";
import { startRepairFlow } from "./repair-flow.js";

let watchdogTimer = null;
let agentStarted = false;

/**
 * Start watchdog: if auto-mode is running but no agent starts within timeout,
 * check for dispatch-stop and trigger repair.
 */
export function startWatchdog(pi, ctx, basePath, timeoutMs = 8000) {
  stopWatchdog();

  agentStarted = false;

  watchdogTimer = setTimeout(async () => {
    watchdogTimer = null;

    if (agentStarted) return;

    const isAuto = await isAutoModeRunning();
    if (!isAuto) return;

    if (state.isFixing) return;

    const reason = getLastDispatchStopReason(basePath);
    if (!reason) return;

    await startRepairFlow(pi, ctx, "watchdog", reason);
  }, timeoutMs);
}

/**
 * Stop watchdog timer.
 */
export function stopWatchdog() {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Mark that agent has started (called from before_agent_start hook).
 */
export function markAgentStarted() {
  agentStarted = true;
}
