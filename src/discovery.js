// Guardian Plugin - GSD Runtime Module Discovery
//
// Dynamically locates and loads GSD's runtime state and API modules.
// Uses fs.realpathSync to guarantee exact ESM cache hits across symlinks.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

function getCandidates() {
    const candidates = [];
    try {
        const req = createRequire(import.meta.url);
        const pkgPath = req.resolve("@gsd/pi-coding-agent/package.json");
        candidates.push(path.join(path.dirname(pkgPath), "dist", "resources", "extensions", "gsd"));
    } catch {}
    for (const env of ["GSD_CODING_AGENT_DIR", "GSD_PKG_ROOT"]) {
        const dir = process.env[env];
        if (dir) {
            candidates.push(path.join(dir, "dist", "resources", "extensions", "gsd"));
        }
    }
    return candidates;
}

export async function loadGsdModules(ctx) {
    for (let dir of getCandidates()) {
        try {
            if (!fs.existsSync(dir)) continue;
            // CRITICAL: Resolve symlinks to match Node's internal ESM cache key perfectly
            dir = fs.realpathSync(dir);
            
            const mods = {};
            for (const name of ["auto-runtime-state", "auto"]) {
                const p = path.join(dir, `${name}.js`);
                if (fs.existsSync(p)) {
                    const realP = fs.realpathSync(p);
                    mods[name] = await import(pathToFileURL(realP).href);
                }
            }
            if (mods["auto-runtime-state"] && mods["auto"]) {
                return mods;
            }
        } catch {}
    }
    ctx?.ui?.notify?.("Guardian: Could not locate GSD runtime modules", "error");
    return null;
}
