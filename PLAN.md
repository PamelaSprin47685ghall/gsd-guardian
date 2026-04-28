现在要写插件支持 
1. auto mode 无论什么错误都能自动恢复，先是原地重试（任意错误码，指数退避，10 次）不行的话退出 auto mode 后，把错误本身发给 llm 要求修复，然后在 llm 回合结束后重新发送 /gsd auto 继续 auto mode 
2. step mode 和普通 mode 只是原地重试，如果不行就放弃 
3. 绕过 3 次 gsd_* 工具调用失败自动重置的机制，因为误报率太高 
4. 绕过工具 schema 调用老是不对的检查（很多时候llm需要10次尝试）5. 无论是什么模式，用户按 Esc 或者 Ctrl + C 都能成功停下来。
5. 原始代码在 ../gsd-2 目录
6. 插件结构参考 ../gsd-context-prune ../gsd-explicit-reactive ../gsd-multi-edit

# 问题

只要让控制流回到了 `autoLoop` 的 `while (s.active)` 循环中，GSD 就会执行下一轮的 `deriveState` -> `runUnit` -> `newSession()`，**上下文就会被彻底清空重置**。为了做到**“绝对不丢上下文”**且**“完美满足 5 个需求”**，我们必须改变拦截的层级。

### 核心架构思想：冻结 AutoLoop (Frozen AutoLoop) 模式

我们不应该在 `agent_end` 事件总线上做顺风车，而是要**直接拦截 `auto-loop.ts` 内部的 Promise 解析器**。

在 GSD 的设计中，`runUnit` 派发任务后，会创建一个 `Promise` 并处于 `await` 阻塞状态，直到核心模块调用 `resolveAgentEnd()` 唤醒它。
**只要我们不调用 `resolveAgentEnd()`，`autoLoop` 就会永远冻结在原地，既不会跳出 Auto Mode，也不会触发 `newSession()` 导致上下文丢失。**

我们可以利用 Pi 提供的 `deliverAs: "followUp"` 机制（追加消息模式），在不打断当前 Session 的情况下，让 LLM 在**原上下文**中不断重试。

---

### 详细方案设计

#### 1. 核心 Hook 点：Monkey Patch `resolveAgentEnd`
在插件初始化时，通过动态导入 `auto-loop.js` 和 `auto-runtime-state.js`，篡改并劫持 `resolveAgentEnd` 函数。所有的 Agent 结束信号都会先流经我们的插件逻辑。

#### 2. 状态机设计
插件内部仅维护三个变量：
*   `retryCount` (0-10)
*   `isFixingMode` (boolean，标记是否正在让 LLM 修复)
*   `cancelSleep` (用于响应 Esc 的退避打断器)

#### 3. 拦截与分流逻辑 (在重写的 `resolveAgentEnd` 中执行)

当 GSD 试图调用 `resolveAgentEnd(event)` 结束当前回合时，插件按以下顺序处理：

**步骤 A：响应用户中断 (需求 5)**
*   检查 `event.messages.last.stopReason === "aborted"`。
*   如果是，说明用户按了 Esc 或 Ctrl+C。立即调用 `cancelSleep()` 打断任何正在进行的指数退避等待，清空 `retryCount` 和 `isFixingMode`。
*   **直接调用原生 `originalResolveAgentEnd(event)`**，让 GSD 正常走退出或暂停流程。

**步骤 B：判断是否发生硬伤错误 (需求 3 & 4)**
判定本次回合失败的两个条件（满足其一即视为失败）：
1.  `stopReason === "error"`：代表触发了底层 `agent-loop.ts` 的 3 次 Schema 错误校验上限，或网络/模型崩溃。
2.  `gsdSession.lastToolInvocationError !== null`：代表 GSD 工具（如 `gsd_complete_slice`）调用失败（例如 JSON 截断或参数错误）。这拦截了 GSD 原本会在下一步校验中触发的 3 次重试机制。

