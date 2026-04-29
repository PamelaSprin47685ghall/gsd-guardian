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
    
    // 1. Try require.resolve for @gsd/pi-coding-agent
    try {
        const req = createRequire(import.meta.url);
        const pkgPath = req.resolve("@gsd/pi-coding-agent/package.json");
        candidates.push(path.join(path.dirname(pkgPath), "dist", "resources", "extensions", "gsd"));
    } catch {}
    
    // 2. Try gsd-pi global install (npm -g)
    try {
        const req = createRequire(import.meta.url);
        const gsdPiPath = req.resolve("gsd-pi/package.json");
        candidates.push(path.join(path.dirname(gsdPiPath), "pkg", "dist", "resources", "extensions", "gsd"));
    } catch {}
    
    // 3. Environment variables
    for (const env of ["GSD_CODING_AGENT_DIR", "GSD_PKG_ROOT"]) {
        const dir = process.env[env];
        if (dir) {
            candidates.push(path.join(dir, "dist", "resources", "extensions", "gsd"));
        }
    }
    
    // 4. Common global npm paths
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
        // nvm
        candidates.push(path.join(homeDir, ".nvm", "versions", "node", process.version, "lib", "node_modules", "gsd-pi", "pkg", "dist", "resources", "extensions", "gsd"));
        // npm global (Linux/Mac)
        candidates.push(path.join(homeDir, ".npm-global", "lib", "node_modules", "gsd-pi", "pkg", "dist", "resources", "extensions", "gsd"));
        // npm global (Windows)
        candidates.push(path.join(homeDir, "AppData", "Roaming", "npm", "node_modules", "gsd-pi", "pkg", "dist", "resources", "extensions", "gsd"));
    }
    
    // 5. System-wide npm paths
    if (process.platform !== "win32") {
        candidates.push("/usr/local/lib/node_modules/gsd-pi/pkg/dist/resources/extensions/gsd");
        candidates.push("/usr/lib/node_modules/gsd-pi/pkg/dist/resources/extensions/gsd");
    }
    
    return candidates;
}

export async function loadGsdModules(ctx) {
    const debug = process.env.GUARDIAN_DEBUG === "1";
    const candidates = getCandidates();
    
    if (debug) {
        console.log("[Guardian Debug] Searching for GSD modules in:");
        candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    }
    
    for (let dir of candidates) {
        try {
            if (!fs.existsSync(dir)) {
                if (debug) console.log(`[Guardian Debug] ✗ ${dir} (not found)`);
                continue;
            }
            
            // CRITICAL: Resolve symlinks to match Node's internal ESM cache key perfectly
            dir = fs.realpathSync(dir);
            if (debug) console.log(`[Guardian Debug] ✓ ${dir} (found, resolved)`);
            
            const mods = {};
            for (const name of ["auto-runtime-state", "auto"]) {
                const p = path.join(dir, `${name}.js`);
                if (fs.existsSync(p)) {
                    const realP = fs.realpathSync(p);
                    mods[name] = await import(pathToFileURL(realP).href);
                    if (debug) console.log(`[Guardian Debug]   ✓ Loaded ${name}.js`);
                } else {
                    if (debug) console.log(`[Guardian Debug]   ✗ ${name}.js not found`);
                }
            }
            
            if (mods["auto-runtime-state"] && mods["auto"]) {
                if (debug) console.log(`[Guardian Debug] ✓ All modules loaded successfully from ${dir}`);
                return mods;
            }
        } catch (err) {
            if (debug) console.log(`[Guardian Debug] ✗ Error loading from ${dir}:`, err.message);
        }
    }
    
    ctx?.ui?.notify?.("Guardian: Could not locate GSD runtime modules. Set GUARDIAN_DEBUG=1 for details.", "error");
    return null;
}
