// Guardian Plugin - State Machine
//
// Manages retry count, fixing mode, and sleep interruption state.

export function createGuardianState() {
    const state = {
        retryCount: 0,
        isFixingMode: false,
        isInplaceRetry: false,
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
        state.retryCount = 0;
        state.isFixingMode = false;
        state.isInplaceRetry = false;
        state.needsSleep = false;
        if (state.cancelSleep) state.cancelSleep();
    }

    function getRetryCount() { return state.retryCount; }
    function isFixing() { return state.isFixingMode; }
    function isRetrying() { return state.isInplaceRetry; }
    function isSleeping() { return state.needsSleep; }

    return {
        state, safeSleep, reset,
        getRetryCount, isFixing, isRetrying, isSleeping
    };
}