**步骤 C：执行原地重试 (需求 2 & 保持上下文)**
如果判定为失败，且 `retryCount < 10`：
1.  `retryCount++`。
2.  计算指数退避时间（1s, 2s, 4s... 封顶 30s），执行可被打断的异步等待（Sleep）。
3.  构造错误提示词：`"Tool/Execution failed with error: <报错信息>. Please correct your parameters and try again."`
4.  调用 `pi.sendMessage({ ..., content: 提示词 }, { triggerTurn: true, deliverAs: "followUp" })`。
    *   *核心魔法*：`deliverAs: "followUp"` 会将这句话作为 User Message 追加到当前上下文的末尾，并再次唤醒 LLM。
5.  **直接 `return`，绝对不调用原生的 `originalResolveAgentEnd`！**
    *   因为没有调用，`autoLoop` 依然在沉睡，上下文完好无损，LLM 开始基于之前的历史记录进行原地重试。

**步骤 D：10 次重试耗尽的处理 (需求 1 & 普通模式隔离)**
如果 `retryCount >= 10`：
1.  重置 `retryCount = 0`。
2.  **检查模式**：通过 `isAutoActive()` 检查当前是否是 Auto Mode。
    *   **如果不是 Auto Mode (普通模式/Step 模式)**：直接调用 `originalResolveAgentEnd(event)`，让其正常失败退出，把控制权还给用户。**绝对不触发任何 `/gsd auto` (满足补充要求)**。
    *   **如果是 Auto Mode**：
        1. 开启 `isFixingMode = true`。
        2. 发送提示词：`"10 consecutive failures detected. Please analyze the workspace and fix the blocking issues. Do NOT proceed with the main task yet."`
        3. 同样使用 `deliverAs: "followUp"` 发送并唤醒 LLM。
        4. **直接 `return`**（继续冻结 AutoLoop，不丢上下文）。

**步骤 E：LLM 自我修复完成的衔接 (需求 1)**
如果当前没有报错（成功执行），但 `isFixingMode === true`：
*   说明 LLM 刚刚成功执行完了修复回合。
*   重置 `isFixingMode = false`。
*   发送最后一条引导消息：`"Fix completed. Now, please execute the original tool/step that failed earlier."` (通过 `followUp` 发送)。
*   **直接 `return`**。让 LLM 带着修复好的状态和完整上下文，去真正完成最初失败的任务。当它再次成功时，就会进入下方的正常结束流程。

**步骤 F：正常成功结束**
如果当前没有报错，且 `isFixingMode === false`：
*   重置所有插件计数器。
*   **调用原生 `originalResolveAgentEnd(event)`**。
*   此时 GSD 接收到成功的执行结果，解除 `runUnit` 的阻塞，拿着完整的产物开开心心地进入 `postUnitPreVerification` 校验环节。

---

### 方案优势总结

1. **绝对不丢上下文**：通过劫持 `resolveAgentEnd` 并利用 `deliverAs: "followUp"`，所有的重试和修复对话都在同一个大上下文中进行，底层的 AutoLoop 根本不知道发生了 10 次重试。
2. **精准绕过 3 次 Schema 限制 (需求 4)**：底层抛出 Schema Error 后，插件截获并化解了这个 Error，LLM 得以在原对话中继续尝试第 4、5、6 次。
3. **精准绕过 3 次 GSD 工具限制 (需求 3)**：在 GSD 的 `autoLoop` 发现工具失败前，插件就已经把错误扣留，让 LLM 重新生成参数，GSD 的重试计数器永远是 0。
4. **严格隔离普通模式**：通过 `isAutoActive()` 严格分流，普通模式 10 次失败后原样抛出，绝不越权重启 Auto Mode。
5. **安全可靠的打断 (需求 5)**：所有异步 Sleep 均与 Esc 信号 (`stopReason === "aborted"`) 绑定，按下即刻放行原生机制，毫无粘连。

# 粗略实现

