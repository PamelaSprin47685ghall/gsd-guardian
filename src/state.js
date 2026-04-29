// Guardian Plugin - State Machine

export function createGuardianState() {
    const state = {
        retryCount: 0,
        isFixingMode: false,
        isFixingModePending: false,
        isInplaceRetry: false,
        needsSleep: false,
        lastErrorMsg: null,
        lastErrorReason: null, // 用于捕获业务级校验报错
        errorOccurredTime: 0,  // 记录报错时间戳
        cancelSleep: null,
        restartTimer: null
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
        state.lastErrorReason = null;
        state.errorOccurredTime = 0;
        if (state.cancelSleep) state.cancelSleep();
        if (state.restartTimer) clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    return { state, safeSleep, reset };
}
