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

    // ── Track 1: 原地重试保障 (拦截上下文清洗) ──
    function patchCmdCtx(helper) {
        const ctx = gsdSessionStore?.autoSession?.cmdCtx;
        if (!ctx || cmdCtxPatched) return;
        const orig = ctx.newSession;
        ctx.newSession = async function (opts) {
            // 只有标记为原地重试时，才阻止清理上下文
            if (helper.state.isInplaceRetry) {
                helper.state.isInplaceRetry = false;
                return { cancelled: false };
            }
            // 业务错误重试时放行，获取干净的上下文
            return orig.apply(this, [opts]);
        };
        cmdCtxPatched = true;
    }

    // ── Track 1: 拦截产物校验失败 (触发原地重试) ──
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
                return origSet(key, 1); // 骗过 GSD：永远是第 1 次重试
            }
            // 次数耗尽，让其自然失败
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

    // ── Track 2: 业务错误探针 (触发非原地重试) ──
    function patchUI(helper) {
        if (!currentCtx || uiPatched) return;
        if (!currentCtx.ui.__guardian_patched) {
            let lastErrorOrWarning = "";
            let errorTime = 0;

            const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
            currentCtx.ui.notify = function(msg, level) {
                if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                    
                    // 1. 抓取红色报错或警告
                    if (level === "error" || level === "warning") {
                        if (Date.now() - errorTime < 1000) {
                            lastErrorOrWarning += "\n" + msg;
                        } else {
                            lastErrorOrWarning = msg;
                        }
                        errorTime = Date.now();
                    }

                    // 2. 捕捉到停机指令，且刚刚有报错
                    if (msg.includes("mode paused") && msg.includes("to resume")) {
                        if (Date.now() - errorTime < 3000) {
                            helper.state.businessRetryCount++;
                            if (helper.state.businessRetryCount <= MAX_RETRIES) {
                                currentCtx.ui.notify(`[Guardian] Business logic issue detected. Restarting pipeline (Attempt ${helper.state.businessRetryCount}/${MAX_RETRIES})...`, "warning");
                                
                                // 缓存错误信息，供新 Session 发信时注入
                                helper.state.pendingBusinessError = lastErrorOrWarning;
                                
                                // 等待 1.5 秒让 GSD 彻底清理完当前循环，然后从外部拉起新的 Auto Loop！
                                setTimeout(() => {
                                    const api = gsdModsStore?.["auto"];
                                    if (api) api.startAutoDetached(currentCtx, pi, process.cwd(), false);
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

    // ── 拦截消息发送 (分发两种重试弹药) ──
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const orig = pi.sendMessage.bind(pi);
        pi.sendMessage = function (msg, opts) {
            
            // Track 2: 业务错误注入 (非原地，刷新了上下文)
            if (helper.state.pendingBusinessError) {
                const injectedContent = `${msg.content}\n\n**PREVIOUS VALIDATION FAILED**\nYour previous attempt was rejected with:\n\`\`\`\n${helper.state.pendingBusinessError}\n\`\`\`\nPlease analyze the current file state and fix this issue.`;
                msg.content = injectedContent;
                helper.state.pendingBusinessError = null;
                return orig(msg, opts);
            }

            // Track 1: Schema 原地重试 (完美保留上下文)
            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.schemaRetryCount - 1), 30000);
                currentCtx?.ui?.notify?.(`[Guardian] Auto Mode in-place retry ${helper.state.schemaRetryCount}/${MAX_RETRIES} in ${delayMs / 1000}s...`, "warning");

                let finalMsg = msg;
                const finalOpts = { ...opts, deliverAs: "followUp" }; // 核心：使用 followUp 追击

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
