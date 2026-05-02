import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the most recent dispatch-stop event from the journal.
 * Returns the reason if found, null otherwise.
 */
export function getLastDispatchStopReason(basePath) {
  try {
    const journalDir = join(basePath, ".gsd", "journal");
    if (!existsSync(journalDir)) return null;

    const files = readdirSync(journalDir)
      .filter(f => f.endsWith(".jsonl"))
      .sort()
      .reverse(); // Most recent first

    for (const file of files) {
      const raw = readFileSync(join(journalDir, file), "utf-8");
      const lines = raw.split("\n").reverse(); // Most recent first

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.eventType === "dispatch-stop" && entry.data?.reason) {
            return entry.data.reason;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    return null;
  } catch (err) {
    console.error("[Guardian] Failed to read journal:", err);
    return null;
  }
}
