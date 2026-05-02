# Guardian Design

## 目标

**任何导致 auto-mode 停止的非用户主动中断，都自动恢复。**

## 架构方案

### 三层拦截机制

1. **agent_end 拦截** — 捕获 LLM 调用后的错误
2. **notification 拦截** — 捕获 GSD 发送的 error/blocked/warning 通知
3. **watchdog 拦截** — 捕获 dispatch-stop（验证失败等在 LLM 调用前的停止）

### Watchdog 机制

**问题：** dispatch-stop 发生在 LLM 调用之前，不触发 agent_end 或 notification 事件。

**解决方案：**
1. `session_start` 时启动 watchdog 定时器（3秒）
2. `before_agent_start` 时标记 agent 已启动
3. 如果定时器到期时：
   - auto-mode 仍在运行
   - 但 agent 没有启动
   - 说明卡在 dispatch 阶段
4. 读取 `.gsd/journal/*.jsonl` 最新的 `dispatch-stop` 事件
5. 提取 `reason` 并发送给 LLM 修复

**优势：**
- 无需修改 GSD 核心代码
- 能捕获所有 dispatch-stop 场景
- 有完整的错误信息用于修复

## 核心原则

### 1. 拦截规则：非正常完成的所有停止

**第一性原理：只定义什么时候不恢复，而不是定义什么时候恢复。**

不恢复的情况（白名单）：
- 用户主动中断（Esc/Ctrl+C）
- 正常完成（`stopReason: "stop"`, `"end_turn"`, `"max_tokens"`）

**其他所有情况都恢复**，包括但不限于：
- `stopReason === "error"` → 拦截
- `stopReason === "aborted"` + 有错误内容 → 拦截
- 验证失败导致的停止 → 拦截
- 任何非正常完成的停止 → 拦截

### 2. 恢复策略：重试 → 修复 → 放弃

- **重试阶段**：1-10 次，指数退避（1s → 30s），可被 Esc 取消
- **修复阶段**：重试耗尽后，LLM 修复 1-5 回合，修复成功自动恢复 auto-mode
- **放弃**：修复耗尽或非 auto-mode 重试耗尽，返回控制权

### 3. 零上下文丢失：`ctx.absorb(isGsdExtension)`

- 吞掉 GSD 的 agent_end 事件，让 auto-loop 挂起
- LLM 在原上下文看到错误并修复
- 修复成功后 GSD 以为是第一次成功

### 4. 状态隔离：手动模式 vs auto-mode

- **手动模式**：只重试，不修复
- **auto-mode**：重试 + 修复 + 自动恢复

### 5. 清理副作用：成功后清除 GSD 错误标记

- 调用 `clearLastToolInvocationError()` 防止 GSD 误判为失败

## 实现细节

### notification-listener 的 auto-mode 检查

`notification-listener.js` 在触发修复前必须检查 `isAutoModeRunning()`：

```javascript
async function startRepair(pi, message) {
  if (state.isFixing) return;

  const isAuto = await isAutoModeRunning();
  if (!isAuto) return;  // 手动模式下不触发修复

  state.isFixing = true;
  state.resumeAutoAfterRepair = true;
  // ...
}
```

这确保了：
- **手动模式**：notification 不触发修复，只有 agent_end 触发重试
- **auto-mode**：notification 和 agent_end 都可以触发修复

### notification-listener 处理 warning 级别通知

`processNotification` 处理 `"blocked"`, `"error"`, 和 `"warning"` 三种通知：

```javascript
if (entry.kind !== "blocked" && entry.kind !== "error" && entry.kind !== "warning") return;
```

这确保了：
- **验证失败**（dispatch-stop with warning level）会触发修复
- **GSD 在 dispatch 阶段暂停**时，Guardian 通过 notification 事件介入
- **无需 agent_end 事件**，在 LLM 调用之前就能捕获问题

