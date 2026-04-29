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

    // ── 防御第一层：在工具返回结果时，抢先接管 Schema 错误 ──
    pi.on("tool_result", (event) => {
        if (event.isError) {
            const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;
            if (isAuto) {
                // 如果在 Auto 模式下发生了工具错误，直接把错误塞给状态机，
                // 然后强行把它标记为非错误！阻止它写入 `lastToolInvocationError`！
                state.schemaErrorMsg = event.content?.[0]?.text || "Unknown Validation Error";
                event.isError = false; 
                event.content = [{ type: "text", text: "Error intercepted by Guardian." }];
            }
        }
    });

    // ── 防御第二层：如果在回合结束时发现 Schema 错误，直接触发我们自己的重试 ──
    pi.on("turn_end", (event) => {
        const msg = event.message;
        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;
        
        // 清理残局
        if (isAuto) {
            const session = gsdMods?.["auto-runtime-state"]?.autoSession;
            if (session) session.lastToolInvocationError = null;
        }

        // 如果我们拦截到了 Schema 错误，直接触发原地重试，不让流程走到底层的 3 次崩溃
        if (state.schemaErrorMsg && isAuto) {
            state.schemaRetryCount++;
            if (state.schemaRetryCount <= MAX_RETRIES) {
                state.needsSleep = true;
                state.isInplaceRetry = true;
                
                // 伪造一个触发信号，让 patchSendMessage 开始走 followUp 重试
                pi.sendMessage({ customType: "trigger" }, { triggerTurn: true });
            } else {
                state.schemaRetryCount = 0;
                // 可以接入修复模式逻辑
            }
            return;
        }

        if (msg && msg.stopReason === "error") {
            if (isAuto) {
                msg.stopReason = "stop";
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

        // Manual Mode 处理
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
