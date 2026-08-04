import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the SERVED tRPC router IS `coreRouter` (root.ts), by identity.
 *
 * History: the live server used to mount `appRouter = buildAppRouter()` from a
 * dynamic `registerRouter(...)` registry, while types + client stubs came from
 * `coreRouter` / api-types. The two DRIFTED: keys present only on coreRouter
 * (governanceRules, knowledge) compiled and shipped to the client but returned
 * HTTP 404 at runtime; keys mounted only via the registry (diagnose, users,
 * typesense, n8nActions) were served but untyped. That whole failure mode is
 * eliminated by construction: `appRouter = coreRouter` (one assignment, no
 * build step), so served ≡ typed ≡ coreRouter keys — nothing left to drift.
 *
 * This tripwire keeps that identity intact and the retired machinery dead:
 *   1. index.ts assigns `appRouter = coreRouter` directly (no buildAppRouter()).
 *   2. the server app mounts `router: appRouter`.
 *   3. no registerRouter / buildAppRouter / router-registry survives in src —
 *      reintroducing any of them would re-open the drift.
 *   4. the specific keys that 404'd / were untyped are on coreRouter.
 *
 * If this fails: do NOT resurrect the dynamic registry. Add the router to
 * `coreRouter` in root.ts (the single source of truth for the served + typed
 * surface), then re-run `pnpm gen-types` + republish api-types.
 */

const apiSrc = join(__dirname, "..");
const serverAppIndex = join(
  apiSrc,
  "..",
  "..",
  "..",
  "apps",
  "api",
  "src",
  "index.ts"
);

function coreRouterKeys(): string[] {
  const src = readFileSync(join(apiSrc, "root.ts"), "utf8");
  const m = src.match(/export const coreRouter = router\(\{([\s\S]*?)\n\}\);/);
  if (!m) {
    throw new Error("Could not locate coreRouter definition in root.ts");
  }
  return [...m[1].matchAll(/^\s+([a-zA-Z0-9_]+):/gm)].map((x) => x[1]);
}

describe("tripwire: the served tRPC router IS coreRouter (no registry drift)", () => {
  it("index.ts serves coreRouter directly — appRouter = coreRouter", () => {
    const src = readFileSync(join(apiSrc, "index.ts"), "utf8");
    expect(
      /export const appRouter\s*:\s*AppRouter\s*=\s*coreRouter\s*;/.test(src),
      "index.ts must assign `appRouter = coreRouter` (served ≡ typed by identity). " +
        "Do not build the served router from a registry — that is the drift this kills."
    ).toBe(true);
    expect(
      /buildAppRouter/.test(src),
      "index.ts must NOT call buildAppRouter() — the dynamic registry is retired."
    ).toBe(false);
  });

  it("the server app mounts router: appRouter", () => {
    const src = readFileSync(serverAppIndex, "utf8");
    expect(
      /router:\s*appRouter/.test(src),
      "apps/api/src/index.ts must mount `router: appRouter` (= coreRouter)."
    ).toBe(true);
  });

  it("the dynamic router registry + plugin system are gone", () => {
    expect(
      existsSync(join(apiSrc, "router-registry.ts")),
      "router-registry.ts must stay deleted — it is the drift source."
    ).toBe(false);
    expect(
      existsSync(join(apiSrc, "plugins")),
      "plugins/ must stay deleted — no DataPodPlugin mounts routers post-boot."
    ).toBe(false);
  });

  it("the previously-drifted keys are present on coreRouter", () => {
    const core = new Set(coreRouterKeys());
    for (const key of [
      "governanceRules", // 404'd at runtime (typed, never registered)
      "knowledge", //        404'd at runtime (typed, never registered)
      "diagnose", //         served but untyped (registry-only)
      "typesense", //        served but untyped (registry-only)
      "n8nActions", //       served but untyped (registry-only)
      "users", //            served but untyped (registry-only)
    ]) {
      expect(core.has(key), `coreRouter must contain "${key}"`).toBe(true);
    }
  });
});
