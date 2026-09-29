/**
 * `/status` and `/diagnose-intelligence` must describe the service that
 * ACTUALLY serves, through `describeServingIntelligence` (a projection of the
 * routing ladder) — never through `workspaces.findFirst().settings
 * .intelligenceServiceId`, which named whichever space came first.
 *
 * Source-level guard: the handlers' bodies are cut out of provision.ts by their
 * route registration, so a new handler of the same shape is not silently
 * exempt. It does NOT prove runtime behaviour — that is
 * packages/api `intelligence-serving.pglite.test.ts` (the shared resolver).
 * Granularity is the handler body; it cannot see a second derivation hidden
 * behind a helper defined elsewhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("./provision.ts", import.meta.url)),
  "utf8"
);

function handlerBody(route: string): string {
  const start = src.indexOf(`provisionRouter.get("${route}"`);
  expect(start, `route ${route} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\nprovisionRouter.", start + 10);
  // Comments are prose ABOUT the old bug; only code is scanned.
  return src
    .slice(start, next === -1 ? undefined : next)
    .replace(/^\s*\/\/.*$/gm, "");
}

describe.each(["/status", "/diagnose-intelligence"])("%s", (route) => {
  const body = handlerBody(route);

  it("is non-vacuous: the cut handler is a real body", () => {
    expect(body.length).toBeGreaterThan(500);
  });

  it("names the serving service through the ONE resolver", () => {
    expect(body).toContain("describeServingIntelligence(");
  });

  it("does not re-derive the service from a workspace's settings", () => {
    expect(body).not.toMatch(/settings\??\.intelligenceServiceId/);
    expect(body).not.toMatch(/intelligenceServiceId\s+=/);
    expect(body).not.toMatch(/intelligenceServices\.serviceId/);
  });
});
