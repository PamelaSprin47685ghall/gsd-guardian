import { state } from "./state.js";

export function createSessionHijack(pi) {
  return (event, ctx) => {
    if (!ctx.newSession || ctx.newSession.__guardianPatched) return;

    const orig = ctx.newSession.bind(ctx);
    ctx.newSession = async function (opts) {
      if (state.suppressNextNewSession) {
        state.suppressNextNewSession = false;
        ctx.ui.notify(
          "🛡️ [Guardian] Blocked GSD session reset — preserved context.",
          "success",
        );
        return { cancelled: false };
      }
      return orig(opts);
    };
    ctx.newSession.__guardianPatched = true;
  };
}
