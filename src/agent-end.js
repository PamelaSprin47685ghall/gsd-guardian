import { state, sleep } from "./state.js";
import { isAutoModeRunning } from "./probe.js";

const RETRY_MAX = 10;
const REPAIR_MAX = 5;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 30000;

function formatError(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function isErrorTurn(lastMsg) {
  return lastMsg?.role === "assistant" && lastMsg.stopReason === "error";
}

export function createAgentEndHandler(pi) {
  const handler = async (event, ctx) => {
    const lastMsg = event.messages?.at(-1);
    if (lastMsg?.stopReason === "aborted") return;

    const isError = isErrorTurn(lastMsg);
    const errorText = lastMsg?.errorMessage || "Unknown Schema or API Error";

    // Phase A — repair mode (after 10 retries exhausted, auto paused)
    if (state.isFixing) {
      if (!isError) {
        state.isFixing = false;
        state.repairCount = 0;
        ctx.ui.notify("✅ [Guardian] LLM repair done. Resuming auto-mode...", "success");
        state.suppressNextNewSession = true;
        setTimeout(() => pi.sendUserMessage("/gsd auto"), 1500);
        return;
      }

      state.repairCount++;
      if (state.repairCount > REPAIR_MAX) {
        ctx.ui.notify("💀 [Guardian] Repair failed 5 times. Halting.", "error");
        return;
      }

      ctx.ui.notify(`❌ [Guardian] Repair turn ${state.repairCount}/${REPAIR_MAX} failed. Retrying...`, "warning");
      setTimeout(() => {
        pi.sendUserMessage(
          `Repair failed:\n${formatError(errorText)}\nFix this and continue.`,
        );
      }, 1000);
      return;
    }

    // Phase B — normal success
    if (!isError) {
      state.retryCount = 0;
      return;
    }

    // Phase C — error: in-place retry
    state.retryCount++;
    const isAuto = await isAutoModeRunning();

    if (state.retryCount <= RETRY_MAX) {
      const delayMs = Math.min(BACKOFF_MS * Math.pow(2, state.retryCount - 1), BACKOFF_MAX_MS);

      ctx.ui.notify(`⚠️ [Guardian] Error: ${errorText.slice(0, 150)}...`, "error");
      ctx.ui.notify(`⏳ Retry ${state.retryCount}/${RETRY_MAX} in ${(delayMs / 1000).toFixed(1)}s (Esc=cancel)`, "warning");

      try {
        await sleep(delayMs);
      } catch {
        ctx.ui.notify("🛑 [Guardian] Retry cancelled.", "warning");
        pi.sendUserMessage("/gsd pause");
        return;
      }

      ctx.ui.notify(`🚀 Retry ${state.retryCount}...`, "info");
      pi.sendUserMessage(
        `**EXECUTION ERROR**\nFailed:\n${formatError(errorText)}\nFix params/logic and retry the same step.`,
      );
      return;
    }

    // Retries exhausted
    state.retryCount = 0;
    if (isAuto) {
      ctx.ui.notify("🔥 10 retries exhausted. Pausing for LLM repair...", "error");
      state.isFixing = true;
      pi.sendUserMessage("/gsd pause");
      setTimeout(() => {
        ctx.ui.notify("🤖 LLM repair turn...", "info");
        pi.sendUserMessage(
          `Auto-mode paused after 10 consecutive failures.\n\nError:\n${formatError(errorText)}\n\nDiagnose, fix, and reply. I will resume auto-mode after.`,
        );
      }, 2000);
    } else {
      ctx.ui.notify("❌ 10 retries exhausted. Giving up.", "error");
    }
  };

  handler.negotiate = async (event, ctx) => {
    const lastMsg = event.messages?.at(-1);
    if (lastMsg?.stopReason === "aborted") return;
    if (isErrorTurn(lastMsg) && !state.isFixing && ctx.absorb) {
      ctx.absorb((extPath) => extPath.includes("extensions/gsd"));
    }
  };

  return handler;
}
