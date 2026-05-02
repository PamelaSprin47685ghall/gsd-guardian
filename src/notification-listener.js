import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { state } from "./state.js";
import { extractText } from "./extract-text.js";
import { isAutoModeRunning } from "./probe.js";

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

  pi.ui?.notify?.("🔥 [Guardian] Auto-mode paused. Starting repair...", "error");
  pi.sendUserMessage(repairPrompt(message));
}

async function processNotification(pi, entry) {
  if (!entry) return;
  if (entry.id && entry.id === lastNotificationId) return;
  if (entry.id) lastNotificationId = entry.id;

  if (entry.kind !== "blocked" && entry.kind !== "error") return;
  
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
    void processNotification(pi, latest);
  });
  listenerReady = true;
  return true;
}

export function setupNotificationListener(pi) {
  pi.on?.("notification", (event) => {
    void processNotification(pi, event);
  });

  pi.on?.("session_start", () => {
    void initStoreListener(pi);
  });

  void initStoreListener(pi);
}
