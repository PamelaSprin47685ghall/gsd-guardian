// Guardian Plugin - State Machine

export function createGuardianState() {
    const state = {
        schemaRetryCount: 0,     // 用于原地重试 (不丢上下文)
        businessRetryCount: 0,   // 用于业务报错重试 (刷新上下文)
        isInplaceRetry: false,   // 标记是否要拦截 newSession
        hiddenToolError: null,   // 缓存被拦截的 Schema 错误
        pendingBusinessError: null, // 缓存业务报错，等待注入新 Session
        needsSleep: false,
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
        state.schemaRetryCount = 0;
        state.businessRetryCount = 0;
        state.isInplaceRetry = false;
        state.hiddenToolError = null;
        state.pendingBusinessError = null;
        state.needsSleep = false;
        if (state.cancelSleep) state.cancelSleep();
    }

    return { state, safeSleep, reset };
}
