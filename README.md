## Architecture

The plugin is organized into focused modules:

- **discovery.js**: Dynamic module loading - locates and loads GSD's internal `auto` and `auto-runtime-state` modules at runtime via realpath-resolved ESM import
- **state.js**: State management - maintains retry count, fixing mode, and sleep interruption state
- **patch.js**: Runtime monkey-patching - hijacks `AutoSession.cmdCtx.newSession()`, `verificationRetryCount` Map, and `pi.sendMessage()` for in-place retry and exponential backoff
- **guardian.js**: Main coordinator - orchestrates module loading, patching, and event interception

### Key Features

- **In-Place Retry**: Hijacks `cmdCtx.newSession()` to suppress new session creation during retries, keeping full context
- **Turn-End Error Masking**: Listens on `turn_end` to mutate `msg.stopReason` from `"error"` to `"stop"` before `agent_end` fires—both events share the same message object by JavaScript reference
- **Exponential Backoff**: Implements safe sleep with interruption support (1s, 2s, 4s... max 30s)
- **LLM Self-Healing**: After 10 consecutive failures, sends a critical fix prompt requesting the LLM to diagnose and repair the workspace
- **Manual Mode Error Recovery**: Detects errors in manual mode via `turn_end`-stamped `__guardian_manual_error` and triggers automatic retry prompts
- **FollowUp Messages**: Uses Pi's `deliverAs: "followUp"` to append retry prompts without losing context