// Guardian Plugin - State Machine

export function createGuardianState() {
    const state = {
        retryCount: 0,
        isFixingMode: false,
        isFixingModePending: false,
        isInplaceRetry: false,
        needsSleep: false,
        lastErrorMsg: null,
        cancelSleep: null,
        restartTimer: null // 用于打断复活倒计时
    };

    async function safeSleep(ms) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.cancelSleep = null;
                resolve();
            }, ms);
            state.cancelSleep = () => {
                clearTimeout(timer);
                state.cancelSleep = null;
                reject(new Error("User Aborted"));
            };
        });
    }

    function reset() {
        state.retryCount = 0;
        state.isFixingMode = false;
        state.isFixingModePending = false;
        state.isInplaceRetry = false;
        state.needsSleep = false;
        state.lastErrorMsg = null;
        if (state.cancelSleep) state.cancelSleep();
        if (state.restartTimer) clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    return { state, safeSleep, reset };
}
