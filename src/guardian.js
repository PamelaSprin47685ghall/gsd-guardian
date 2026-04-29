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

    // ── 核心防御：提前隐瞒 Schema / 工具报错 ──
    pi.on("turn_end", (event) => {
        const msg = event.message;
        if (msg && msg.stopReason === "error") {
            const s = gsdMods?.["auto-runtime-state"]?.autoSession;
            const isAuto = s?.active;
            
            if (isAuto) {
                // 缓存真实错误供 FollowUp 使用
                helper.state.hiddenToolError = s.lastToolInvocationError || msg.errorMessage || "Unknown Error";
                // 瞒天过海，让 GSD 走向产物校验并触发 Map 拦截
                msg.stopReason = "stop";
                s.lastToolInvocationError = null; 
            } else {
                // Manual Mode 打标记
                event.__guardian_manual_error = msg.errorMessage || "Unknown Error";
            }
        }
    });

    pi.on("agent_end", async (event, ctx) => {
        await ensureMods(ctx);
        patcher.applyAll(helper, ctx);

        const lastMsg = event.messages?.[event.messages.length - 1];
        if (lastMsg?.stopReason === "aborted") {
            helper.reset();
            return;
        }

        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;

        // Manual Mode 的原地重试
        if (event.__guardian_manual_error && !isAuto) {
            helper.state.schemaRetryCount++;
            if (helper.state.schemaRetryCount <= MAX_RETRIES) {
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.schemaRetryCount - 1), 30000);
                ctx?.ui?.notify?.(`[Guardian] Manual Mode error. Retry ${helper.state.schemaRetryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");
                try {
                    await helper.safeSleep(delayMs);
                    pi.sendMessage({
                        customType: "gsd-guardian-retry",
                        content: `Execution error: ${event.__guardian_manual_error}\n\nPlease correct your parameters and try exactly the same step again.`,
                        display: false
                    }, { triggerTurn: true, deliverAs: "followUp" });
                } catch (e) {}
            } else {
                helper.state.schemaRetryCount = 0;
                ctx?.ui?.notify?.("[Guardian] 10 retries exhausted. Giving up in manual mode.", "error");
            }
        } else if (!isAuto) {
            helper.reset();
        }
    });

    pi.on("session_shutdown", () => helper.reset());
}
