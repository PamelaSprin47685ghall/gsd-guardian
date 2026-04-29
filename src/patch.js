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

    // ── Patch 3: 全局业务错误捕获器 (UI 探针模式) ──
    // 放弃不稳定的属性劫持，直接监控控制台输出的文字！
    function patchUI(helper) {
        if (!currentCtx || currentCtx.ui.__guardian_patched) return;

        const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
        currentCtx.ui.notify = function(msg, level) {
            if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                
                // 1. 记录报错信息
                if (level === "error" || level === "warning") {
                    // 如果短时间内连续报错，拼接到一起
                    if (Date.now() - helper.state.errorOccurredTime < 1000) {
                        helper.state.lastErrorReason += "\n\n" + msg;
                    } else {
                        helper.state.lastErrorReason = msg;
                    }
                    helper.state.errorOccurredTime = Date.now();
                }

                // 2. 捕捉到 GSD 打印的停机语句
                if (msg.includes("mode paused") && msg.includes("to resume")) {
                    // 延迟一点点触发，确保所有 UI 消息都已经打印完
                    setTimeout(() => checkUniversalErrorRecovery(), 100);
                }
            }
            return origNotify(msg, level);
        };
        currentCtx.ui.__guardian_patched = true;

        function checkUniversalErrorRecovery() {
            // 如果正在处理 Schema 崩溃的原地重试，不要干预
            if (helper.state.isInplaceRetry || helper.state.isFixingMode) return;

            const now = Date.now();
            // 如果停机前 5 秒内有过 Error / Warning 报错，那必然是被它干停的！
            if (helper.state.errorOccurredTime && (now - helper.state.errorOccurredTime < 5000)) {
                helper.state.errorOccurredTime = 0;
                helper.state.isFixingMode = true;
                helper.state.retryCount = 0;

                const errorDetails = helper.state.lastErrorReason;
                currentCtx.ui.notify(`[Guardian] Business logic issue detected. Handing over to LLM for repair...`, "warning");

                // 发送修复指令 (用 followUp 完美保留上下文)
                setTimeout(() => {
                    pi.sendMessage({
                        customType: "gsd-guardian-fix",
                        content: `**AUTO-MODE PAUSED DUE TO VALIDATION ERROR**\n\nThe system rejected your previous output with the following error/warning:\n\`\`\`\n${errorDetails}\n\`\`\`\n\nPlease deeply analyze the workspace and fix the blocking issues (e.g., missing fields, unmet schema requirements, broken references, or warnings). Do NOT proceed with the main task yet. I will automatically resume Auto Mode after you finish.`,
                        display: true
                    }, { triggerTurn: true, deliverAs: "followUp" });
                }, 1500);
            }
        }
    }

    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            if (helper.state.isFixingModePending) {
                helper.state.isFixingModePending = false;
                helper.state.isFixingMode = true;
                currentCtx?.ui?.notify?.("[Guardian] 10 retries exhausted. Entering LLM repair mode...", "error");
                const fixMsg = {
                    customType: "gsd-guardian-fix",
                    content: "**CRITICAL FAILURE**\n10 consecutive failures occurred. Auto Mode is paused.\n\nPlease deeply analyze the workspace, fix any logical, compilation, or schema errors. Do NOT try to proceed with the main task yet.",
                    display: true
                };
                return orig(fixMsg, { triggerTurn: true, deliverAs: "followUp" });
            }

            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                currentCtx?.ui?.notify?.(`[Guardian] Auto Mode in-place retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");

                let finalMsg = msg;
                let finalOpts = opts;

                if (helper.state.isInplaceRetry) {
                    finalOpts = { ...opts, deliverAs: "followUp" };
                    if (helper.state.lastErrorMsg) {
                        finalMsg = {
                            customType: "gsd-guardian-retry",
                            content: `**CRITICAL FAILURE**\nThe previous execution failed with error:\n\`\`\`\n${helper.state.lastErrorMsg}\n\`\`\`\nPlease carefully correct your parameters/schema and retry exactly the same step.`,
                            display: false
                        };
                        helper.state.lastErrorMsg = null;
                    }
                }

                helper.safeSleep(delayMs).then(() => {
                    orig(finalMsg, finalOpts);
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
        patchUI(helper);
        patchSendMessage(helper);
    }

    return { applyAll };
}
