import { getState, sleep, resetRecoveryState } from "./state.js";
import { isAutoModeRunning } from "./probe.js";
import { clearLastToolInvocationError } from "./clear-tool-error.js";
import { extractText } from "./extract-text.js";
import { isUserCancellation } from "./user-cancellation.js";
import { shouldRecover } from "./should-recover.js";
import {
  finishRepairFlow,
  formatRepairFailure,
  formatRetryPrompt,
  startRepairFlow,
} from "./repair-flow.js";

const parseEnvInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const RETRY_MAX = parseEnvInt("GUARDIAN_RETRY_MAX", 10);
const REPAIR_MAX = parseEnvInt("GUARDIAN_REPAIR_MAX", 5);
const BACKOFF_MS = parseEnvInt("GUARDIAN_BACKOFF_MS", 1000);
const BACKOFF_MAX_MS = parseEnvInt("GUARDIAN_BACKOFF_MAX_MS", 30000);

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

  const anyMsg = event?.messages?.find((message) => {
    const text = extractText(message?.errorMessage || message?.content || message?.message);
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

export function markNextAgentEndAsSessionSwitch(pi) {
  getState(pi).skipNextAgentEnd = true;
}

export function createAgentEndHandler(pi) {
  const handler = async (event, ctx) => {
    const state = getState(pi);

    if (state.skippingAgentEndThisTurn) {
      state.skippingAgentEndThisTurn = false;
      return;
    }

    const lastMsg = event.messages?.at(-1);

    if (isUserCancellation(lastMsg)) return;

    if (state.repairExhaustedThisTurn) {
      state.repairExhaustedThisTurn = false;
      ctx.ui?.notify?.("[Guardian] Repair exhausted. Returning control.", "error");
      return;
    }

    const needsRecovery = shouldRecover(lastMsg);
    const errorText = getErrorText(lastMsg, event);

    if (state.isFixing) {
      if (!needsRecovery) {
        await finishRepairFlow(pi, ctx, pi);
        return;
      }

      state.repairCount += 1;
      if (state.repairCount >= REPAIR_MAX) {
        ctx.ui?.notify?.("[Guardian] Repair failed. Halting.", "error");
        resetRecoveryState(pi);
        return;
      }

      ctx.ui?.notify?.(`[Guardian] Repair turn ${state.repairCount}/${REPAIR_MAX} failed.`, "warning");
      try {
        pi.sendUserMessage(formatRepairFailure(errorText), { deliverAs: "followUp" });
      } catch {
        pi.sendUserMessage(formatRepairFailure(errorText));
      }
      return;
    }

    if (!needsRecovery) {
      state.retryCount = 0;
      return;
    }

    state.retryCount += 1;
    if (state.retryCount <= RETRY_MAX) {
      const delayMs = Math.min(BACKOFF_MS * Math.pow(2, state.retryCount - 1), BACKOFF_MAX_MS);

      ctx.ui?.notify?.(`[Guardian] Error: ${errorText.slice(0, 150)}...`, "error");
      ctx.ui?.notify?.(
        `[Guardian] Retry ${state.retryCount}/${RETRY_MAX} in ${(delayMs / 1000).toFixed(1)}s`,
        "warning",
      );

      try {
        await sleep(pi, delayMs);
      } catch {
        ctx.ui?.notify?.("[Guardian] Retry cancelled.", "warning");
        return;
      }

      ctx.ui?.notify?.(`[Guardian] Retry ${state.retryCount}...`, "info");
      try {
        pi.sendUserMessage(formatRetryPrompt(errorText), { deliverAs: "followUp" });
      } catch {
        pi.sendUserMessage(formatRetryPrompt(errorText));
      }
      return;
    }

    // Budget exhausted: start repair flow regardless of session type
    await startRepairFlow(pi, ctx, "agent-end", errorText, pi);
  };

  handler.negotiate = async (event, ctx) => {
    const state = getState(pi);

    if (state.skipNextAgentEnd) {
      state.skipNextAgentEnd = false;
      resetRecoveryState(pi);
      state.skippingAgentEndThisTurn = true;
      ctx.absorb?.(isGsdExtension);
      return;
    }

    const lastMsg = event.messages?.at(-1);

    if (isUserCancellation(lastMsg)) return;

    const needsRecovery = shouldRecover(lastMsg);

    if (!needsRecovery) {
      if (state.retryCount > 0 || state.isFixing) {
        const cleared = await clearLastToolInvocationError();
        if (!cleared) {
          ctx.ui?.notify?.("[Guardian] Could not clear GSD lastToolInvocationError.", "warning");
        }
      }
      state.retryCount = 0;
      return;
    }

    if (state.isFixing) {
      state.repairCount += 1;
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
