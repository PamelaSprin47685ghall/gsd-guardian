import { findModule } from "./util.js";

export async function isAutoModeRunning() {
  const mod = await findModule("auto.js");
  if (!mod?.getAutoDashboardData) return false;
  const data = mod.getAutoDashboardData();
  return !!(data && data.active && !data.stepMode);
}
