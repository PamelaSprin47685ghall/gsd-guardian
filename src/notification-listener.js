import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { state } from "./state.js";
import { isGsdValidationWarning } from "./agent-end.js";

const STORE_PATHS = [
  () => {
    const agentDir = process.env.GSD_CODING_AGENT_DIR || path.join(os.homedir(), ".gsd", "agent");
    return path.join(agentDir, "extensions", "gsd", "notification-store.js");
  },
  () => path.join(os.homedir(), ".pi", "agent", "extensions", "gsd", "notification-store.js"),
];

let unsubscribe = null;
let lastNotificationId = null;
let listenerReady = false;

function repairPrompt(message) {
  return [
    "Auto-mode paused at a recoverable GSD validation checkpoint.",
    "",
    "Error:",
    "```",
    message,
    "```",
    "",
    "Diagnose and fix the validation artifact. Reply when done; Guardian will resume auto-mode after the fix.",
  ].join("\n");
}

function startValidationRepair(pi, message) {
  if (state.isFixing) return;

  state.isFixing = true;
  state.resumeAutoAfterRepair = true;
  state.retryCount = 0;
  state.repairCount = 0;

  pi.ui?.notify?.("🔥 [Guardian] GSD validation checkpoint detected. Starting repair before auto resume.", "error");
  pi.sendUserMessage(repairPrompt(message));
}

function processNotification(pi, entry) {
  if (!entry) return;
  if (entry.id && entry.id === lastNotificationId) return;
  if (entry.id) lastNotificationId = entry.id;

  const message = entry.message || "";
  if (!isGsdValidationWarning({ message })) return;
  startValidationRepair(pi, message);
}

async function loadStoreModule() {
  for (const buildPath of STORE_PATHS) {
    try {
      const target = buildPath();
      if (!fs.existsSync(target)) continue;
      const mod = await import(pathToFileURL(fs.realpathSync(target)).href);
      if (mod?.onNotificationStoreChange && mod?.readNotifications) return mod;
    } catch {
      // try next path
    }
  }
  return null;
}

async function initStoreListener(pi) {
  if (listenerReady) return true;

  const store = await loadStoreModule();
  if (!store) return false;

  const current = store.readNotifications();
  lastNotificationId = current?.[0]?.id ?? lastNotificationId;

  unsubscribe?.();
  unsubscribe = store.onNotificationStoreChange(() => {
    const latest = store.readNotifications()?.[0];
    processNotification(pi, latest);
  });
  listenerReady = true;
  return true;
}

export function setupNotificationListener(pi) {
  pi.on?.("notification", (event) => {
    if (event?.kind !== "blocked" && event?.kind !== "error") return;
    processNotification(pi, { message: event.message });
  });

  pi.on?.("session_start", () => {
    void initStoreListener(pi);
  });

  void initStoreListener(pi);
}
