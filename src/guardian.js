// Guardian Plugin Main - Runtime Object Hijacking
//
// Key design: Listens to the earlier "turn_end" event to mutate the message
// object by reference. This blinds GSD's core agent_end listener to schema
// errors, funneling the execution into the retry/fix Map interceptors.

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

    // ── 终极防御：在 agent_end 之前拦截并篡改对象引用 ──
    pi.on("turn_end", async (event, ctx) => {
        await ensureMods(ctx);
        const msg = event.message;

        if (msg && msg.stopReason === "error") {
            const isAuto = gsdMods?.["auto"]?.isAutoActive() || false;
            msg.__guardian_manual_error = msg.errorMessage || "Unknown execution error";
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

        // User interrupt — full reset
        if (stopReason === "aborted") {
            helper.reset();
            return;
        }

        const isAuto = gsdMods?.["auto"]?.isAutoActive() || false;

        // Fix mode: LLM completed a repair round
        if (helper.state.isFixingMode) {
            helper.state.isFixingMode = false;
            helper.state.retryCount = 0;
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

        // Manual mode error handling
        if (lastMsg && lastMsg.__guardian_manual_error && !isAuto) {
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
            // Normal mode successful end — reset counter
            helper.reset();
        }
    });

    pi.on("session_shutdown", () => helper.reset());
}