// Guardian Plugin - State Machine

export function createGuardianState() {
    const state = {
        retryCount: 0,
        isFixingMode: false,
        isFixingModePending: false,
        isInplaceRetry: false,
        needsSleep: false,
        schemaErrorMsg: null,
        lastBusinessError: null,
        validCmdCtx: null, // 缓存含有 newSession 的上下文
        cancelSleep: null
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
        state.schemaErrorMsg = null;
        state.lastBusinessError = null;
        if (state.cancelSleep) state.cancelSleep();
    }

    return { state, safeSleep, reset };
}
