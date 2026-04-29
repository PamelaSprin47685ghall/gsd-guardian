// Guardian Plugin - Runtime Object Patches

const MAX_RETRIES = 10;
let gsdModsStore = null;

export function setGsdRuntimeModules(mods) {
    gsdModsStore = mods;
}

export function createPatcher(pi) {
    let cmdCtxPatched = false;
    let uiPatched = false;
    let currentCtx = null;

    // ── Patch 1: 拦截 newSession (防止上下文清理) ──
    function patchCmdCtx(helper) {
        const sessionStore = gsdModsStore?.["auto-runtime-state"];
        const ctx = sessionStore?.autoSession?.cmdCtx;
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

    // ── Patch 2: 拦截 UI 打印 (全能业务探针) ──
    function patchUI(helper) {
        if (!currentCtx || uiPatched) return;
        if (!currentCtx.ui.__guardian_patched) {
            let lastErrorStr = "";
            let errorTime = 0;
            const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
            
            currentCtx.ui.notify = function(msg, level) {
                if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                    
                    if (level === "error" || level === "warning") {
                        if (Date.now() - errorTime < 1000) {
                            lastErrorStr += "\n" + msg;
                        } else {
                            lastErrorStr = msg;
                        }
                        errorTime = Date.now();
                    }

                    if (msg.includes("mode paused") && msg.includes("to resume")) {
                        if (Date.now() - errorTime < 3000) {
                            helper.state.businessRetryCount++;
                            if (helper.state.businessRetryCount <= MAX_RETRIES) {
                                origNotify(`[Guardian] Business issue detected. Restarting pipeline (${helper.state.businessRetryCount}/${MAX_RETRIES})...`, "warning");
                                helper.state.pendingBusinessError = lastErrorStr;
                                
                                setTimeout(() => {
                                    const api = gsdModsStore?.["auto"];
                                    if (api) {
                                        const robustCtx = currentCtx;
                                        if (typeof robustCtx.newSession !== "function") {
                                            robustCtx.newSession = async (opts) => {
                                                try {
                                                    const res = await currentCtx.sessionManager?.newSession(opts);
                                                    return res ?? { cancelled: false };
                                                } catch (e) { return { cancelled: false }; }
                                            };
                                        }
                                        api.startAutoDetached(robustCtx, pi, process.cwd(), false);
                                    }
                                }, 1500);
                            } else {
                                origNotify("[Guardian] Business retries exhausted.", "error");
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

    // ── Patch 3: 拦截消息发送 (注入报错) ──
    function patchSendMessage(helper) {
        if (pi.__guardian_send_patched) return;
        const origSend = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            
            // 业务错误注入 (非原地重试，上下文已刷新)
            if (helper.state.pendingBusinessError) {
                msg.content = `${msg.content}\n\n**PREVIOUS ATTEMPT FAILED**\nThe system rejected your previous output:\n\`\`\`\n${helper.state.pendingBusinessError}\n\`\`\`\nPlease fix this issue.`;
                helper.state.pendingBusinessError = null;
                return origSend(msg, opts);
            }

            // Schema 原地重试 
            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.schemaRetryCount - 1), 30000);
                currentCtx?.ui?.notify?.(`[Guardian] In-place retry ${helper.state.schemaRetryCount}/${MAX_RETRIES} in ${delayMs/1000}s...`, "warning");

                if (helper.state.schemaErrorMsg) {
                    msg = {
                        customType: "gsd-guardian-retry",
                        content: `**EXECUTION ERROR**\nThe tool failed with:\n\`\`\`\n${helper.state.schemaErrorMsg}\n\`\`\`\nPlease carefully correct your parameters and retry exactly the same step.`,
                        display: false
                    };
                    helper.state.schemaErrorMsg = null;
                }

                helper.safeSleep(delayMs).then(() => {
                    origSend(msg, { ...opts, deliverAs: "followUp" }); 
                }).catch(() => {});
                return;
            }

            return origSend(msg, opts);
        };
        pi.__guardian_send_patched = true;
    }

    function applyAll(helper, ctx) {
        if (ctx) currentCtx = ctx;
        patchCmdCtx(helper);
        patchUI(helper);
        patchSendMessage(helper);
        
        // 终极清洗：每次调用 applyAll 时，暴力清空 lastToolInvocationError
        // 这样无论 GSD 在哪里重置了 AutoSession，我们都能及时干掉它
        const sessionStore = gsdModsStore?.["auto-runtime-state"];
        if (sessionStore?.autoSession) {
            sessionStore.autoSession.lastToolInvocationError = null;
        }
    }

    return { applyAll };
}
