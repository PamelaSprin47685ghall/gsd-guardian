// Guardian Plugin - Runtime Object Patches

const MAX_RETRIES = 10;
let gsdSessionStore = null;
let gsdModsStore = null;

export function setGsdRuntimeModules(mods) {
    gsdModsStore = mods;
    gsdSessionStore = mods?.["auto-runtime-state"] ?? null;
}

export function createPatcher(pi) {
    let cmdCtxPatched = false;
    let retryMapPatched = false;
    let sendMsgPatched = false;
    let uiPatched = false;
    let currentCtx = null;

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    function patchCmdCtx(helper) {
        const ctx = gsdSessionStore?.autoSession?.cmdCtx;
        if (ctx && typeof ctx.newSession === "function") {
            // 实时更新缓存，永远保持最新
            helper.state.validCmdCtx = ctx; 

            if (!ctx.__guardian_patched) {
                const orig = ctx.newSession;
                ctx.newSession = async function (opts) {
                    if (helper.state.isInplaceRetry) {
                        helper.state.isInplaceRetry = false;
                        return { cancelled: false };
                    }
                    return orig.apply(this, [opts]);
                };
                ctx.__guardian_patched = true;
            }
        }
    }

    // ── Patch 2: Hijack verificationRetryCount Map ──
    function patchRetryMap(helper) {
        const map = gsdSessionStore?.autoSession?.verificationRetryCount;
        if (!map || retryMapPatched) return;
        const origSet = map.set.bind(map);
        const origDelete = map.delete.bind(map);

        map.set = function (key, val) {
            helper.state.schemaRetryCount++;
            if (helper.state.schemaRetryCount <= MAX_RETRIES) {
                helper.state.isInplaceRetry = true;
                helper.state.needsSleep = true;
                return origSet(key, 1);
            }
            helper.state.schemaRetryCount = 0;
            helper.state.hiddenToolError = null;
            return origSet(key, val); 
        };

        map.delete = function (key) {
            helper.state.schemaRetryCount = 0;
            return origDelete(key);
        };
        retryMapPatched = true;
    }

    // ── Patch 3: 业务错误探针 (触发非原地重试) ──
    function patchUI(helper) {
        if (!currentCtx || uiPatched) return;
        if (!currentCtx.ui.__guardian_patched) {
            let lastErrorOrWarning = "";
            let errorTime = 0;

            const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
            currentCtx.ui.notify = function(msg, level) {
                if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                    
                    if (level === "error" || level === "warning") {
                        if (Date.now() - errorTime < 1000) {
                            lastErrorOrWarning += "\n" + msg;
                        } else {
                            lastErrorOrWarning = msg;
                        }
                        errorTime = Date.now();
                    }

                    if (msg.includes("mode paused") && msg.includes("to resume")) {
                        if (Date.now() - errorTime < 3000) {
                            helper.state.businessRetryCount++;
                            if (helper.state.businessRetryCount <= MAX_RETRIES) {
                                currentCtx.ui.notify(`[Guardian] Business logic issue detected. Restarting pipeline (Attempt ${helper.state.businessRetryCount}/${MAX_RETRIES})...`, "warning");
                                helper.state.pendingBusinessError = lastErrorOrWarning;
                                
                                setTimeout(() => {
                                    const api = gsdModsStore?.["auto"];
                                    if (api) {
                                        // 终极武器：我们自己造一个绝对不会报错的 Context！
                                        const robustCtx = helper.state.validCmdCtx || currentCtx;
                                        if (typeof robustCtx.newSession !== "function") {
                                            robustCtx.newSession = async (opts) => {
                                                if (helper.state.isInplaceRetry) {
                                                    helper.state.isInplaceRetry = false;
                                                    return { cancelled: false };
                                                }
                                                // 退化到通过 sessionManager 创建
                                                try {
                                                    const res = await currentCtx.sessionManager?.newSession(opts);
                                                    return res ?? { cancelled: false };
                                                } catch (e) {
                                                    return { cancelled: false };
                                                }
                                            };
                                        }
                                        if (typeof robustCtx.getContextUsage !== "function") {
                                            robustCtx.getContextUsage = () => ({ percent: 50, tokens: 50000, limit: 100000 });
                                        }

                                        api.startAutoDetached(robustCtx, pi, process.cwd(), false);
                                    }
                                }, 1500);
                            } else {
                                currentCtx.ui.notify(`[Guardian] Business retries exhausted. Manual intervention required.`, "error");
                                helper.state.businessRetryCount = 0;
                            }
                        }
                    }
                }
                return origNotify(msg, level);
            };
            currentCtx.ui.__guardian_patched = true;
            uiPatched = true;
        }
    }

    // ── Patch 4: 拦截消息发送 ──
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            
            if (helper.state.pendingBusinessError) {
                const injectedContent = `${msg.content}\n\n**PREVIOUS VALIDATION FAILED**\nYour previous attempt was rejected with:\n\`\`\`\n${helper.state.pendingBusinessError}\n\`\`\`\nPlease analyze the current file state and fix this issue.`;
                msg.content = injectedContent;
                helper.state.pendingBusinessError = null;
                return orig(msg, opts);
            }

            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.schemaRetryCount - 1), 30000);
                currentCtx?.ui?.notify?.(`[Guardian] Auto Mode in-place retry ${helper.state.schemaRetryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");

                let finalMsg = msg;
                const finalOpts = { ...opts, deliverAs: "followUp" };

                if (helper.state.hiddenToolError) {
                    finalMsg = {
                        customType: "gsd-guardian-retry",
                        content: `**EXECUTION ERROR**\nThe tool execution failed with:\n\`\`\`\n${helper.state.hiddenToolError}\n\`\`\`\nPlease carefully correct your parameters/schema and retry exactly the same step.`,
                        display: false
                    };
                    helper.state.hiddenToolError = null;
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
