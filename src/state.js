// Guardian Plugin - State Machine

export function createGuardianState() {
    const state = {
        schemaRetryCount: 0,     
        businessRetryCount: 0,   
        isInplaceRetry: false,   
        hiddenToolError: null,   
        pendingBusinessError: null, 
        needsSleep: false,
        cancelSleep: null,
        validCmdCtx: null,       // 缓存真命天子：拥有 newSession 方法的上下文
        lastErrorReason: null, 
        errorOccurredTime: 0
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
        state.schemaRetryCount = 0;
        state.businessRetryCount = 0;
        state.isInplaceRetry = false;
        state.hiddenToolError = null;
        state.pendingBusinessError = null;
        state.needsSleep = false;
        state.lastErrorReason = null;
        state.errorOccurredTime = 0;
        if (state.cancelSleep) state.cancelSleep();
        // validCmdCtx 不重置，以便复活时兜底使用
    }

    return { state, safeSleep, reset };
}
