import { ensureBundledExtensionPath } from "./src/self-injection.js";
import { createAgentEndHandler, markNextAgentEndAsSessionSwitch } from "./src/agent-end.js";
import { setupNotificationListener } from "./src/notification-listener.js";
import { cancelSleepOnly, resetRecoveryState } from "./src/state.js";
import { startWatchdog, stopWatchdog, markAgentStarted } from "./src/watchdog.js";

ensureBundledExtensionPath(import.meta.url);

const registeredPluginApis = new WeakSet();

export default function guardianPlugin(pi) {
  if (registeredPluginApis.has(pi)) return;
  registeredPluginApis.add(pi);

  pi.on("agent_end", createAgentEndHandler(pi));
  setupNotificationListener(pi);

  pi.on("session_before_switch", () => {
    markNextAgentEndAsSessionSwitch();
  });

  // Start watchdog when session starts
  pi.on("session_start", (event, ctx) => {
    // Get basePath from context or current directory
    const basePath = ctx?.cwd || process.cwd();
    startWatchdog(pi, ctx, basePath);
  });

  // Mark agent started to stop watchdog
  pi.on("before_agent_start", () => {
    markAgentStarted();
  });

  // Stop watchdog on stop
  pi.on("stop", (event) => {
    stopWatchdog();
    
    if (event?.reason === "cancelled") {
      cancelSleepOnly();
      resetRecoveryState();
    }
  });
}
