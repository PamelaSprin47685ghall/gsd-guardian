// Guardian Plugin - State Management
//
// Manages plugin state machine for retries and error recovery.

export function createStateManager() {
    const state = {
        retryCount: 0,
        isFixingMode: false,
        cancelSleep: null,
        originalResolveAgentEnd: null
    };

    // Safe sleep with interruption support
    async function safeSleep(ms) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.cancelSleep = null;
                resolve();
            }, ms);
            state.cancelSleep = () => {
                clearTimeout(timer);
                state.cancelSleep = null;
                reject(new Error("aborted"));
            };
        });
    }

    function resetPluginState() {
        state.retryCount = 0;
        state.isFixingMode = false;
        if (state.cancelSleep) state.cancelSleep();
    }

    function incrementRetry() {
        return ++state.retryCount;
    }

    function getRetryCount() {
        return state.retryCount;
    }

    function resetRetryCount() {
        state.retryCount = 0;
    }

    function enterFixingMode() {
        state.isFixingMode = true;
    }

    function exitFixingMode() {
        state.isFixingMode = false;
    }

    function isInFixingMode() {
        return state.isFixingMode;
    }

    function setOriginalResolveAgentEnd(fn) {
        state.originalResolveAgentEnd = fn;
    }

    function getOriginalResolveAgentEnd() {
        return state.originalResolveAgentEnd;
    }

    return {
        safeSleep,
        resetPluginState,
        incrementRetry,
        getRetryCount,
        resetRetryCount,
        enterFixingMode,
        exitFixingMode,
        isInFixingMode,
        setOriginalResolveAgentEnd,
        getOriginalResolveAgentEnd
    };
}