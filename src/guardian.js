// Guardian Plugin for GSD Auto-Mode Error Recovery
//
// Main plugin entry point that coordinates discovery, state, and patching.

import { loadGsdAutoLoop } from "./discovery.js";
import { createStateManager } from "./state.js";
import { createAutoLoopPatcher } from "./patch.js";

let capturedCtx = null;
let patched = false;
let gsdAutoLoop = null;

export default function guardianPlugin(pi) {
    const stateManager = createStateManager();
    const patcher = createAutoLoopPatcher(stateManager, pi);

    // Core hijacking: Patch only once on activation or session start
    async function patchAutoLoop() {
        if (patched || !gsdAutoLoop) return;

        try {
            const success = await patcher.patchAutoLoop(gsdAutoLoop, capturedCtx);
            if (success) {
                patched = true;
            }
        } catch (err) {
            capturedCtx?.ui?.notify?.(`Guardian patch failed: ${err.message}`, "error");
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        capturedCtx = ctx;
        stateManager.resetPluginState();

        if (patched) return;

        try {
            // Load GSD auto-loop module
            gsdAutoLoop = await loadGsdAutoLoop(capturedCtx);
            if (!gsdAutoLoop) {
                capturedCtx?.ui?.notify?.("Guardian: Could not load auto-loop module", "error");
                return;
            }

            await patchAutoLoop();
        } catch (err) {
            capturedCtx?.ui?.notify?.(`Guardian init failed: ${err.message}`, "error");
        }
    });

    pi.on("before_agent_start", async () => {
        await patchAutoLoop(); // Defensive call, ensure patch succeeds
    });

    pi.on("session_shutdown", () => {
        stateManager.resetPluginState();
    });

    console.log("Guardian plugin activated with modular architecture");
}