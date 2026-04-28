// Guardian Plugin - Module Discovery
//
// Dynamically locates and loads GSD's internal auto-loop module.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export async function loadGsdAutoLoop(ctx) {
    const candidates = [];

    try {
        const req = createRequire(import.meta.url);
        const pkgPath = req.resolve("@gsd/pi-coding-agent/package.json");
        candidates.push(path.join(path.dirname(pkgPath), "dist", "resources", "extensions", "gsd"));
        candidates.push(path.join(path.dirname(pkgPath), "src", "resources", "extensions", "gsd"));
    } catch {}

    if (process.env.GSD_CODING_AGENT_DIR) {
        candidates.push(path.join(process.env.GSD_CODING_AGENT_DIR, "dist", "resources", "extensions", "gsd"));
        candidates.push(path.join(process.env.GSD_CODING_AGENT_DIR, "src", "resources", "extensions", "gsd"));
    }

    if (process.env.GSD_PKG_ROOT) {
        candidates.push(path.join(process.env.GSD_PKG_ROOT, "dist", "resources", "extensions", "gsd"));
        candidates.push(path.join(process.env.GSD_PKG_ROOT, "src", "resources", "extensions", "gsd"));
    }

    for (const dir of candidates) {
        try {
            if (!fs.existsSync(dir)) continue;

            // Try to load auto-loop module
            const autoLoopPath = path.join(dir, "auto-loop.js");
            if (fs.existsSync(autoLoopPath)) {
                const mod = await import(pathToFileURL(autoLoopPath).href);
                return mod;
            }
        } catch (e) {
            continue;
        }
    }

    ctx?.ui?.notify?.("Guardian: Could not locate GSD auto-loop module", "error");
    return null;
}