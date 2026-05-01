import { createAgentEndHandler } from "./src/agent-end.js";
import { cancelSleepOnly, resetRecoveryState } from "./src/state.js";

export default function guardianPlugin(pi) {
  pi.on("agent_end", createAgentEndHandler(pi));

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
