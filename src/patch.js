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
    // 拦截复活后的上下文清洗，完美继承死前的记忆
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
    // 处理正常的产物缺失重试 (Artifact Missing)
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
            helper.state.isInplaceRetry = true;
            helper.state.isFixingModePending = true;
            return origSet(key, 4); 
        };

        map.delete = function (key) {
            helper.state.retryCount = 0;
            return origDelete(key);
        };
        retryMapPatched = true;
    }

    // ── Patch 3: Hijack pi.sendMessage ──
    // 在复活后，替换 GSD 的通用 Prompt，换成我们带有 Error 的纠错弹药
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            // 如果 10 次耗尽，强制发出修复指令
            if (helper.state.isFixingModePending) {
                helper.state.isFixingModePending = false;
                helper.state.isFixingMode = true;
                currentCtx?.ui?.notify?.("[Guardian] 10 retries exhausted. Entering LLM repair mode...", "error");
                const fixMsg = {
                    customType: "gsd-guardian-fix",
                    content: "**CRITICAL FAILURE**\n10 consecutive failures occurred. Auto Mode is paused.\n\nPlease deeply analyze the workspace, fix any logical, compilation, or schema errors. Do NOT try to proceed with the main task yet, just fix the blockers.",
                    display: true
                };
                return orig(fixMsg, { triggerTurn: true, deliverAs: "followUp" });
            }

            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);

                currentCtx?.ui?.notify?.(
                    `[Guardian] Auto Mode in-place retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`,
                    "warning"
                );

                let finalMsg = msg;
                // 如果是 Schema 崩溃复活，我们用 Error 覆盖原有的 Prompt
                if (helper.state.lastErrorMsg) {
                    finalMsg = {
                        customType: "gsd-guardian-retry",
                        content: `**CRITICAL FAILURE**\nThe previous tool execution failed with error:\n\`\`\`\n${helper.state.lastErrorMsg}\n\`\`\`\nPlease carefully correct your parameters/schema and retry exactly the same step.`,
                        display: false
                    };
                    helper.state.lastErrorMsg = null;
                }

                helper.safeSleep(delayMs).then(() => {
                    orig(finalMsg, { ...opts, deliverAs: "followUp" });
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
