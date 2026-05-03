# Guardian Spec

Version: `5.1.0`.

`README.md` explains usage. This file defines the recovery state machine, watchdog, retry, and compatibility contract.

## Public surface

| Capability | Names |
|---|---|
| Hooks | `agent_end`, `notification`, `session_before_switch`, `session_start`, `before_agent_start`, `stop` |
| Commands | none |
| Tools | none |

## Recovery state machine

Guardian operates a two-phase recovery: retry then repair.

```
idle → retrying → repairing → idle
         ↓ (exhausted)    ↓ (exhausted)
        report           report
```

- `idle`: no recovery in progress.
- `retrying`: same repair strategy, incremented `retryCount`. Retries are bounded by `RETRY_MAX` (env var, default 2).
- `repairing`: repair handoff started. `repairCount` bounds repair attempts (default 1).
- When both retry and repair are exhausted, Guardian reports the failure and returns to `idle`.

State is held in a module-level `state` object. `resetRecoveryState()` clears all recovery counters. `resetForNewSession()` also cancels in-flight sleep timers — called on `session_start` to prevent cross-session state leakage.

## Watchdog

Guardian's watchdog schedules a sleep after each agent turn. If the agent starts a new turn before the sleep fires, the timer is cancelled (optimistic path). If the sleep fires, the watchdog inspects the latest agent output for recoverable failure patterns.

The sleep duration defaults to 5 seconds and is configurable via the `WATCHDOG_DELAY_MS` env var.

## Notification listener

Guardian subscribes to the `notification` hook to detect explicit failure signals from other extensions. It matches against a known set of failure patterns and triggers recovery only for those.

Failures detected via notification bypass the watchdog delay — they are processed immediately.

## Session boundaries

- `session_start` calls `resetForNewSession()` to clear all state and cancel pending timers.
- `session_before_switch` marks the transition so ordinary navigation does not trigger recovery.
- `stop` calls `cancelSleepOnly()` to abort pending watchdog timers without resetting recovery counters.

## Retry configuration

| Env var | Default | Purpose |
|---|---|---|
| `RETRY_MAX` | 2 | Maximum retries before repair handoff |
| `WATCHDOG_DELAY_MS` | 5000 | Delay before inspecting agent output |

`RETRY_MAX` and `WATCHDOG_DELAY_MS` use `parseEnvInt()` for robust parsing — `0` is valid, non-numeric strings fall back to defaults.

## Full-suite compatibility

Guardian must coexist with the rest of the suite:

- `before_agent_start` injection must not conflict with Agent Loop or Magic Todo prompts.
- Agent-end recovery must not interfere with Agent Loop's loop state.
- Notification handling must not interpret sibling-extension informational messages as failures.
- Forked sessions and subagents must inherit the extension through bundled-extension self-injection.

## Verification

```bash
npm test
```