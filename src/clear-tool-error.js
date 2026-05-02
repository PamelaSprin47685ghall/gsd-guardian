import { findModule } from "./util.js";

/**
 * Clear GSD's autoSession.lastToolInvocationError.
 * This prevents postUnitPreVerification from falsely pausing auto-mode
 * after a Guardian-initiated retry succeeds.
 */
export async function clearLastToolInvocationError() {
  const mod = await findModule("auto-runtime-state.js");
  if (mod?.autoSession && "lastToolInvocationError" in mod.autoSession) {
    mod.autoSession.lastToolInvocationError = null;
    return true;
  }
  return false;
}
