import { extractText } from "./extract-text.js";
import { findModule } from "./util.js";
import { startRepairFlow } from "./repair-flow.js";

let unsubscribe = null;
let lastNotificationId = null;
let listenerReady = false;
let initPromise = null;

const WARNING_IGNORE_PATTERNS = [
  /unknown\s+auto-loop\s+phase/i,
  /unknown\s+.*\s+phase/i,
  /^operation aborted$/i,
  /^request was aborted$/i,
  /^request aborted by user$/i,
];

function getNotificationLevel(entry) {
  return (entry?.kind ?? entry?.severity ?? "").toLowerCase();
}

function shouldRecoverFromWarning(message) {
  if (!message) return false;
  if (WARNING_IGNORE_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  return true;
}

async function processNotification(pi, entry) {
  if (!entry) return;
  if (entry.id && entry.id === lastNotificationId) return;
  if (entry.id) lastNotificationId = entry.id;

  const candidates = [entry.errorMessage, entry.content, entry.message];
  let message = "";
  for (const candidate of candidates) {
    message = extractText(candidate);
    if (message) break;
  }

  const level = getNotificationLevel(entry);
  if (level === "blocked" || level === "error") {
    if (!message) return;
    await startRepairFlow(pi, pi, "notification", message);
    return;
  }

  if (level === "warning") {
    if (!shouldRecoverFromWarning(message)) return;
    await startRepairFlow(pi, pi, "notification", message);
  }
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
      processNotification(pi, latest).catch((err) => {
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
    processNotification(pi, event).catch((err) => {
      console.error("[Guardian] notification handler error:", err);
    });
  });

  pi.on?.("session_start", () => {
    initStoreListener(pi).catch((err) => {
      console.error("[Guardian] store init error:", err);
    });
  });

  initStoreListener(pi).catch((err) => {
    console.error("[Guardian] store init error:", err);
  });
}
