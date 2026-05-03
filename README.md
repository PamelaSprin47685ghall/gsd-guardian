# Guardian

Guardian recovers selected GSD auto-mode failures without discarding the current session context. It is intentionally conservative: normal sibling-extension warnings are ignored, and only explicit auto-mode, dispatch, validation, missing-tool, or task-execution failures can trigger recovery.

Version: `5.1.0`.

## What it provides

| Capability | Name |
|---|---|
| Hooks | `agent_end`, `notification`, `session_before_switch`, `session_start`, `before_agent_start`, `stop` |
| Commands | none |
| Tools | none |

## How it works

When an agent turn ends with a recoverable error, Guardian can absorb the failure, preserve the current conversation, and ask the agent to repair the problem in place. For repeated failures it applies bounded retry and repair handoff instead of blindly looping forever.

Guardian also watches notification events for explicit failure signals. It does not recover from routine informational or warning messages emitted by other extensions.

## Recovery boundaries

Guardian is meant for recoverable automation failures, such as:

- auto-mode dispatch failures,
- validation checkpoint failures,
- missing tool surfaces,
- explicit DAG or task execution failures.

Guardian is not a general warning handler. It should not react to todo restoration notices, prompt-pruning warnings, loop status messages, or routine DAG progress logs.

## Operational notes

- Recovery state is reset on cancellation.
- Session-switch boundaries are marked so ordinary navigation does not look like a failed turn.
- Forked sessions keep the same recovery behavior automatically.

## Maintainer spec

See [`SPEC.md`](./SPEC.md) for recovery, watchdog, retry, and full-suite compatibility rules.

## Test

```bash
npm test
```
