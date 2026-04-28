## Architecture

The plugin is organized into focused modules:

- **discovery.js**: Dynamic module loading - locates and loads GSD's internal `auto-loop.js` module at runtime
- **state.js**: State management - maintains retry count, fixing mode, and sleep interruption state
- **patch.js**: Auto-loop patching - monkey patches `resolveAgentEnd` to intercept agent loop completion
- **guardian.js**: Main coordinator - orchestrates module loading, state management, and patching

### Key Features

- **Frozen AutoLoop**: Intercepts `resolveAgentEnd` to maintain full context during retries
- **FollowUp Messages**: Uses Pi's `deliverAs: "followUp"` to append retry prompts without losing context
- **Exponential Backoff**: Implements safe sleep with interruption support (1s, 2s, 4s... max 30s)
- **Error Detection**: Monitors for schema errors and tool invocation failures