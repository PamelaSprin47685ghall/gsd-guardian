// Guardian Plugin - Runtime Object Patches
//
// Intercepts mutable JS runtime objects (AutoSession instance, Map, etc.)
// to enable frozen auto-loop without touching frozen ES module exports.

const MAX_RETRIES = 10;
let gsdSessionStore = null;
let gsdAutoApi = null;

export function setGsdRuntimeModules(mods) {
    gsdSessionStore = mods?.["auto-runtime-state"] ?? null;
    gsdAutoApi = mods?.["auto"] ?? null;
}

export function createPatcher(gsd, pi) {
    let cmdCtxPatched = false;
    let retryMapPatched = false;
    let sendMsgPatched = false;

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    // Prevents context cleanup during in-place retry.
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
    // Bypasses GSD's 3-retry limit by lying about the count.
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
            // 10 retries exhausted → enter fix mode
            helper.state.isFixingMode = true;
            setTimeout(() => {
                pi.sendMessage({
                    customType: "gsd-guardian-fix",
                    content: "**CRITICAL FAILURE**\n10 consecutive failures occurred. Auto Mode is paused.\n\nPlease deeply analyze the workspace, fix any logical, compilation, or schema errors. I will automatically resume Auto Mode after this turn.",
                    display: true
                }, { triggerTurn: true });
            }, 1000);
            return origSet(key, 4);
        };

        map.delete = function (key) {
            helper.state.retryCount = 0;
            return origDelete(key);
        };
        retryMapPatched = true;
    }

    // ── Patch 3: Hijack pi.sendMessage ──
    // Injects exponential backoff sleep before message delivery.
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                helper.safeSleep(delayMs).then(() => {
                    orig(msg, opts);
                }).catch(() => {});
                return;
            }
            return orig(msg, opts);
        };
        sendMsgPatched = true;
    }

    function applyAll(helper) {
        patchCmdCtx(helper);
        patchRetryMap(helper);
        patchSendMessage(helper);
    }

    return { applyAll };
}