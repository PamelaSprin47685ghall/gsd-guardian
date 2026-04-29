# gsd-guardian

GSD Guardian - Intelligent retry and self-repair system for GSD auto-mode.

## Features

- **Smart Retry**: Exponential backoff retry for transient failures
- **Context Preservation**: In-place retry without clearing LLM context
- **Self-Repair Loop**: Automatically hands off to LLM for complex issues
- **Auto-Resume**: Seamlessly resumes auto-mode after LLM fixes the problem
- **Cross-Platform**: Works with npm global, nvm, and local installations

## Installation

```bash
npm install -g gsd-guardian
```

Or link locally for development:

```bash
npm link
```

## Usage

The plugin activates automatically when GSD is running. No manual configuration needed.

### Troubleshooting

If the plugin can't find GSD modules, enable debug mode:

```bash
GUARDIAN_DEBUG=1 pi
```

This will show all searched paths and help diagnose installation issues.

### Supported Installation Methods

- npm global install (`npm install -g gsd-pi`)
- nvm managed Node.js versions
- Local development setup
- Custom paths via `GSD_CODING_AGENT_DIR` or `GSD_PKG_ROOT` environment variables

## How It Works

1. **Schema/Tool Errors**: Retries in-place up to 10 times with exponential backoff
2. **Business Errors**: Detects validation failures, pauses auto-mode, and asks LLM to fix
3. **Auto-Resume**: After LLM completes the fix, automatically restarts `/gsd auto`

## Architecture

The plugin is organized into focused modules:

- **discovery.js**: Dynamic module loading - locates and loads GSD's internal `auto` and `auto-runtime-state` modules at runtime via realpath-resolved ESM import. Searches multiple common installation paths.
- **state.js**: State management - maintains retry count, fixing mode flags, context caching, and sleep interruption state
- **patch.js**: Runtime monkey-patching - hijacks `AutoSession.cmdCtx.newSession()`, `verificationRetryCount` Map, `ui.notify()`, and `pi.sendMessage()` for in-place retry, business error detection, and exponential backoff
- **guardian.js**: Main coordinator - orchestrates module loading, patching, event interception, and the complete LLM self-repair loop

### Key Features

- **In-Place Retry**: Hijacks `cmdCtx.newSession()` to suppress new session creation during retries, keeping full context
- **Turn-End Error Masking**: Listens on `turn_end` to mutate `msg.stopReason` from `"error"` to `"stop"` before `agent_end` fires—both events share the same message object by JavaScript reference
- **Business Error Detection**: Intercepts `ui.notify()` to capture validation errors and GSD pause signals, triggering LLM repair mode
- **Exponential Backoff**: Implements safe sleep with interruption support (1s, 2s, 4s... max 30s)
- **LLM Self-Healing**: After 10 consecutive failures or business validation errors, sends a critical fix prompt requesting the LLM to diagnose and repair the workspace
- **Auto-Resume**: Monitors `agent_end` to detect when LLM completes repair, then automatically calls `startAutoDetached()` to resume auto-mode
- **Context Caching**: Preserves valid `cmdCtx` references to ensure robust recovery even if original context becomes stale
- **Manual Mode Error Recovery**: Detects errors in manual mode via `turn_end`-stamped `__manual_error` and triggers automatic retry prompts
- **FollowUp Messages**: Uses Pi's `deliverAs: "followUp"` to append retry prompts without losing context

## License

MIT
