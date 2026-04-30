import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROBE_PATHS = [
  () => {
    const agentDir =
      process.env.GSD_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".gsd", "agent");
    return path.join(agentDir, "extensions", "gsd", "auto.js");
  },
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "gsd", "auto.js"),
];

export async function isAutoModeRunning() {
  for (const buildPath of PROBE_PATHS) {
    try {
      const target = buildPath();
      if (fs.existsSync(target)) {
        const mod = await import(pathToFileURL(fs.realpathSync(target)).href);
        if (mod?.getAutoDashboardData) {
          const data = mod.getAutoDashboardData();
          return !!(data && data.active && !data.stepMode);
        }
      }
    } catch {
      // fall through to next path
    }
  }
  return false;
}
