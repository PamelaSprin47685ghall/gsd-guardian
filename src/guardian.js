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

    // ── 隐瞒 Schema 错误，逼迫 GSD 走产物校验 ──
    pi.on("turn_end", (event) => {
        const msg = event.message;
        if (msg && msg.stopReason === "error") {
            const sessionStore = gsdMods?.["auto-runtime-state"];
            if (sessionStore?.autoSession?.active) {
                helper.state.schemaErrorMsg = sessionStore.autoSession.lastToolInvocationError || msg.errorMessage || "Unknown Error";
                msg.stopReason = "stop";
                sessionStore.autoSession.lastToolInvocationError = null;
            } else {
                event.__manual_error = msg.errorMessage || "Unknown Error";
            }
        }
    });

    pi.on("agent_end", async (event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(helper, ctx);

        const lastMsg = event.messages?.[event.messages.length - 1];
        const stopReason = lastMsg?.stopReason;

        if (stopReason === "aborted") {
            helper.reset();
            return;
        }

        // =========================================================
        // LLM 修复回合结束，恢复 Auto Mode 
        // =========================================================
        if (helper.state.isFixingMode) {
            helper.state.isFixingMode = false;
            helper.state.retryCount = 0;
            
            if (stopReason === "error") {
                ctx?.ui?.notify?.("[Guardian] LLM self-repair failed.", "error");
                return;
            }

            ctx?.ui?.notify?.("[Guardian] LLM self-repair complete. Resuming /gsd auto...", "success");
            
            const api = gsdMods?.["auto"];
            if (api) {
                // 找回包含 newSession 的健壮 Context
                const robustCtx = helper.state.validCmdCtx || ctx;
                if (typeof robustCtx.newSession !== "function") {
                    robustCtx.newSession = async (opts) => {
                        try {
                            const res = await ctx.sessionManager?.newSession(opts);
                            return res ?? { cancelled: false };
                        } catch (e) { return { cancelled: false }; }
                    };
                }
                api.startAutoDetached(robustCtx, pi, process.cwd(), false);
            }
            return;
        }

        // =========================================================
        // Manual Mode 处理
        // =========================================================
        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;
        
        if (lastMsg && lastMsg.__manual_error && !isAuto) {
            helper.state.retryCount++;
            if (helper.state.retryCount <= MAX_RETRIES) {
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                ctx?.ui?.notify?.(`[Guardian] Manual retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");
                try {
                    await helper.safeSleep(delayMs);
                    pi.sendMessage({
                        customType: "gsd-guardian-retry",
                        content: `Execution error: ${lastMsg.__manual_error}\nPlease correct your parameters and retry.`,
                        display: false
                    }, { triggerTurn: true, deliverAs: "followUp" });
                } catch (e) {}
            } else {
                helper.state.retryCount = 0;
                ctx?.ui?.notify?.("[Guardian] 10 retries exhausted.", "error");
            }
        }
    });

    pi.on("session_shutdown", () => helper.reset());
}
