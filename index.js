import { createAgentEndHandler, markNextAgentEndAsSessionSwitch } from "./src/agent-end.js";
import { setupNotificationListener } from "./src/notification-listener.js";
import { cancelSleepOnly, resetRecoveryState } from "./src/state.js";

export default function guardianPlugin(pi) {
  pi.on("agent_end", createAgentEndHandler(pi));
  setupNotificationListener(pi);

  pi.on("session_before_switch", () => {
    markNextAgentEndAsSessionSwitch();
  });

  // Only intervene on user-initiated cancellation (Esc/Ctrl+C).
  // Cancel sleep + reset Guardian recovery state so a fresh
  // /gsd auto starts with clean counters.
  pi.on("stop", (event) => {
    if (event?.reason === "cancelled") {
      cancelSleepOnly();
      resetRecoveryState();
    }
  });
}
