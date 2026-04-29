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

    // ── 终极防御：在 agent_end 之前，通过修改对象引用隐瞒错误 ──
    //
    // GSD core agent-loop.ts fires events in this order:
    //   1. turn_end   → passes the single message object
    //   2. agent_end  → passes the messages array (containing the same message by reference)
    //
    // By mutating stopReason on the message itself, agent_end sees a "clean" message.
    pi.on("turn_end", async (event, ctx) => {
        await ensureMods(ctx);
        const msg = event.message;

        if (msg && msg.stopReason === "error") {
            const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;

            // Stamp the error info before hiding it
            msg.__guardian_manual_error = msg.errorMessage || "Unknown execution error";

            // Mutate in-place — same object reference agent_end will read
            msg.stopReason = "stop";

            if (isAuto) {
                const session = gsdMods?.["auto-runtime-state"]?.autoSession;
                if (session) session.lastToolInvocationError = null;
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

        const isAuto = gsdMods?.["auto"]?.isAutoActive() || !!process.env.GSD_PROJECT_ROOT;

        if (helper.state.isFixingMode) {
            helper.state.isFixingMode = false;
            helper.state.retryCount = 0;
            // Fix round itself may have been error-then-masked by turn_end
            if (stopReason === "error" || lastMsg?.__guardian_manual_error) {
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

        // Manual mode: turn_end stamped __guardian_manual_error on the message
        if (lastMsg?.__guardian_manual_error && !isAuto) {
            helper.state.retryCount++;
            if (helper.state.retryCount <= MAX_RETRIES) {
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                ctx?.ui?.notify?.(`[Guardian] Manual Mode error. Retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");
                try {
                    await helper.safeSleep(delayMs);
                    pi.sendMessage({
                        customType: "gsd-guardian-retry",
                        content: `Execution error: ${lastMsg.__guardian_manual_error}\n\nPlease correct your parameters and try exactly the same step again.`,
                        display: false
                    }, { triggerTurn: true, deliverAs: "followUp" });
                } catch (e) {}
            } else {
                helper.state.retryCount = 0;
                ctx?.ui?.notify?.("[Guardian] 10 retries exhausted. Giving up in manual mode.", "error");
            }
        } else if (!isAuto && !lastMsg?.__guardian_manual_error) {
            helper.reset();
        }
    });

    pi.on("session_shutdown", () => helper.reset());
}
