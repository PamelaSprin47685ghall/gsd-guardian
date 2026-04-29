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
    let uiSessionPatched = false;
    let currentCtx = null;

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    function patchCmdCtx(helper) {
        const ctx = gsdSessionStore?.autoSession?.cmdCtx;
        if (!ctx || cmdCtxPatched) return;
        const orig = ctx.newSession;
        ctx.newSession = async function (opts) {
            // 原地重试时拦截上下文清理，保留记忆
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

    // ── Patch 3: 全局业务错误捕获器 (Universal Error Catcher) ──
    // 专门捕获 Pre-execution / Content validation 这类导致 Auto Mode 停机的业务错误
    function patchUIAndSession(helper) {
        const s = gsdSessionStore?.autoSession;
        if (!s || !currentCtx || uiSessionPatched) return;

        // 1. 劫持 UI Notify，悄悄记录所有的红色报错文本
        if (!currentCtx.ui.__guardian_patched) {
            const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
            currentCtx.ui.notify = function(msg, level) {
                if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                    if (level === "error" || level === "warning") {
                        // 聚合同一时间段内的多条报错（比如三个属性校验失败）
                        if (Date.now() - helper.state.errorOccurredTime < 500) {
                            helper.state.lastErrorReason += "\n" + msg;
                        } else {
                            helper.state.lastErrorReason = msg;
                        }
                        helper.state.errorOccurredTime = Date.now();
                    }
                }
                return origNotify(msg, level);
            };
            currentCtx.ui.__guardian_patched = true;
        }

        // 2. 劫持 s.paused，一旦 Auto Mode 停机，且刚刚有报错，立刻切入修复模式！
        if (!s.__guardian_state_patched) {
            let realPaused = s.paused;
            Object.defineProperty(s, "paused", {
                get: () => realPaused,
                set: function(val) {
                    const justPaused = !realPaused && val;
                    realPaused = val;
                    if (justPaused) {
                        // 使用 setTimeout 确保 UI 通知已经全部到达并被记录
                        setTimeout(() => checkUniversalErrorRecovery(), 100);
                    }
                },
                configurable: true
            });

            function checkUniversalErrorRecovery() {
                // 如果正在处理底层的原地重试，不要干预
                if (helper.state.isInplaceRetry || helper.state.isFixingMode) return;

                const now = Date.now();
                // 停机前 2.5 秒内有过业务报错？抓到你了！
                if (helper.state.errorOccurredTime && (now - helper.state.errorOccurredTime < 2500)) {
                    helper.state.errorOccurredTime = 0;
                    helper.state.isFixingMode = true; // 直接进入修复模式
                    helper.state.retryCount = 0;

                    const errorDetails = helper.state.lastErrorReason;
                    currentCtx.ui.notify(`[Guardian] Business error detected. Handing over to LLM for repair...`, "warning");

                    // 退出 Auto Mode 后，把错误发给 LLM 要求修复 (非原地，享受全新上下文)
                    setTimeout(() => {
                        pi.sendMessage({
                            customType: "gsd-guardian-fix",
                            content: `**AUTO-MODE PAUSED DUE TO VALIDATION ERROR**\n\nThe system rejected your previous output with the following error:\n\`\`\`\n${errorDetails}\n\`\`\`\n\nPlease deeply analyze the workspace and fix the blocking issues (e.g., missing fields, unmet schema requirements, broken references). Do NOT proceed with the main task yet. I will automatically resume Auto Mode after you finish.`,
                            display: true
                        }, { triggerTurn: true, deliverAs: "followUp" });
                    }, 1500);
                }
            }
            s.__guardian_state_patched = true;
        }
        uiSessionPatched = true;
    }

    // ── Patch 4: Hijack pi.sendMessage ──
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

                // 只有 Schema/崩溃 导致的原地重试才需要覆盖 Prompt，业务修复使用原生流程
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
        patchUIAndSession(helper); // 启动全局业务错误捕获器
        patchSendMessage(helper);
    }

    return { applyAll };
}
