// Guardian Plugin Main

import { loadGsdModules } from "./discovery.js";
import { setGsdRuntimeModules, createPatcher } from "./patch.js";
import { createGuardianState } from "./state.js";

const MAX_RETRIES = 10;
let gsdMods = null;

async function ensureMods(ctx) {
    if (!gsdMods) {
        gsdMods = await loadGsdModules(ctx);
        setGsdRuntimeModules(gsdMods);
    }
}

export default function guardianPlugin(pi) {
    const helper = createGuardianState();
    const patcher = createPatcher(pi);

    pi.on("session_start", async (_event, ctx) => {
        helper.reset();
        await ensureMods(ctx);
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(helper, ctx);
    });

    pi.on("agent_end", async (event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(helper, ctx);

        const lastMsg = event.messages?.[event.messages.length - 1];
        const stopReason = lastMsg?.stopReason;

        // User interrupt — full reset
        if (stopReason === "aborted") {
            helper.reset();
            return;
        }

        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;

        // ── Fix mode: LLM repair completed ──
        if (helper.state.isFixingMode) {
            helper.state.isFixingMode = false;
            helper.state.retryCount = 0;
            if (stopReason === "error") {
                ctx?.ui?.notify?.("Guardian: LLM self-repair failed", "error");
                return;
            }
            ctx?.ui?.notify?.("Guardian: LLM self-repair complete. Resuming...", "success");
            const api = gsdMods?.["auto"];
            if (api && !api.isAutoActive()) {
                api.startAutoDetached(ctx, pi, process.cwd(), false);
            }
            return;
        }

        // ── 核心死灵法术：系统崩溃处理 ──
        if (stopReason === "error") {
            helper.state.retryCount++;
            
            if (helper.state.retryCount <= MAX_RETRIES) {
                helper.state.lastErrorMsg = lastMsg.errorMessage || "Unknown execution error";
                
                if (isAuto) {
                    // 让 GSD 自然去 pauseAuto，我们设定 1 秒后将其复活
                    helper.state.isInplaceRetry = true;
                    helper.state.needsSleep = true;
                    helper.state.restartTimer = setTimeout(() => {
                        const api = gsdMods?.["auto"];
                        if (api && !api.isAutoActive()) {
                            api.startAutoDetached(ctx, pi, process.cwd(), false);
                        }
                    }, 1000);
                } else {
                    // Manual mode
                    const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                    ctx?.ui?.notify?.(`[Guardian] Manual Mode error. Retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");
                    helper.state.restartTimer = setTimeout(() => {
                        pi.sendMessage({
                            customType: "gsd-guardian-retry",
                            content: `Execution error: ${helper.state.lastErrorMsg}\n\nPlease correct your parameters and try exactly the same step again.`,
                            display: false
                        }, { triggerTurn: true, deliverAs: "followUp" });
                        helper.state.lastErrorMsg = null;
                    }, delayMs);
                }
            } else {
                // 10 次上限耗尽
                helper.state.retryCount = 0;
                if (isAuto) {
                    helper.state.isInplaceRetry = true;
                    helper.state.isFixingModePending = true;
                    helper.state.restartTimer = setTimeout(() => {
                        const api = gsdMods?.["auto"];
                        if (api && !api.isAutoActive()) {
                            api.startAutoDetached(ctx, pi, process.cwd(), false);
                        }
                    }, 1000);
                } else {
                    ctx?.ui?.notify?.("[Guardian] 10 retries exhausted. Giving up in manual mode.", "error");
                }
            }
        } else if (!isAuto) {
            // Normal mode successful end
            helper.reset();
        }
    });

    pi.on("session_shutdown", () => helper.reset());
}
