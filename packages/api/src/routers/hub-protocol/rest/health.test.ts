/**
 * /health serves the hash of the COMMITTED api-types contract
 * (packages/api-types/src/generated.d.ts), derived, never read from a
 * committed hash file. Two producers, two tests:
 *   - under vitest (no bundle define) health.ts hashes the file itself;
 *   - the shipped bundle gets it from tsup.config.ts `define`.
 * The booted bundle is checked end to end in ci.yml ("Health serves the
 * derived schema hash").
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import type { HubHono } from "./_shared.js";
import { registerHealthRoutes } from "./health.js";

const GENERATED = fileURLToPath(
  new URL("../../../../../api-types/src/generated.d.ts", import.meta.url)
);
// Computed here independently of scripts/schema-hash.mjs, so a change to that
// function's recipe (length, algorithm, input) is caught too.
const EXPECTED = createHash("sha256")
  .update(readFileSync(GENERATED, "utf-8"))
  .digest("hex")
  .slice(0, 16);

describe("/health schemaHash", () => {
  it("self-check: the contract file is the real one", () => {
    expect(readFileSync(GENERATED, "utf-8").length).toBeGreaterThan(100_000);
    expect(EXPECTED).toMatch(/^[0-9a-f]{16}$/);
  });

  it("serves the hash of the committed generated.d.ts", async () => {
    const app = new OpenAPIHono() as unknown as HubHono;
    registerHealthRoutes(app);
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schemaHash?: unknown };
    expect(body.schemaHash).toBe(EXPECTED);
  });

  it("the bundle bakes the same hash in (tsup define)", async () => {
    // A runtime path, so tsc does not pull tsup.config.ts into this program.
    const configPath = fileURLToPath(
      new URL("../../../../tsup.config.ts", import.meta.url)
    );
    const mod = (await import(configPath)) as {
      default: { define?: Record<string, string> };
    };
    expect(mod.default.define?.__API_TYPES_SCHEMA_HASH__).toBe(
      JSON.stringify(EXPECTED)
    );
  });
});
