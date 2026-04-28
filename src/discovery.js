// Guardian Plugin - GSD Runtime Module Discovery
//
// Dynamically locates and loads GSD's runtime state and API modules.
// Needed to access AutoSession instance for method interception.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

function gsdModuleDir() {
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
    for (const dir of gsdModuleDir()) {
        try {
            if (!fs.existsSync(dir)) continue;
            const mods = {};
            for (const name of ["auto-runtime-state", "auto"]) {
                const p = path.join(dir, `${name}.js`);
                if (fs.existsSync(p)) mods[name] = await import(pathToFileURL(p).href);
            }
            if (mods["auto-runtime-state"] || mods["auto"]) return mods;
        } catch {}
    }
    ctx?.ui?.notify?.("Guardian: Could not locate GSD runtime modules", "error");
    return null;
}