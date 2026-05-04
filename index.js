import { ensureBundledExtensionPath } from './src/self-injection.js'
import {
  createAgentEndHandler,
  markNextAgentEndAsSessionSwitch,
} from './src/agent-end.js'
import { setupNotificationListener } from './src/notification-listener.js'
import { cancelSleepOnly, resetForNewSession } from './src/state.js'
import {
  startWatchdog,
  stopWatchdog,
  markAgentStarted,
} from './src/watchdog.js'

ensureBundledExtensionPath(import.meta.url)

const registeredPluginApis = new WeakSet()

export default function guardianPlugin(pi) {
  if (registeredPluginApis.has(pi)) return

  try {
    pi.on('agent_end', createAgentEndHandler(pi))
    setupNotificationListener(pi)

    pi.on('session_before_switch', () => {
      markNextAgentEndAsSessionSwitch(pi)
    })

    // Start watchdog when session starts; reset recovery state for fresh session
    pi.on('session_start', (event, ctx) => {
      resetForNewSession(pi)
      const basePath = ctx?.cwd || process.cwd()
      startWatchdog(pi, ctx, basePath)
    })

    // Mark agent started to stop watchdog
    pi.on('before_agent_start', () => {
      markAgentStarted(pi)
    })

    // Stop watchdog on stop
    pi.on('stop', (event) => {
      stopWatchdog(pi)
      if (event?.reason === 'cancelled') {
        cancelSleepOnly(pi)
        resetForNewSession(pi)
      }
    })

    registeredPluginApis.add(pi)
  } catch (error) {
    registeredPluginApis.delete(pi)
    throw error
  }
}