这是基于“冻结 AutoLoop (Frozen AutoLoop)”思想的粗略代码方案。代码重点展示了如何通过劫持 `resolveAgentEnd` 和使用 `followUp` 机制来实现**绝对不丢上下文**的无限次/10次原地重试与修复。

你可以将此作为核心逻辑交给开发人员去完善和集成：

```typescript
import { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

// 动态引入 GSD 内部模块
let gsdAutoLoop: any = null;
let gsdSessionStore: any = null;
let gsdAutoApi: any = null;

import("../auto-loop.js").then(m => gsdAutoLoop = m).catch(() => {});
import("../auto-runtime-state.js").then(m => gsdSessionStore = m).catch(() => {});
import("../auto.js").then(m => gsdAutoApi = m).catch(() => {});

export function activate(pi: ExtensionAPI) {
    const MAX_RETRIES = 10;
    
    // 插件状态机
    let retryCount = 0;
    let isFixingMode = false;
    let cancelSleep: (() => void) | null = null;
    let originalResolveAgentEnd: Function | null = null;

    // 安全的退避等待（支持随时被打断）
    async function safeSleep(ms: number) {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                cancelSleep = null;
                resolve();
            }, ms);
            cancelSleep = () => {
                clearTimeout(timer);
                cancelSleep = null;
                reject(new Error("aborted"));
            };
        });
    }

    function resetPluginState() {
        retryCount = 0;
        isFixingMode = false;
        if (cancelSleep) cancelSleep();
    }

    // 核心劫持：只在首次激活或 Session Start 时 Patch 一次
    function patchAutoLoop() {
        if (gsdAutoLoop && !originalResolveAgentEnd) {
            originalResolveAgentEnd = gsdAutoLoop.resolveAgentEnd;
            
            // 劫持 GSD 的底层 Promise 唤醒器
            gsdAutoLoop.resolveAgentEnd = async function (event: any) {
                const lastMsg = event.messages[event.messages.length - 1] as any;
                const stopReason = lastMsg?.stopReason;
                const errorMsg = lastMsg?.errorMessage || "Unknown execution error";
                
                const gsdSession = gsdSessionStore?.autoSession;
                const toolInvocationError = gsdSession?.lastToolInvocationError;

                // ==========================================
                // 需求 5: 响应用户中断 (Esc / Ctrl+C)
                // ==========================================
                if (stopReason === "aborted") {
                    resetPluginState();
                    // 立即放行，让 GSD 正常中止
                    return originalResolveAgentEnd!.call(this, event);
                }

                // 判断是否发生硬伤错误：Schema 错误 或 GSD 工具内部报错
                const isError = stopReason === "error" || toolInvocationError != null;
                const combinedErrorMsg = toolInvocationError || errorMsg;

                // ==========================================
                // 需求 3 & 4: 拦截错误并执行原地重试 (不丢上下文)
                // ==========================================
                if (isError) {
                    if (retryCount < MAX_RETRIES) {
                        retryCount++;
                        const delayMs = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
                        
                        pi.sendMessage({
                            customType: "guardian-notify",
                            content: `[Guardian] Error detected. In-place retry ${retryCount}/${MAX_RETRIES} in ${delayMs/1000}s...`,
                            display: true
                        });

                        try {
                            await safeSleep(delayMs);
                        } catch (e) {
                            return; // 用户在 sleep 期间按了 Esc，交由下一次 aborted 事件处理
                        }

                        // 清理 GSD 的状态残留，防止干扰下一次执行
                        if (gsdSession) gsdSession.lastToolInvocationError = null;

                        // 核心：使用 followUp 发送，直接追加到原上下文，绝不触发 newSession！
                        pi.sendMessage({
                            customType: "guardian-retry",
                            content: `Tool or Schema execution failed with error:\n\`\`\`\n${combinedErrorMsg}\n\`\`\`\nPlease carefully correct your parameters and retry the exact same step immediately.`,
                            display: false
                        }, { triggerTurn: true, deliverAs: "followUp" });

                        // 拦截结束，绝对不调用 originalResolveAgentEnd，冻结 AutoLoop！
                        return;
                    } 
                    // ==========================================
                    // 10 次耗尽后的处理
                    // ==========================================
                    else {
                        retryCount = 0;
                        const isAuto = gsdAutoApi?.isAutoActive() || false;

                        if (isAuto) {
                            // 需求 1: Auto 模式下进入 LLM 修复模式
                            isFixingMode = true;
                            if (gsdSession) gsdSession.lastToolInvocationError = null;

                            pi.sendMessage({
                                customType: "guardian-fix",
                                content: `**CRITICAL FAILURE**\nWe hit the 10-retry limit. Error:\n\`\`\`\n${combinedErrorMsg}\n\`\`\`\nPlease deeply analyze the workspace and fix any blocking issues (e.g., compile errors, schema issues). Do NOT proceed with the main task yet.`,
                                display: true
                            }, { triggerTurn: true, deliverAs: "followUp" });
                            
                            // 继续冻结 AutoLoop
                            return;
                        } else {
                            // 需求 2: 非 Auto 模式下直接放弃，放行给 GSD 抛出错误
                            return originalResolveAgentEnd!.call(this, event);
                        }
                    }
                }

                // ==========================================
                // 成功执行路径
                // ==========================================
                if (!isError) {
                    if (isFixingMode) {
                        // 需求 1: 修复回合成功结束，要求 LLM 继续刚才失败的任务
                        isFixingMode = false;
                        retryCount = 0;
                        
                        pi.sendMessage({
                            customType: "guardian-resume",
                            content: `Fix completed. Now, please execute the original tool or step that failed earlier to proceed with the task.`,
                            display: true
                        }, { triggerTurn: true, deliverAs: "followUp" });
                        
                        // 继续冻结 AutoLoop，等待最终的工具调用成功
                        return;
                    }

                    // 完全正常成功，重置插件状态，放行给 GSD 的 AutoLoop 往下走
                    resetPluginState();
                    return originalResolveAgentEnd!.call(this, event);
                }
            };
        }
    }

    pi.on("session_start", () => {
        resetPluginState();
        patchAutoLoop();
    });

    pi.on("before_agent_start", () => {
        patchAutoLoop(); // 防御性调用，确保 Patch 成功
    });

    pi.on("session_shutdown", () => {
        resetPluginState();
    });
}
```

### 代码方案核心点解释：

1. **`originalResolveAgentEnd` 的拦截与劫持**：
   只在最终完全成功（或普通模式下放弃）时，才调用 `originalResolveAgentEnd!.call(this, event)`。只要不调用它，底层的 `await runUnit()` 就永远处于 Pending 状态。这就实现了所谓的 **冻结 AutoLoop**。
2. **`deliverAs: "followUp"` 的魔力**：
   在 `pi.sendMessage` 时传入 `{ triggerTurn: true, deliverAs: "followUp" }`。这是 Pi 核心提供的机制，它会**直接在当前活跃的 Session 中追加一条 User 消息**并立即触发 LLM 思考，而不会触发任何新 Session 的创建，从而完美保留所有工具调用和聊天历史。
3. **`isFixingMode` 状态流转**：
   进入修复模式时，发送指令让 LLM 排查问题（冻结 AutoLoop）；LLM 修复结束后再次回到 `resolveAgentEnd`，此时没有报错且 `isFixingMode = true`，立刻再追加一条 `followUp` 告诉 LLM “修好了，现在去执行刚才失败的工具吧”（继续冻结）。直到 LLM 再次调用工具并真正成功，才会解除拦截，让 AutoLoop 进行下一步产物校验。
4. **清理 `lastToolInvocationError`**：
   在派发重试/修复的 Prompt 之前，手动把 `gsdSession.lastToolInvocationError = null` 擦除。如果不擦除，即使 LLM 下一回合修复了，我们的逻辑或者原生的 `postUnitPreVerification` 还是会读到上一次的死尸错误，导致无限死循环。