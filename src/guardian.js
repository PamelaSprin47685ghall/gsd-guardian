// Guardian Plugin Main - Runtime Object Hijacking
//
// Orchestrates discovery, state, and patching to enable frozen auto-loop
// by intercepting mutable JS runtime objects (not frozen ES module exports).

import { loadGsdModules } from "./discovery.js";
import { setGsdRuntimeModules } from "./patch.js";
import { createGuardianState } from "./state.js";
import { createPatcher } from "./patch.js";

let gsdMods = null;
let patched = false;

export default function guardianPlugin(pi) {
    const helper = createGuardianState();
    const patcher = createPatcher(null, pi);

    // Apply all runtime patches defensively
    function applyPatches() {
        if (patched) return;
        setGsdRuntimeModules(gsdMods);
        patcher.applyAll(helper);
        patched = true;
    }

    pi.on("session_start", async (_event, ctx) => {
        helper.reset();

        // Load GSD runtime modules to get AutoSession instance
        if (!gsdMods) {
            gsdMods = await loadGsdModules(ctx);
            if (!gsdMods) {
                ctx?.ui?.notify?.("Guardian: Could not access GSD runtime", "error");
                return;
            }
        }

        // cmdCtx might not be set yet at session_start,
        // so patches are applied defensively in before_agent_start
    });

    pi.on("before_agent_start", (_event, _ctx) => {
        applyPatches();
    });

    pi.on("tool_execution_end", (event) => {
        if (!event.isError || !gsdMods?.["auto-runtime-state"]?.autoSession?.active) return;
        helper.state.retryCount++;
        if (helper.state.retryCount < MAX_RETRIES) {
            helper.state.needsSleep = true;
        }
    });

    pi.on("agent_end", async (event, ctx) => {
        applyPatches();
        const lastMsg = event.messages?.[event.messages.length - 1];
        const stopReason = lastMsg?.stopReason;

        if (stopReason === "aborted") {
            helper.reset();
            return;
        }

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
    });

    pi.on("session_shutdown", () => {
        helper.reset();
    });
}