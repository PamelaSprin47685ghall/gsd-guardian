// Guardian Plugin - Runtime Object Patches

const MAX_RETRIES = 10;
let gsdSessionStore = null;

export function setGsdRuntimeModules(mods) {
    gsdSessionStore = mods?.["auto-runtime-state"] ?? null;
}

export function createPatcher(pi) {
    let cmdCtxPatched = false;
    let retryMapPatched = false;
    let sendMsgPatched = false;
    let emitPatched = false;
    let currentCtx = null; 

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    function patchCmdCtx(helper) {
        const ctx = gsdSessionStore?.autoSession?.cmdCtx;
        if (!ctx || cmdCtxPatched) return;
        const orig = ctx.newSession;
        ctx.newSession = async function (opts) {
            if (helper.state.isInplaceRetry) {
                helper.state.isInplaceRetry = false;
                return { cancelled: false };
            }
            return orig.apply(this, [opts]);
        };
        cmdCtxPatched = true;
    }

    // ── Patch 2: Hijack verificationRetryCount Map ──
    function patchRetryMap(helper) {
        const map = gsdSessionStore?.autoSession?.verificationRetryCount;
        if (!map || retryMapPatched) return;
        const origSet = map.set.bind(map);
        const origDelete = map.delete.bind(map);

        map.set = function (key, val) {
            helper.state.retryCount++;
            if (helper.state.retryCount <= MAX_RETRIES) {
                helper.state.isInplaceRetry = true;
                helper.state.needsSleep = true;
                return origSet(key, 1);
            }
            helper.state.isFixingMode = true;
            setTimeout(() => {
                pi.sendMessage({
                    customType: "gsd-guardian-fix",
                    content: "**CRITICAL FAILURE**\n10 consecutive failures occurred. Auto Mode is paused.\n\nPlease deeply analyze the workspace, fix any logical, compilation, or schema errors. Do NOT try to proceed with the main task yet, just fix the blockers. I will automatically resume Auto Mode after this turn.",
                    display: true
                }, { triggerTurn: true, deliverAs: "followUp" });
            }, 1500);
            return origSet(key, 4);
        };

        map.delete = function (key) {
            helper.state.retryCount = 0;
            return origDelete(key);
        };
        retryMapPatched = true;
    }

    // ── Patch 3: Hijack pi.sendMessage ──
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);

                currentCtx?.ui?.notify?.(
                    `[Guardian] Auto Mode in-place retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`,
                    "warning"
                );

                helper.safeSleep(delayMs).then(() => {
                    orig(msg, opts);
                }).catch(() => {});
                return;
            }
            return orig(msg, opts);
        };
        sendMsgPatched = true;
    }

    // ── Patch 4: Hijack pi.emit ──
    function patchEmit() {
        if (emitPatched) return;
        const origEmit = pi.emit.bind(pi);
        pi.emit = function (eventName, ...args) {
            if (eventName === "agent_end") {
                const event = args[0];
                const lastMsg = event?.messages?.[event.messages.length - 1];
                if (lastMsg?.stopReason === "error") {
                    // 双保险：检查实例状态 或 独有的环境变量
                    const isAuto = gsdSessionStore?.autoSession?.active || !!process.env.GSD_PROJECT_ROOT;
                    lastMsg.stopReason = "stop"; 

                    if (isAuto) {
                        if (gsdSessionStore?.autoSession) {
                            gsdSessionStore.autoSession.lastToolInvocationError = null;
                        }
                    } else {
                        event.__guardian_manual_error = lastMsg.errorMessage || "Unknown execution error";
                    }
                }
            }
            return origEmit(eventName, ...args);
        };
        emitPatched = true;
    }

    function applyAll(helper, ctx) {
        if (ctx) currentCtx = ctx;
        patchCmdCtx(helper);
        patchRetryMap(helper);
        patchSendMessage(helper);
        patchEmit();
    }

    return { applyAll };
}
