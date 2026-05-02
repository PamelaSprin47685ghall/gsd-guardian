import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function resolveAgentDir() {
  const envDir = process.env.GSD_CODING_AGENT_DIR;
  if (envDir) {
    const resolved = path.resolve(envDir);
    const home = os.homedir();
    if (!resolved.startsWith(home)) {
      console.warn(
        `[Guardian] Warning: GSD_CODING_AGENT_DIR (${resolved}) is outside home directory`
      );
    }
    return resolved;
  }
  return path.join(os.homedir(), ".gsd", "agent");
}

const SEARCH_ROOTS = [
  () => path.join(resolveAgentDir(), "extensions", "gsd"),
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "gsd"),
];

const modCache = new Map();

export async function findModule(relPath) {
  for (const root of SEARCH_ROOTS) {
    const target = path.join(root(), relPath);
    try {
      if (!fs.existsSync(target)) continue;
      const real = fs.realpathSync(target);
      if (modCache.has(real)) return modCache.get(real);
      const mod = await import(pathToFileURL(real).href);
      modCache.set(real, mod);
      return mod;
    } catch {
      // try next path
    }
  }
  return null;
}
