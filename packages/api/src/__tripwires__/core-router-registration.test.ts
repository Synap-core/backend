import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every key on `coreRouter` (root.ts) must also be registered via
 * `registerRouter(...)` in index.ts.
 *
 * The live server mounts `appRouter = buildAppRouter()` from the dynamic
 * registry, not `coreRouter` itself. Types and client stubs come from
 * `coreRouter` / api-types, so a key present only in root.ts compiles and
 * ships to the client but returns HTTP 404 at runtime.
 *
 * That is exactly how `applicationConnections` broke Pod Admin's Connections
 * page: listed on coreRouter, missing from registerRouter.
 *
 * If this fails: add `registerRouter("<name>", <router>, { ... })` in
 * packages/api/src/index.ts for every missing key. Do not paper over by
 * removing the key from coreRouter unless the surface is intentionally dead.
 *
 * Registry-only extras (automations, users, …) are allowed — plugins and
 * legacy surfaces may live only on the dynamic map.
 */

const apiSrc = join(__dirname, "..");

function coreRouterKeys(): string[] {
  const src = readFileSync(join(apiSrc, "root.ts"), "utf8");
  const m = src.match(/export const coreRouter = router\(\{([\s\S]*?)\n\}\);/);
  if (!m) {
    throw new Error("Could not locate coreRouter definition in root.ts");
  }
  return [...m[1].matchAll(/^\s+([a-zA-Z0-9_]+):/gm)].map((x) => x[1]);
}

function registeredRouterKeys(): string[] {
  const src = readFileSync(join(apiSrc, "index.ts"), "utf8");
  return [...src.matchAll(/registerRouter\(\s*"([^"]+)"/g)].map((x) => x[1]);
}

describe("tripwire: coreRouter keys are registered on the live appRouter", () => {
  it("every coreRouter key has a matching registerRouter() call", () => {
    const core = new Set(coreRouterKeys());
    const registered = new Set(registeredRouterKeys());
    const missing = [...core].filter((k) => !registered.has(k)).sort();

    expect(
      missing,
      `coreRouter keys missing from registerRouter (will 404 at runtime):\n  ${missing.join("\n  ")}\n\nAdd registerRouter(...) entries in packages/api/src/index.ts.`
    ).toEqual([]);
  });

  it("applicationConnections is registered (Pod Admin connections page)", () => {
    expect(registeredRouterKeys()).toContain("applicationConnections");
    expect(coreRouterKeys()).toContain("applicationConnections");
  });
});
