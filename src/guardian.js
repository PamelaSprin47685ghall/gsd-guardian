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
    const state = createGuardianState();
    const patcher = createPatcher(pi);

    pi.on("session_start", async (_event, ctx) => {
        state.reset();
        await ensureMods(ctx);
    });

    pi.on("before_agent_start", async (_event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(state, ctx);
    });

    // ── 核心防御：无条件隐瞒 Schema 错误，逼迫 GSD 走产物校验 ──
    pi.on("turn_end", (event) => {
        const msg = event.message;
        if (msg && msg.stopReason === "error") {
            const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;
            
            // 【无条件执行】只要报错，必须把错误抹掉，防止 GSD 核心崩溃！
            msg.stopReason = "stop";

            if (isAuto) {
                // 缓存真实错误供 FollowUp 使用
                state.schemaErrorMsg = msg.errorMessage || "Unknown Error";
                const sessionStore = gsdMods?.["auto-runtime-state"];
                if (sessionStore?.autoSession) {
                    sessionStore.autoSession.lastToolInvocationError = null;
                }
            } else {
                event.__manual_error = msg.errorMessage || "Unknown Error";
            }
        }
    });

    pi.on("agent_end", async (event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(state, ctx);

        const lastMsg = event.messages?.[event.messages.length - 1];
        if (lastMsg?.stopReason === "aborted") {
            state.reset();
            return;
        }

        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;

        // ── Manual Mode 处理 ──
        if (event.__manual_error && !isAuto) {
            state.schemaRetryCount++;
            if (state.schemaRetryCount <= MAX_RETRIES) {
                const delayMs = Math.min(1000 * Math.pow(2, state.schemaRetryCount - 1), 30000);
                ctx?.ui?.notify?.(`[Guardian] Manual retry ${state.schemaRetryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");
                try {
                    await state.safeSleep(delayMs);
                    pi.sendMessage({
                        customType: "gsd-guardian-retry",
                        content: `Execution error: ${event.__manual_error}\nPlease correct your parameters and retry.`,
                        display: false
                    }, { triggerTurn: true, deliverAs: "followUp" });
                } catch (e) {}
            } else {
                state.schemaRetryCount = 0;
                ctx?.ui?.notify?.("[Guardian] 10 retries exhausted.", "error");
            }
        }
    });

    pi.on("session_shutdown", () => state.reset());
}
