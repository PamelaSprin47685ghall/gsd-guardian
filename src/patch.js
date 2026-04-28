// Guardian Plugin - Auto-Loop Patching
//
// Implements the frozen auto-loop pattern by monkey-patching resolveAgentEnd.

export function createAutoLoopPatcher(stateManager, pi) {
    const MAX_RETRIES = 10;

    async function patchAutoLoop(gsdAutoLoop, ctx) {
        const originalResolveAgentEnd = gsdAutoLoop.resolveAgentEnd;
        stateManager.setOriginalResolveAgentEnd(originalResolveAgentEnd);

        // Hijack GSD's underlying Promise resolver
        gsdAutoLoop.resolveAgentEnd = async function (event) {
            const lastMsg = event.messages[event.messages.length - 1];
            const stopReason = lastMsg?.stopReason;
            const errorMsg = lastMsg?.errorMessage || "Unknown execution error";

            // Check for tool invocation errors (simplified - we can't access internal state)
            let toolInvocationError = null;

            // ==========================================
            // Requirement 5: Respond to user interruption (Esc / Ctrl+C)
            // ==========================================
            if (stopReason === "aborted") {
                stateManager.resetPluginState();
                // Immediately release, let GSD handle normal termination
                return originalResolveAgentEnd.call(this, event);
            }

            // Determine if hard error occurred: Schema error or GSD tool internal error
            const isError = stopReason === "error" || toolInvocationError != null;
            const combinedErrorMsg = toolInvocationError || errorMsg;

            // ==========================================
            // Requirements 3 & 4: Intercept errors and perform in-place retries (preserve context)
            // ==========================================
            if (isError) {
                if (stateManager.getRetryCount() < MAX_RETRIES) {
                    const retryNum = stateManager.incrementRetry();
                    const delayMs = Math.min(1000 * Math.pow(2, retryNum - 1), 30000);

                    pi.sendMessage({
                        customType: "guardian-notify",
                        content: `[Guardian] Error detected. In-place retry ${retryNum}/${MAX_RETRIES} in ${delayMs/1000}s...`,
                        display: true
                    });

                    try {
                        await stateManager.safeSleep(delayMs);
                    } catch (e) {
                        return; // User pressed Esc during sleep, handled by next aborted event
                    }

                    // Clean up any state remnants (limited access)
                    // if (gsdSession) gsdSession.lastToolInvocationError = null;

                    // Core: Use followUp to send, append directly to original context, never trigger newSession!
                    pi.sendMessage({
                        customType: "guardian-retry",
                        content: `Tool or Schema execution failed with error:\n\`\`\`\n${combinedErrorMsg}\n\`\`\`\nPlease carefully correct your parameters and retry the exact same step immediately.`,
                        display: false
                    }, { triggerTurn: true, deliverAs: "followUp" });

                    // Intercept ends, absolutely do not call originalResolveAgentEnd, freeze AutoLoop!
                    return;
                }
                // ==========================================
                // Handling after 10 retries exhausted
                // ==========================================
                else {
                    stateManager.resetRetryCount();

                    // Simplified auto mode detection - assume auto mode for agent_end events
                    const isAuto = true; // In practice, we'd need better detection

                    if (isAuto) {
                        // Requirement 1: In auto mode, enter LLM fix mode
                        stateManager.enterFixingMode();
                        // if (gsdSession) gsdSession.lastToolInvocationError = null;

                        pi.sendMessage({
                            customType: "guardian-fix",
                            content: `**CRITICAL FAILURE**\nWe hit the 10-retry limit. Error:\n\`\`\`\n${combinedErrorMsg}\n\`\`\`\nPlease deeply analyze the workspace and fix any blocking issues (e.g., compile errors, schema issues). Do NOT proceed with the main task yet.`,
                            display: true
                        }, { triggerTurn: true, deliverAs: "followUp" });

                        // Continue freezing AutoLoop
                        return;
                    } else {
                        // Requirement 2: In non-auto mode, directly abandon, release to GSD to throw error
                        return originalResolveAgentEnd.call(this, event);
                    }
                }
            }

            // ==========================================
            // Successful execution path
            // ==========================================
            if (!isError) {
                if (stateManager.isInFixingMode()) {
                    // Requirement 1: Fix round successful end, instruct LLM to continue with previously failed task
                    stateManager.exitFixingMode();
                    stateManager.resetRetryCount();

                    pi.sendMessage({
                        customType: "guardian-resume",
                        content: `Fix completed. Now, please execute the original tool or step that failed earlier to proceed with the task.`,
                        display: true
                    }, { triggerTurn: true, deliverAs: "followUp" });

                    // Continue freezing AutoLoop, wait for final tool call success
                    return;
                }

                // Completely normal success, reset plugin state, release to GSD's AutoLoop to proceed
                stateManager.resetPluginState();
                return originalResolveAgentEnd.call(this, event);
            }
        };

        ctx?.ui?.notify?.("Guardian: Auto-loop patched successfully", "info");
        return true;
    }

    return { patchAutoLoop };
}