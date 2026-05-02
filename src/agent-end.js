import { state, sleep, resetRecoveryState } from "./state.js";
import { isAutoModeRunning } from "./probe.js";
import { clearLastToolInvocationError } from "./clear-tool-error.js";
import { resumePausedAuto } from "./resume-auto.js";

const RETRY_MAX = 10;
const REPAIR_MAX = 5;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 30000;

function formatError(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

export function isGsdValidationWarning(message) {
  let text = message?.errorMessage || message?.content || message?.message || "";
  if (Array.isArray(text)) {
    text = text.map(part => part?.text || (typeof part === "string" ? part : "")).join("");
  }
  if (typeof text !== "string") return false;

  return (
    text.includes("Warning: Milestone") &&
    (text.includes("validation output does not address it") ||
      text.includes("verification class awareness") ||
      text.includes("operational compliance"))
  );
}

function hasGsdValidationWarning(lastMsg, event) {
  return isGsdValidationWarning(lastMsg) || !!event?.messages?.some(isGsdValidationWarning);
}

function isErrorTurn(lastMsg, event) {
  return lastMsg?.stopReason === "error" || hasGsdValidationWarning(lastMsg, event);
}

function getErrorText(lastMsg, event) {
  if (lastMsg?.errorMessage) return lastMsg.errorMessage;
  if (isGsdValidationWarning(lastMsg)) return lastMsg.content || lastMsg.message;
  const warning = event?.messages?.find(isGsdValidationWarning);
  return warning?.errorMessage || warning?.content || warning?.message || "Unknown Schema or API Error";
}

const isGsdExtension = (extPath) =>
  extPath.includes("extensions") && (extPath.includes("/gsd/") || extPath.endsWith("/gsd"));

function startRepair(pi, ctx, errorText, { resumeAutoAfterRepair }) {
  state.isFixing = true;
  state.resumeAutoAfterRepair = resumeAutoAfterRepair;
  state.retryCount = 0;
  state.repairCount = 0;

  ctx.ui.notify(
    resumeAutoAfterRepair
      ? "🔥 [Guardian] GSD validation checkpoint detected. Starting repair before auto resume."
      : "🔥 10 retries exhausted. Entering LLM repair mode...",
    "error",
  );

  pi.sendUserMessage(
    `${resumeAutoAfterRepair ? "Auto-mode paused at a recoverable GSD validation checkpoint." : "Auto-mode paused after 10 consecutive failures."}\n\nError:\n${formatError(errorText)}\n\nDiagnose, fix, and reply. I will ${resumeAutoAfterRepair ? "resume auto-mode after the fix" : "continue the blocked step after the fix"}.`,
  );
}

async function finishRepair(pi, ctx) {
  const shouldResumeAuto = state.resumeAutoAfterRepair;
  resetRecoveryState();

  ctx.ui.notify("✅ [Guardian] LLM repair done.", "success");
  if (!shouldResumeAuto) return;

  const result = await resumePausedAuto(pi, ctx);
  if (result === "resumed" || result === "already-active") {
    ctx.ui.notify("▶️ [Guardian] Auto-mode resumed after repair.", "success");
    return;
  }

  ctx.ui.notify(
    `[Guardian] Repair completed, but auto-mode was not resumable (${result}). Run /gsd auto to resume manually.`,
    "warning",
  );
}

export function markNextAgentEndAsSessionSwitch() {
  state.skipNextAgentEnd = true;
}

export function createAgentEndHandler(pi) {
  const handler = async (event, ctx) => {
    if (state.skippingAgentEndThisTurn) {
      state.skippingAgentEndThisTurn = false;
      return;
    }

    const lastMsg = event.messages?.at(-1);
    const hasValidationWarning = hasGsdValidationWarning(lastMsg, event);
    if (lastMsg?.stopReason === "aborted" && !hasValidationWarning) return;

    if (state.repairExhaustedThisTurn) {
      state.repairExhaustedThisTurn = false;
      ctx.ui.notify("💀 [Guardian] Repair exhausted. GSD handling final failure.", "error");
      return;
    }

    const isAuto = await isAutoModeRunning();
    if (state.lastAutoMode !== null && state.lastAutoMode !== isAuto) {
      state.retryCount = 0;
    }
    state.lastAutoMode = isAuto;

    const isError = isErrorTurn(lastMsg, event);
    const errorText = getErrorText(lastMsg, event);

    if (state.isFixing) {
      if (!isError) {
        await finishRepair(pi, ctx);
        return;
      }

      if (state.repairCount >= REPAIR_MAX) {
        ctx.ui.notify("💀 [Guardian] Repair failed. Halting.", "error");
        resetRecoveryState();
        return;
      }

      ctx.ui.notify(`❌ [Guardian] Repair turn ${state.repairCount}/${REPAIR_MAX} failed.`, "warning");
      pi.sendUserMessage(`Repair failed:\n${formatError(errorText)}\nFix this and continue.`);
      return;
    }

    if (!isError) {
      state.retryCount = 0;
      return;
    }

    if (hasValidationWarning) {
      startRepair(pi, ctx, errorText, { resumeAutoAfterRepair: true });
      return;
    }

    state.retryCount++;
    if (state.retryCount <= RETRY_MAX) {
      const delayMs = Math.min(BACKOFF_MS * Math.pow(2, state.retryCount - 1), BACKOFF_MAX_MS);

      ctx.ui.notify(`⚠️ [Guardian] Error: ${errorText.slice(0, 150)}...`, "error");
      ctx.ui.notify(
        `⏳ Retry ${state.retryCount}/${RETRY_MAX} in ${(delayMs / 1000).toFixed(1)}s (Esc=cancel)`,
        "warning",
      );

      try {
        await sleep(delayMs);
      } catch {
        ctx.ui.notify("🛑 [Guardian] Retry cancelled.", "warning");
        return;
      }

      if (isAuto && !(await isAutoModeRunning())) {
        ctx.ui.notify("⏹️ [Guardian] Auto-mode stopped during backoff.", "warning");
        return;
      }

      ctx.ui.notify(`🚀 Retry ${state.retryCount}...`, "info");
      pi.sendUserMessage(
        `**EXECUTION ERROR**\nFailed:\n${formatError(errorText)}\nFix params/logic and retry the same step.`,
      );
      return;
    }

    if (!isAuto) {
      ctx.ui.notify("💀 [Guardian] Manual retry budget exhausted. Returning control to user.", "error");
      resetRecoveryState();
      return;
    }

    startRepair(pi, ctx, errorText, { resumeAutoAfterRepair: false });
  };

  handler.negotiate = async (event, ctx) => {
    if (state.skipNextAgentEnd) {
      state.skipNextAgentEnd = false;
      state.skippingAgentEndThisTurn = true;
      state.retryCount = 0;
      state.repairCount = 0;
      state.isFixing = false;
      state.resumeAutoAfterRepair = false;
      state.repairExhaustedThisTurn = false;
      ctx.absorb?.(isGsdExtension);
      return;
    }

    const lastMsg = event.messages?.at(-1);
    const hasValidationWarning = hasGsdValidationWarning(lastMsg, event);
    if (lastMsg?.stopReason === "aborted" && !hasValidationWarning) return;

    const isAuto = await isAutoModeRunning();
    if (state.lastAutoMode !== null && state.lastAutoMode !== isAuto) {
      state.retryCount = 0;
    }
    state.lastAutoMode = isAuto;

    if (!isErrorTurn(lastMsg, event)) {
      if (state.retryCount > 0 || state.isFixing) {
        const cleared = await clearLastToolInvocationError();
        if (!cleared) {
          ctx.ui.notify?.("[Guardian] Could not clear GSD lastToolInvocationError.", "warning");
        }
      }

      if (!state.isFixing || !state.resumeAutoAfterRepair) {
        state.retryCount = 0;
        return;
      }
      ctx.absorb?.(isGsdExtension);
      return;
    }

    if (state.isFixing) {
      state.repairCount++;
      if (state.repairCount >= REPAIR_MAX) {
        state.repairExhaustedThisTurn = true;
        state.retryCount = 0;
        state.repairCount = 0;
        state.isFixing = false;
        state.resumeAutoAfterRepair = false;
        return;
      }
    }

    ctx.absorb?.(isGsdExtension);
  };

  return handler;
}
