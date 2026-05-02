import { beginRepairSession, resetRecoveryState, state } from "./state.js";
import { isAutoModeRunning } from "./probe.js";

function formatError(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function buildRepairPrompt(source, message) {
  const header = source === "watchdog"
    ? "Auto-mode paused due to dispatch-stop."
    : "Auto-mode paused due to recoverable error.";
  return [
    header,
    "",
    "Error:",
    "```",
    message,
    "```",
    "",
    "Diagnose and fix. Reply when done; Guardian will resume auto-mode after the fix.",
  ].join("\n");
}

function queueUserMessage(pi, content, deliverAs = "followUp") {
  try {
    pi.sendUserMessage(content, { deliverAs });
  } catch {
    pi.sendUserMessage(content);
  }
}

export async function startRepairFlow(pi, ctx, source, message) {
  if (state.isFixing) return false;

  const isAuto = await isAutoModeRunning();
  if (!isAuto) return false;

  beginRepairSession(source);

  const startText = source === "watchdog"
    ? "🔥 [Guardian] Dispatch-stop detected. Starting repair..."
    : "🔥 [Guardian] Auto-mode paused. Starting repair...";
  ctx?.ui?.notify?.(startText, "error");

  queueUserMessage(pi, "/gsd stop", "steer");
  queueUserMessage(pi, buildRepairPrompt(source, message), "followUp");

  return true;
}

export async function finishRepairFlow(pi, ctx) {
  const shouldResumeAuto = state.resumeAutoAfterRepair;
  resetRecoveryState();

  ctx.ui.notify("✅ [Guardian] Repair done.", "success");
  if (!shouldResumeAuto) return;

  const isAuto = await isAutoModeRunning();
  if (isAuto) {
    ctx.ui.notify("ℹ️ [Guardian] Auto-mode already running.", "info");
    return;
  }

  ctx.ui.notify("▶️ [Guardian] Auto-mode resumed.", "success");
  queueUserMessage(pi, "/gsd auto", "followUp");
}

export function formatRepairFailure(errorText) {
  return `Repair failed:\n${formatError(errorText)}\nFix this and continue.`;
}

export function formatRetryPrompt(errorText) {
  return `**EXECUTION ERROR**\nFailed:\n${formatError(errorText)}\nFix params/logic and retry the same step.`;
}
