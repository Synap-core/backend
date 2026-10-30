/**
 * /health serves the hash of the COMMITTED api-types contract
 * (packages/api-types/src/generated.d.ts), derived, never read from a
 * committed hash file. Two producers, two tests:
 *   - under vitest (no bundle define) health.ts hashes the file itself;
 *   - the shipped bundle gets it from tsup.config.ts `define`, which bakes the
 *     hash the build script computed (scripts/print-schema-hash.mjs).
 * The booted bundle is checked end to end in ci.yml ("Health serves the
 * derived schema hash").
 */

import { execFileSync } from "node:child_process";
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

  it("the bundle bakes the same hash in (build script -> tsup define)", async () => {
    // The build script computes it with print-schema-hash.mjs...
    const pkg = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")
    ) as { scripts: { build: string } };
    expect(pkg.scripts.build).toContain(
      "API_TYPES_SCHEMA_HASH=$(node scripts/print-schema-hash.mjs) tsup"
    );
    const printed = execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../../scripts/print-schema-hash.mjs", import.meta.url)
        ),
      ],
      { encoding: "utf8" }
    ).trim();
    expect(printed).toBe(EXPECTED);
    // ...and tsup.config.ts bakes what it was passed.
    const config = await loadTsupConfig();
    const define = withHashEnv(printed, () => config.default({}).define);
    expect(define?.__API_TYPES_SCHEMA_HASH__).toBe(JSON.stringify(EXPECTED));
  });

  it("the bundle refuses to build without the hash", async () => {
    const config = await loadTsupConfig();
    expect(() => withHashEnv(undefined, () => config.default({}))).toThrow(
      /API_TYPES_SCHEMA_HASH is unset/
    );
    expect(() => withHashEnv("not-a-hash", () => config.default({}))).toThrow(
      /not a 16-hex schema hash/
    );
  });
});

async function loadTsupConfig() {
  // A runtime path, so tsc does not pull tsup.config.ts into this program.
  const configPath = fileURLToPath(
    new URL("../../../../tsup.config.ts", import.meta.url)
  );
  return (await import(configPath)) as {
    default: (options: object) => { define?: Record<string, string> };
  };
}

function withHashEnv<T>(value: string | undefined, run: () => T): T {
  const before = process.env.API_TYPES_SCHEMA_HASH;
  if (value === undefined) delete process.env.API_TYPES_SCHEMA_HASH;
  else process.env.API_TYPES_SCHEMA_HASH = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.API_TYPES_SCHEMA_HASH;
    else process.env.API_TYPES_SCHEMA_HASH = before;
  }
}
