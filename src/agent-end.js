import { state, sleep, resetRecoveryState } from "./state.js";
import { isAutoModeRunning } from "./probe.js";
import { clearLastToolInvocationError } from "./clear-tool-error.js";

const RETRY_MAX = 10;
const REPAIR_MAX = 5;
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 30000;

function formatError(text) {
  return `\`\`\`\n${text}\n\`\`\``;
}

function isGsdValidationWarning(lastMsg) {
  let text = lastMsg?.errorMessage || lastMsg?.content || "";
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

function isErrorTurn(lastMsg, event) {
  // Check last message
  if (lastMsg?.stopReason === "error" || isGsdValidationWarning(lastMsg)) return true;

  // Check any message in the current turn for the warning
  if (event?.messages?.some(m => isGsdValidationWarning(m))) return true;

  return false;
}

/**
 * Absorb filter: only match GSD's extension handlers at
 * `extensions/gsd/...`, NOT `extensions/gsd-guardian/...`.
 */
const isGsdExtension = (extPath) =>
  extPath.includes("extensions") && (extPath.includes("/gsd/") || extPath.endsWith("/gsd"));

export function createAgentEndHandler(pi) {
  // ── Handler (Pass 2) ──────────────────────────────────────────────────
  const handler = async (event, ctx) => {
    const lastMsg = event.messages?.at(-1);
    if (lastMsg?.stopReason === "aborted" && !isGsdValidationWarning(lastMsg))
      return;

    // Phase 0 — repair exhaustion: consume flag. State is already clean
    // (negotiate reset it).
    if (state.repairExhaustedThisTurn) {
      state.repairExhaustedThisTurn = false;
      ctx.ui.notify(
        "💀 [Guardian] Repair exhausted. GSD handling final failure.",
        "error",
      );
      return;
    }

    const isAuto = await isAutoModeRunning();
    if (state.lastAutoMode !== null && state.lastAutoMode !== isAuto) {
      resetRecoveryState();
    }
    state.lastAutoMode = isAuto;

    const isError = isErrorTurn(lastMsg, event);
    const errorText =
      lastMsg?.errorMessage ||
      (isGsdValidationWarning(lastMsg) ? lastMsg?.content : null) ||
      "Unknown Schema or API Error";

    // Phase A — repair mode
    if (state.isFixing) {
      if (!isError) {
        // Repair success — GSD will resolve the unit
        // State already cleared in negotiate
        ctx.ui.notify("✅ [Guardian] LLM repair done.", "success");
        return;
      }

      // repairCount already incremented in negotiate (Pass 1)
      if (state.repairCount >= REPAIR_MAX) {
        ctx.ui.notify(
          "💀 [Guardian] Repair failed. Halting.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `❌ [Guardian] Repair turn ${state.repairCount}/${REPAIR_MAX} failed.`,
        "warning",
      );
      pi.sendUserMessage(
        `Repair failed:\n${formatError(errorText)}\nFix this and continue.`,
      );
      return;
    }

    // Phase B — normal success: reset counter
    if (!isError) {
      state.retryCount = 0;
      return;
    }

    // Phase C — error: in-place retry with exponential backoff
    state.retryCount++;
    if (state.retryCount <= RETRY_MAX) {
      const delayMs = Math.min(
        BACKOFF_MS * Math.pow(2, state.retryCount - 1),
        BACKOFF_MAX_MS,
      );

      ctx.ui.notify(
        `⚠️ [Guardian] Error: ${errorText.slice(0, 150)}...`,
        "error",
      );
      ctx.ui.notify(
        `⏳ Retry ${state.retryCount}/${RETRY_MAX} in ${(delayMs / 1000).toFixed(1)}s (Esc=cancel)`,
        "warning",
      );

      try {
        await sleep(delayMs);
      } catch {
        // sleep was cancelled by stop hook (Esc/Ctrl+C)
        ctx.ui.notify("🛑 [Guardian] Retry cancelled.", "warning");
        return;
      }

      // If we were in auto-mode and it was stopped during sleep, abort retry.
      if (isAuto && !(await isAutoModeRunning())) {
        ctx.ui.notify(
          "⏹️ [Guardian] Auto-mode stopped during backoff.",
          "warning",
        );
        return;
      }

      ctx.ui.notify(`🚀 Retry ${state.retryCount}...`, "info");
      pi.sendUserMessage(
        `**EXECUTION ERROR**\nFailed:\n${formatError(errorText)}\nFix params/logic and retry the same step.`,
      );
      return;
    }

    // Retries exhausted → enter repair mode
    // No /gsd pause — absorb keeps autoLoop blocked on unitPromise.
    // No /gsd auto — LLM repair runs in the same session.
    state.isFixing = true;
    state.retryCount = 0;
    ctx.ui.notify(
      "🔥 10 retries exhausted. Entering LLM repair mode...",
      "error",
    );

    const pausedMsg = isAuto
      ? "Auto-mode paused after 10 consecutive failures."
      : "Guardian intervention: 10 consecutive failures reached.";
    const resumeMsg = isAuto
      ? "Diagnose, fix, and reply. I will resume auto-mode after."
      : "Diagnose, fix, and reply.";

    pi.sendUserMessage(
      `${pausedMsg}\n\nError:\n${formatError(errorText)}\n\n${resumeMsg}`,
    );
  };

  // ── Negotiate (Pass 1) ────────────────────────────────────────────────
  handler.negotiate = async (event, ctx) => {
    const lastMsg = event.messages?.at(-1);

    if (lastMsg?.stopReason === "aborted" && !isGsdValidationWarning(lastMsg))
      return;

    const isAuto = await isAutoModeRunning();
    if (state.lastAutoMode !== null && state.lastAutoMode !== isAuto) {
      resetRecoveryState();
    }
    state.lastAutoMode = isAuto;

    if (!isErrorTurn(lastMsg, event)) {
      // Success + Guardian was recovering → clean both GSD diagnostic
      // state and Guardian state BEFORE GSD's handler runs in Pass 2.
      // This ensures that when resolveAgentEnd() fires, no stale
      // retryCount / isFixing pollutes subsequent auto units.
      if (state.retryCount > 0 || state.isFixing) {
        const cleared = await clearLastToolInvocationError();
        if (!cleared) {
          ctx.ui.notify?.(
            "[Guardian] Could not clear GSD lastToolInvocationError.",
            "warning",
          );
        }
        resetRecoveryState();
      }
      return; // Don't absorb — GSD must process success
    }

    // Error + in repair mode
    // repairCount is incremented here (Pass 1) so the absorb
    // decision is based on the correct count.
    if (state.isFixing) {
      state.repairCount++;
      if (state.repairCount >= REPAIR_MAX) {
        // Repair exhausted — reset state immediately in Pass 1,
        // then set flag so handler can short-circuit and GSD
        // handles the final error.
        state.repairExhaustedThisTurn = true;
        state.retryCount = 0;
        state.repairCount = 0;
        state.isFixing = false;
        return; // Don't absorb
      }
    }

    // Absorb GSD's agent_end handler → resolveAgentEnd() not called
    // → autoLoop stays blocked on current unitPromise
    ctx.absorb?.(isGsdExtension);
  };

  return handler;
}
