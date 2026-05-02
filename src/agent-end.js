import { state, sleep, resetRecoveryState } from "./state.js";
import { isAutoModeRunning } from "./probe.js";
import { clearLastToolInvocationError } from "./clear-tool-error.js";
import { resumePausedAuto } from "./resume-auto.js";
import { extractText } from "./extract-text.js";
import { isUserCancellation } from "./user-cancellation.js";
import { shouldRecover } from "./should-recover.js";

const RETRY_MAX = Number(process.env.GUARDIAN_RETRY_MAX) || 10;
const REPAIR_MAX = Number(process.env.GUARDIAN_REPAIR_MAX) || 5;
const BACKOFF_MS = Number(process.env.GUARDIAN_BACKOFF_MS) || 1000;
const BACKOFF_MAX_MS = Number(process.env.GUARDIAN_BACKOFF_MAX_MS) || 30000;

function formatError(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function getErrorText(lastMsg, event) {
  const candidates = [
    lastMsg?.errorMessage,
    lastMsg?.content,
    lastMsg?.message,
  ];

  for (const candidate of candidates) {
    const text = extractText(candidate);
    if (text) return text;
  }

  const anyMsg = event?.messages?.find(m => {
    const text = extractText(m?.errorMessage || m?.content || m?.message);
    return text && text.length > 0;
  });

  if (anyMsg) {
    for (const candidate of [anyMsg.errorMessage, anyMsg.content, anyMsg.message]) {
      const text = extractText(candidate);
      if (text) return text;
    }
  }

  return `Auto-mode stopped (stopReason: ${lastMsg?.stopReason || "unknown"}, messageCount: ${event?.messages?.length || 0})`;
}

const isGsdExtension = (extPath) =>
  extPath.includes("extensions") && (extPath.includes("/gsd/") || extPath.endsWith("/gsd"));

function startRepair(pi, ctx, errorText) {
  state.isFixing = true;
  state.resumeAutoAfterRepair = true;
  state.retryCount = 0;
  state.repairCount = 0;

  ctx.ui.notify("🔥 [Guardian] Auto-mode paused. Starting repair...", "error");
  pi.sendUserMessage(
    `Auto-mode paused.\n\nError:\n${formatError(errorText)}\n\nDiagnose, fix, and reply. I will resume auto-mode after the fix.`,
  );
}

async function finishRepair(pi, ctx) {
  const shouldResumeAuto = state.resumeAutoAfterRepair;
  resetRecoveryState();

  ctx.ui.notify("✅ [Guardian] Repair done.", "success");
  if (!shouldResumeAuto) return;

  const result = await resumePausedAuto(pi, ctx);
  if (result === "resumed" || result === "already-active") {
    ctx.ui.notify("▶️ [Guardian] Auto-mode resumed.", "success");
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

    // User cancellation - do not intervene
    if (isUserCancellation(lastMsg)) return;

    if (state.repairExhaustedThisTurn) {
      state.repairExhaustedThisTurn = false;
      ctx.ui.notify("💀 [Guardian] Repair exhausted. Returning control.", "error");
      return;
    }

    const needsRecovery = shouldRecover(lastMsg);
    const errorText = getErrorText(lastMsg, event);

    if (state.isFixing) {
      if (!needsRecovery) {
        await finishRepair(pi, ctx);
        return;
      }

      if (state.repairCount >= REPAIR_MAX) {
        ctx.ui.notify("💀 [Guardian] Repair failed. Halting.", "error");
        resetRecoveryState();
        return;
      }

      state.repairCount++;
      ctx.ui.notify(`❌ [Guardian] Repair turn ${state.repairCount}/${REPAIR_MAX} failed.`, "warning");
      pi.sendUserMessage(`Repair failed:\n${formatError(errorText)}\nFix this and continue.`);
      return;
    }

    if (!needsRecovery) {
      state.retryCount = 0;
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

      ctx.ui.notify(`🚀 Retry ${state.retryCount}...`, "info");
      pi.sendUserMessage(
        `**EXECUTION ERROR**\nFailed:\n${formatError(errorText)}\nFix params/logic and retry the same step.`,
      );
      return;
    }

    const isAuto = await isAutoModeRunning();
    if (!isAuto) {
      ctx.ui.notify("💀 [Guardian] Manual retry budget exhausted.", "error");
      resetRecoveryState();
      return;
    }

    startRepair(pi, ctx, errorText);
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

    // User cancellation - do not absorb
    if (isUserCancellation(lastMsg)) return;

    const needsRecovery = shouldRecover(lastMsg);

    if (!needsRecovery) {
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
