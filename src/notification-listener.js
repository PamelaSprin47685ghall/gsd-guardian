import { extractText } from "./extract-text.js";
import { findModule } from "./util.js";
import { startRepairFlow } from "./repair-flow.js";

// Per-session notification state using WeakMap
const sessionListeners = new WeakMap();

function getListenerState(pi) {
  if (!sessionListeners.has(pi)) {
    sessionListeners.set(pi, {
      unsubscribe: null,
      lastNotificationId: null,
      ready: false,
      initPromise: null,
      piRef: pi,
    });
  }
  return sessionListeners.get(pi);
}

const registeredEventApis = new WeakSet();
const BENIGN_WARNING_PATTERNS = [
  /unknown\s+auto-loop\s+phase/i,
  /unknown\s+.*\s+phase/i,
  /^operation aborted$/i,
  /^request was aborted$/i,
  /^request aborted by user$/i,
  /^\[Guardian\]\s*(retry|repair|auto|watchdog|dispatch)/i,
  /^magic-todo:/i,
  /^pruner:/i,
  /^\[dag\]\s*dispatch registry synchronized\.?$/i,
  /^\[dag\]\s*spawning tasks:/i,
  /^\[dag\]\s*starting parallel execution/i,
  /^\[dag\]\s*completed\s+\d+\/\d+/i,
  /^\[[A-Z]\d+\]\s*optional extension tools unavailable/i,
  /^loop (aborted|stopped)/i,
  /^no active loop/i,
  /^Pre-execution checks failed/i,
  /^Pre-execution checks error/i,
];

const RECOVERABLE_AUTO_PATTERNS = [
  /dispatch[-\s]?stop/i,
  /auto[-\s]?mode.*(?:paused|stopped|failed|error|blocked)/i,
  /(?:auto|dispatch).*recoverable error/i,
  /(?:plan|slice|milestone|task).*validation (?:failed|failure|error)/i,
  /(?:plan|slice|milestone|task).*validation output does not address/i,
  /DEPS\.json.*(?:error|invalid|failed|missing|deadlock)/i,
  /DAG .*failed/i,
  /DAG .*failures/i,
  /DAG .*error/i,
  /DAG stuck/i,
  /missing gsd_(?:task_)?complete tool/i,
  /Task session .* missing .* tool/i,
  /REPLAN-TRIGGER/i,
  /post-exec(?:ution)? failure/i,
  /pre-exec(?:ution)? failure/i,
  /commit failure/i,
  /worktree .*failed/i,
  /merge .*failed/i,
];

function getNotificationLevel(entry) {
  return (entry?.kind ?? entry?.severity ?? entry?.level ?? "").toLowerCase();
}

function notificationRequestsRecovery(entry) {
  return entry?.recoverable === true || entry?.autoModeCritical === true || entry?.metadata?.recoverable === true || entry?.metadata?.autoModeCritical === true;
}

export function shouldRecoverFromNotification(entry, message) {
  if (!message) return false;
  if (notificationRequestsRecovery(entry)) return true;
  if (BENIGN_WARNING_PATTERNS.some(pattern => pattern.test(message))) return false;
  return RECOVERABLE_AUTO_PATTERNS.some(pattern => pattern.test(message));
}

async function processNotification(pi, entry) {
  if (!entry) return;

  const state = getListenerState(pi);
  if (entry.id && entry.id === state.lastNotificationId) return;
  if (entry.id) state.lastNotificationId = entry.id;

  const candidates = [entry.errorMessage, entry.content, entry.message, entry.text];
  let message = "";
  for (const candidate of candidates) {
    message = extractText(candidate);
    if (message) break;
  }

  const level = getNotificationLevel(entry);
  if (!["blocked", "error", "warning"].includes(level)) return;
  if (!shouldRecoverFromNotification(entry, message)) return;

  await startRepairFlow(pi, pi, "notification", message);
}

async function loadStoreModule() {
  const mod = await findModule("notification-store.js");
  return mod?.onNotificationStoreChange && mod?.readNotifications ? mod : null;
}

async function initStoreListener(pi) {
  const state = getListenerState(pi);
  if (state.ready) return true;
  if (state.initPromise) return state.initPromise;

  state.initPromise = (async () => {
    const store = await loadStoreModule();
    if (!store) return false;

    const current = store.readNotifications();
    state.lastNotificationId = current?.[0]?.id ?? state.lastNotificationId;

    if (state.unsubscribe) {
      state.unsubscribe();
      state.unsubscribe = null;
    }
    state.unsubscribe = store.onNotificationStoreChange(() => {
      const latest = store.readNotifications()?.[0];
      processNotification(state.piRef ?? pi, latest).catch(err => {
        console.error("[Guardian] notification error:", err);
      });
    });
    state.ready = true;
    return true;
  })();

  return state.initPromise;
}

export function resetNotificationState() {
  // Per-session: state is cleaned up when session is garbage collected
  // or can be explicitly cleaned via sessionListeners.delete(pi)
}

export function setupNotificationListener(pi) {
  const state = getListenerState(pi);
  if (!registeredEventApis.has(pi)) {
    pi.on?.("notification", event => {
      processNotification(pi, event).catch(err => {
        console.error("[Guardian] notification handler error:", err);
      });
    });
    registeredEventApis.add(pi);
  }

  pi.on?.("session_start", () => {
    initStoreListener(pi).catch(err => {
      console.error("[Guardian] store init error:", err);
    });
  });

  initStoreListener(pi).catch(err => {
    console.error("[Guardian] store init error:", err);
  });
}
