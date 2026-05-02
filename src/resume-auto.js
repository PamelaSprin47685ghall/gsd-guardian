import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AUTO_PATHS = [
  () => {
    const agentDir = process.env.GSD_CODING_AGENT_DIR || path.join(os.homedir(), ".gsd", "agent");
    return path.join(agentDir, "extensions", "gsd", "auto.js");
  },
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "gsd", "auto.js"),
];

async function loadAutoModule() {
  for (const buildPath of AUTO_PATHS) {
    try {
      const target = buildPath();
      if (!fs.existsSync(target)) continue;
      const mod = await import(pathToFileURL(fs.realpathSync(target)).href);
      if (mod?.getAutoDashboardData && mod?.startAuto) return mod;
    } catch {
      // try next path
    }
  }
  return null;
}

export async function resumePausedAuto(pi, ctx) {
  const mod = await loadAutoModule();
  if (!mod) return "missing-auto-module";

  const snapshot = mod.getAutoDashboardData();
  if (snapshot?.active) return "already-active";
  if (!snapshot?.paused) return "not-paused";
  if (!snapshot?.basePath) return "missing-base";

  await mod.startAuto(ctx, pi, snapshot.basePath, false, { step: snapshot.stepMode });
  return "resumed";
}
