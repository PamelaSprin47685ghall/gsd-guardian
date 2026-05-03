import { isAutoModeRunning } from './probe.js'
import { getLastDispatchStopReason } from './journal-reader.js'
import { getState } from './state.js'
import { startRepairFlow } from './repair-flow.js'

// Per-session watchdog state using WeakMap
const sessionWatchdogs = new WeakMap()

function getWatchdogState(pi) {
  if (!sessionWatchdogs.has(pi)) {
    sessionWatchdogs.set(pi, { timer: null, agentStarted: false })
  }
  return sessionWatchdogs.get(pi)
}

/**
 * Start watchdog: if auto-mode is running but no agent starts within timeout,
 * check for dispatch-stop and trigger repair.
 */
export function startWatchdog(pi, ctx, basePath, timeoutMs = 8000) {
  const state = getWatchdogState(pi)

  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }

  state.agentStarted = false

  state.timer = setTimeout(async () => {
    state.timer = null
    if (state.agentStarted) return

    const isAuto = await isAutoModeRunning()
    if (!isAuto) return

    const currentState = getState(pi)
    if (currentState.isFixing) return

    const reason = getLastDispatchStopReason(basePath)
    if (!reason) return

    await startRepairFlow(pi, ctx, 'watchdog', reason)
  }, timeoutMs)
}

/**
 * Stop watchdog timer.
 */
export function stopWatchdog(pi) {
  if (!pi) return
  const state = getWatchdogState(pi)
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  state.agentStarted = false
}

/**
 * Mark that agent has started (called from before_agent_start hook).
 * Uses the pi instance passed from the hook context to identify the session.
 */
export function markAgentStarted(pi) {
  if (pi) {
    const state = getWatchdogState(pi)
    state.agentStarted = true
  }
}
