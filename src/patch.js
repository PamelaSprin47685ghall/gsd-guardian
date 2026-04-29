// Guardian Plugin - Runtime Object Patches

const MAX_RETRIES = 10;
let gsdModsStore = null;

export function setGsdRuntimeModules(mods) {
    gsdModsStore = mods;
}

export function createPatcher(pi) {
    let cmdCtxPatched = false;
    let retryMapPatched = false;
    let sendMsgPatched = false;
    let uiPatched = false;
    let currentCtx = null;

    // ── Patch 1: Hijack AutoSession.cmdCtx.newSession() ──
    function patchCmdCtx(helper) {
        const sessionStore = gsdModsStore?.["auto-runtime-state"];
        const ctx = sessionStore?.autoSession?.cmdCtx;
        
        // 缓存可用的 ctx 以备复活时使用
        if (ctx && typeof ctx.newSession === "function") {
            helper.state.validCmdCtx = ctx;
            
            if (!ctx.__guardian_patched) {
                const orig = ctx.newSession;
                ctx.newSession = async function (opts) {
                    if (helper.state.isInplaceRetry) {
                        helper.state.isInplaceRetry = false;
                        return { cancelled: false }; // 原地重试，不清理上下文
                    }
                    return orig.apply(this, [opts]);
                };
                ctx.__guardian_patched = true;
            }
        }
    }

    // ── Patch 2: 拦截验证重试 Map (处理 Schema/工具错误) ──
    function patchRetryMap(helper) {
        const sessionStore = gsdModsStore?.["auto-runtime-state"];
        const map = sessionStore?.autoSession?.verificationRetryCount;
        if (!map || map.__guardian_patched) return;

        const origSet = map.set.bind(map);
        const origDelete = map.delete.bind(map);

        map.set = function (key, val) {
            helper.state.retryCount++;
            if (helper.state.retryCount <= MAX_RETRIES) {
                helper.state.isInplaceRetry = true;
                helper.state.needsSleep = true;
                return origSet(key, 1); // 欺骗 GSD：始终是第1次重试
            }
            
            // 10 次上限耗尽：进入修复模式
            helper.state.retryCount = 0;
            helper.state.isFixingModePending = true;
            
            // 使用 setTimeout 等待 GSD 彻底 Pause 后，触发发信
            setTimeout(() => {
                pi.sendMessage({ customType: "trigger", content: "" }, { triggerTurn: true });
            }, 1000);
            
            return origSet(key, 4); // 塞入 4 触发原生的 Pause
        };

        map.delete = function (key) {
            helper.state.retryCount = 0;
            return origDelete(key);
        };
        map.__guardian_patched = true;
    }

    // ── Patch 3: 业务错误探针 (拦截 UI 打印) ──
    function patchUI(helper) {
        if (!currentCtx || currentCtx.ui.__guardian_patched) return;

        let lastErrorStr = "";
        let errorTime = 0;
        const origNotify = currentCtx.ui.notify.bind(currentCtx.ui);
        
        currentCtx.ui.notify = function(msg, level) {
            if (typeof msg === "string" && !msg.includes("[Guardian]")) {
                
                // 1. 抓取红色报错
                if (level === "error" || level === "warning") {
                    if (Date.now() - errorTime < 1000) {
                        lastErrorStr += "\n" + msg;
                    } else {
                        lastErrorStr = msg;
                    }
                    errorTime = Date.now();
                }

                // 2. 捕捉到 GSD 停机指令
                if (msg.includes("mode paused") && msg.includes("to resume")) {
                    // 如果停机前 3 秒内有业务报错，说明是被错误卡停的
                    if (Date.now() - errorTime < 3000) {
                        origNotify(`[Guardian] Business issue detected. Handing over to LLM for repair...`, "warning");
                        
                        helper.state.lastBusinessError = lastErrorStr;
                        helper.state.isFixingModePending = true;
                        
                        // 等待 GSD 停稳后，触发修复指令发信
                        setTimeout(() => {
                            pi.sendMessage({ customType: "trigger", content: "" }, { triggerTurn: true });
                        }, 1000);
                    }
                }
            }
            return origNotify(msg, level);
        };
        currentCtx.ui.__guardian_patched = true;
    }

    // ── Patch 4: 拦截消息发送 (注入修复提示 & 原地重试提示) ──
    function patchSendMessage(helper) {
        if (sendMsgPatched) return;
        const origSend = pi.sendMessage.bind(pi);
        
        pi.sendMessage = function (msg, opts) {
            // 优先处理：进入 LLM 修复模式
            if (helper.state.isFixingModePending) {
                helper.state.isFixingModePending = false;
                helper.state.isFixingMode = true; // 标记 LLM 正在修复

                let fixContent = "";
                if (helper.state.lastBusinessError) {
                    fixContent = `**AUTO-MODE PAUSED DUE TO VALIDATION ERROR**\nThe system rejected your previous output with:\n\`\`\`\n${helper.state.lastBusinessError}\n\`\`\`\nPlease deeply analyze the workspace and fix the blocking issues (e.g., missing fields, unmet requirements). Do NOT proceed with the main task yet. I will resume Auto Mode after you finish.`;
                    helper.state.lastBusinessError = null;
                } else {
                    fixContent = `**CRITICAL FAILURE**\n10 consecutive schema/execution failures occurred. Auto Mode is paused.\nPlease deeply analyze the workspace, fix any logical or schema errors. Do NOT try to proceed with the main task yet.`;
                }

                return origSend({
                    customType: "gsd-guardian-fix",
                    content: fixContent,
                    display: true
                }, { triggerTurn: true, deliverAs: "followUp" });
            }

            // 处理：Schema 原地重试
            if (helper.state.needsSleep) {
                helper.state.needsSleep = false;
                const delayMs = Math.min(1000 * Math.pow(2, helper.state.retryCount - 1), 30000);
                currentCtx?.ui?.notify?.(`[Guardian] In-place retry ${helper.state.retryCount}/${MAX_RETRIES} in ${delayMs/1000}s...`, "warning");

                if (helper.state.schemaErrorMsg) {
                    msg = {
                        customType: "gsd-guardian-retry",
                        content: `**EXECUTION ERROR**\nThe tool failed with:\n\`\`\`\n${helper.state.schemaErrorMsg}\n\`\`\`\nPlease correct your parameters and retry exactly the same step.`,
                        display: false
                    };
                    helper.state.schemaErrorMsg = null;
                }

                helper.safeSleep(delayMs).then(() => {
                    origSend(msg, { ...opts, deliverAs: "followUp" }); // 原地追加
                }).catch(() => {});
                return;
            }

            return origSend(msg, opts);
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
