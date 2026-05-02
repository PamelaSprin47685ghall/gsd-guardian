import { findModule } from "./util.js";

export async function resumePausedAuto(pi, ctx) {
  const mod = await findModule("auto.js");
  if (!mod?.getAutoDashboardData || !mod?.startAuto) return "missing-auto-module";

  const snapshot = mod.getAutoDashboardData();
  if (snapshot?.active) return "already-active";
  if (!snapshot?.paused) return "not-paused";
  if (!snapshot?.basePath) return "missing-base";

  await mod.startAuto(ctx, pi, snapshot.basePath, false, { step: snapshot.stepMode });
  return "resumed";
}
