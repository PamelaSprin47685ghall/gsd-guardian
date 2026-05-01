import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNTIME_STATE_PATHS = [
  () => {
    const agentDir =
      process.env.GSD_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".gsd", "agent");
    return path.join(agentDir, "extensions", "gsd", "auto-runtime-state.js");
  },
  () =>
    path.join(
      os.homedir(),
      ".pi",
      "agent",
      "extensions",
      "gsd",
      "auto-runtime-state.js",
    ),
];

/**
 * Clear GSD's autoSession.lastToolInvocationError.
 * This prevents postUnitPreVerification from falsely pausing auto-mode
 * after a Guardian-initiated retry succeeds.
 *
 * The import relies on Node.js ESM caching: the same module singleton
 * used by GSD's auto-runtime-state.ts is returned, so we mutate the
 * same autoSession object that GSD reads.
 */
export async function clearLastToolInvocationError() {
  for (const buildPath of RUNTIME_STATE_PATHS) {
    try {
      const target = buildPath();
      if (fs.existsSync(target)) {
        const mod = await import(
          pathToFileURL(fs.realpathSync(target)).href
        );
        if (
          mod?.autoSession &&
          "lastToolInvocationError" in mod.autoSession
        ) {
          mod.autoSession.lastToolInvocationError = null;
          return true;
        }
      }
    } catch {
      // fall through to next path
    }
  }
  return false;
}
