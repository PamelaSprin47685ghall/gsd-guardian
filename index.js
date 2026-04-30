import { createAgentEndHandler } from "./src/agent-end.js";
import { createSessionHijack } from "./src/session-hijack.js";
import { abort } from "./src/state.js";

export default function guardianPlugin(pi) {
  pi.on("before_agent_start", createSessionHijack(pi));
  pi.on("agent_end", createAgentEndHandler(pi));
  pi.on("stop", () => abort());
}
