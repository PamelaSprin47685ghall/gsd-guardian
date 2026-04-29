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
    let currentCtx = null;

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    function patchCmdCtx(helper) {
        const ctx = gsdSessionStore?.autoSession?.cmdCtx;
        if (!ctx || cmdCtxPatched) return;
        const orig = ctx.newSession;
        ctx.newSession = async function (opts) {
            if (helper.state.isInplaceRetry) {
                helper.state.isInplaceRetry = false;
                // 拦截清理，保留历史上下文
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
                // 欺骗 GSD：永远是第 1 次重试
                return origSet(key, 1);
            }
            // 10次上限耗尽，接管修复
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

                // 强制 GSD 发出的重试 Prompt 作为 FollowUp 追加，绝不替换上下文！
                const overrideOpts = { ...opts, deliverAs: "followUp" };

                helper.safeSleep(delayMs).then(() => {
                    orig(msg, overrideOpts);
                }).catch(() => {});
                return;
            }
            return orig(msg, opts);
        };
        sendMsgPatched = true;
    }

    function applyAll(helper, ctx) {
        if (ctx) currentCtx = ctx;
        patchCmdCtx(helper);
        patchRetryMap(helper);
        patchSendMessage(helper);
    }

    return { applyAll };
}
