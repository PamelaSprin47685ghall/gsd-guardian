const sessionStates = new WeakMap();

export function getState(pi) {
  if (!pi) return getFallbackState();

  if (!sessionStates.has(pi)) {
    sessionStates.set(pi, {
      retryCount: 0,
      repairCount: 0,
      isFixing: false,
      resumeAutoAfterRepair: false,
      repairExhaustedThisTurn: false,
      skipNextAgentEnd: false,
      skippingAgentEndThisTurn: false,
      timer: null,
      rejecter: null,
      activeRepairToken: null,
      repairTokenCounter: 0,
      repairSource: null,
      repairStartedAt: 0,
      autoStopRequested: false,
    });
  }
  return sessionStates.get(pi);
}

let fallbackState = null;
function getFallbackState() {
  if (!fallbackState) {
    fallbackState = {
      retryCount: 0,
      repairCount: 0,
      isFixing: false,
      resumeAutoAfterRepair: false,
      repairExhaustedThisTurn: false,
      skipNextAgentEnd: false,
      skippingAgentEndThisTurn: false,
      timer: null,
      rejecter: null,
      activeRepairToken: null,
      repairTokenCounter: 0,
      repairSource: null,
      repairStartedAt: 0,
      autoStopRequested: false,
    };
  }
  return fallbackState;
}

export function resetForNewSession(pi) {
  cancelSleepOnly(pi);
  resetRecoveryState(pi);
}

export function cancelSleepOnly(pi) {
  const s = getState(pi);
  if (s.timer) clearTimeout(s.timer);
  if (s.rejecter) s.rejecter(new Error("User Aborted"));
  s.timer = null;
  s.rejecter = null;
}

export function resetRecoveryState(pi) {
  const s = getState(pi);
  s.retryCount = 0;
  s.repairCount = 0;
  s.isFixing = false;
  s.resumeAutoAfterRepair = false;
  s.repairExhaustedThisTurn = false;
  s.skipNextAgentEnd = false;
  s.skippingAgentEndThisTurn = false;
  s.activeRepairToken = null;
  s.repairSource = null;
  s.repairStartedAt = 0;
  s.autoStopRequested = false;
}

export function beginRepairSession(pi, source) {
  const s = getState(pi);
  s.isFixing = true;
  s.resumeAutoAfterRepair = true;
  s.retryCount = 0;
  s.repairCount = 0;
  s.repairExhaustedThisTurn = false;
  s.repairTokenCounter += 1;
  s.activeRepairToken = `repair-${s.repairTokenCounter}`;
  s.repairSource = source;
  s.repairStartedAt = Date.now();
  s.autoStopRequested = true;
  return s.activeRepairToken;
}

export function sleep(pi, ms) {
  const s = getState(pi);
  return new Promise((resolve, reject) => {
    s.rejecter = reject;
    s.timer = setTimeout(() => {
      s.timer = null;
      s.rejecter = null;
      resolve();
    }, ms);
  });
}
