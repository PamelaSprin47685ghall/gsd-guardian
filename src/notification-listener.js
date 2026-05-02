import { state } from "./state.js";
import { extractText } from "./extract-text.js";
import { isAutoModeRunning } from "./probe.js";
import { findModule } from "./util.js";

let unsubscribe = null;
let lastNotificationId = null;
let listenerReady = false;
let initPromise = null;

function repairPrompt(message) {
  return [
    "Auto-mode paused due to recoverable error.",
    "",
    "Error:",
    "```",
    message,
    "```",
    "",
    "Diagnose and fix. Reply when done; Guardian will resume auto-mode after the fix.",
  ].join("\n");
}

async function startRepair(pi, message) {
  if (state.isFixing) return;

  const isAuto = await isAutoModeRunning();
  if (!isAuto) return;

  state.isFixing = true;
  state.resumeAutoAfterRepair = true;
  state.retryCount = 0;
  state.repairCount = 0;

  pi.ui?.notify?.("\u{1F525} [Guardian] Auto-mode paused. Starting repair...", "error");
  pi.sendUserMessage(repairPrompt(message));
}

async function processNotification(pi, entry) {
  if (!entry) return;
  if (entry.id && entry.id === lastNotificationId) return;
  if (entry.id) lastNotificationId = entry.id;

  // Process blocked, error, and warning notifications
  // Warning-level dispatch-stops (e.g. validation failures) should trigger repair
  if (entry.kind !== "blocked" && entry.kind !== "error" && entry.kind !== "warning") return;

  const candidates = [entry.errorMessage, entry.content, entry.message];
  let message = "";
  for (const candidate of candidates) {
    message = extractText(candidate);
    if (message) break;
  }

  if (!message) return;
  await startRepair(pi, message);
}

async function loadStoreModule() {
  const mod = await findModule("notification-store.js");
  return mod?.onNotificationStoreChange && mod?.readNotifications ? mod : null;
}

async function initStoreListener(pi) {
  if (listenerReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const store = await loadStoreModule();
    if (!store) return false;

    const current = store.readNotifications();
    lastNotificationId = current?.[0]?.id ?? lastNotificationId;

    unsubscribe?.();
    unsubscribe = store.onNotificationStoreChange(() => {
      const latest = store.readNotifications()?.[0];
      processNotification(pi, latest).catch(err => {
        console.error("[Guardian] notification error:", err);
      });
    });
    listenerReady = true;
    return true;
  })();

  return initPromise;
}

export function setupNotificationListener(pi) {
  pi.on?.("notification", (event) => {
    processNotification(pi, event).catch(err => {
      console.error("[Guardian] notification handler error:", err);
    });
  });

  pi.on?.("session_start", () => {
    initStoreListener(pi).catch(err => {
      console.error("[Guardian] store init error:", err);
    });
  });

  initStoreListener(pi).catch(err => {
    console.error("[Guardian] store init error:", err);
  });
}
