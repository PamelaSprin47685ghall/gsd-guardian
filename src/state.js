export const state = {
  retryCount: 0,
  repairCount: 0,
  isFixing: false,
  suppressNextNewSession: false,
  timer: null,
  rejecter: null,
};

export function abort() {
  if (state.timer) clearTimeout(state.timer);
  if (state.rejecter) state.rejecter(new Error("User Aborted"));
  state.timer = null;
  state.rejecter = null;
  state.retryCount = 0;
  state.repairCount = 0;
  state.isFixing = false;
  state.suppressNextNewSession = false;
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
