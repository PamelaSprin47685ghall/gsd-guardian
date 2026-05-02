import { state } from "./state.js";
import { isAutoModeRunning } from "./probe.js";
import { getLastDispatchStopReason } from "./journal-reader.js";

let watchdogTimer = null;
let agentStarted = false;

/**
 * Start watchdog: if auto-mode is running but no agent starts within timeout,
 * check for dispatch-stop and trigger repair.
 */
export function startWatchdog(pi, ctx, basePath, timeoutMs = 3000) {
  // Clear any existing watchdog
  stopWatchdog();

  agentStarted = false;

  watchdogTimer = setTimeout(async () => {
    watchdogTimer = null;

    // If agent started, all good
    if (agentStarted) return;

    // Check if auto-mode is still running
    const isAuto = await isAutoModeRunning();
    if (!isAuto) return;

    // Check if we're already fixing
    if (state.isFixing) return;

    // Check for dispatch-stop in journal
    const reason = getLastDispatchStopReason(basePath);
    if (!reason) return;

    // Start repair
    state.isFixing = true;
    state.resumeAutoAfterRepair = true;
    state.retryCount = 0;
    state.repairCount = 0;

    ctx?.ui?.notify?.("🔥 [Guardian] Dispatch-stop detected. Starting repair...", "error");

    pi.sendUserMessage(
      [
        "Auto-mode paused due to dispatch-stop.",
        "",
        "Error:",
        "```",
        reason,
        "```",
        "",
        "Diagnose and fix. Reply when done; Guardian will resume auto-mode after the fix.",
      ].join("\n")
    );
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
