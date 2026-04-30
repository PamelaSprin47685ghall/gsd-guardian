# GSD Guardian

**Time-Freeze Auto-Recovery for GSD Auto Mode**

利用 Pi Core 的 `ctx.absorb()` 两阶段事件拦截实现**绝对不丢上下文的原地重试**。

## 文件结构

```
index.js                 # 入口（9 行）
src/
  state.js               # 内部状态机：retry/repair 计数、sleep/abort
  probe.js               # 动态探测 isAutoModeRunning
  agent-end.js           # agent_end 拦截核心：absorb + 三阶段重试/修复
  session-hijack.js      # before_agent_start 劫持 newSession 保护上下文
test/
  guardian.test.mjs      # 单元测试
```

## 原理

```
agent_end (stopReason: "error")
  → negotiate: ctx.absorb("extensions/gsd")    ← GSD 被没收，autoLoop 挂起
  → execute:   pi.sendUserMessage(errorText)    ← LLM 在原上下文看到错误
  → LLM 修复成功 → 不 absorb → GSD 收到正常事件 → 以为是第一次成功
  → LLM 再错    → 再 absorb → sendUserMessage → 循环
```

## 行为

| 条件 | 动作 |
|---|---|
| 1–10 次错误 | 指数退避 (1s–30s) 原地重试，Esc 取消 |
| 10 次耗尽 (auto-mode) | `/gsd pause` → LLM 修复回合 → 自动恢复 |
| 10 次耗尽 (非 auto) | 放弃 |
| 修复回合失败 >5 次 | 彻底停止 |

## 依赖

- Pi Core >=2.29.0（提供 `ctx.absorb()` 两阶段扩展运行器）
