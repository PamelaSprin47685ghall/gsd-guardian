export const state = {
  retryCount: 0,
  repairCount: 0,
  isFixing: false,
  resumeAutoAfterRepair: false,
  repairExhaustedThisTurn: false,
  skipNextAgentEnd: false,
  skippingAgentEndThisTurn: false,
  timer: null,
  rejecter: null,
};

// Cancel sleep only — does not reset recovery counters.
// Called by stop hook on user Esc/Ctrl+C.
export function cancelSleepOnly() {
  if (state.timer) clearTimeout(state.timer);
  if (state.rejecter) state.rejecter(new Error("User Aborted"));
  state.timer = null;
  state.rejecter = null;
}

// Full reset of Guardian recovery state.
// Called at repair exhaustion (handler consumes repairExhaustedThisTurn).
// Never called from stop hook — recovery counters must survive normal agent_end cycles.
export function resetRecoveryState() {
  state.retryCount = 0;
  state.repairCount = 0;
  state.isFixing = false;
  state.resumeAutoAfterRepair = false;
  state.repairExhaustedThisTurn = false;
  state.skipNextAgentEnd = false;
  state.skippingAgentEndThisTurn = false;
}

export function sleep(ms) {
  return new Promise((resolve, reject) => {
    state.rejecter = reject;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.rejecter = null;
      resolve();
    }, ms);
  });
}
