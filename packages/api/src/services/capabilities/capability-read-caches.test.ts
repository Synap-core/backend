/**
 * The capability read caches drop TOGETHER, through one call.
 *
 * Behavioural: `invalidateCapabilityReadCaches()` empties both the reader
 * door's source cache and find's assembled registry.
 *
 * TRIPWIRE (source scan): no door calls the reader cache's own
 * `invalidateUrlReaderCache()`: a door that did would leave find's registry
 * stale for up to 15 s after it turned a verb on or off. The scanned set is
 * DERIVED (every non-test `.ts` under `src/`).
 *
 * NOT COVERED, measured: whether a door that SHOULD invalidate calls the shared
 * call at all (a new door that forgets both is bounded by the TTL only). The
 * scan sees call sites, not intent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findRegistryCacheGet,
  findRegistryCacheSet,
  invalidateCapabilityReadCaches,
} from "./capability-read-caches.js";
import { readerCacheGet, readerCacheSet } from "./url-reader-cache.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "__tests__") sources(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const DIRECT_CALL = /\binvalidateUrlReaderCache\(\)/;

describe("capability read caches", () => {
  it("one call drops the reader cache AND find's registry", () => {
    readerCacheSet("k", 1);
    findRegistryCacheSet("k", 2);
    expect(readerCacheGet("k")).toBe(1);
    expect(findRegistryCacheGet("k")).toBe(2);
    invalidateCapabilityReadCaches();
    expect(readerCacheGet("k")).toBeUndefined();
    expect(findRegistryCacheGet("k")).toBeUndefined();
  });

  it("TRIPWIRE: no door calls the reader cache's own invalidation directly", () => {
    const files = sources(SRC);
    // Non-vacuity: the scan reads the api's sources, and can see the one
    // legitimate call (inside the shared leaf).
    expect(files.length).toBeGreaterThan(500);
    const leaf = files.find((f) => f.endsWith("capability-read-caches.ts"))!;
    expect(DIRECT_CALL.test(readFileSync(leaf, "utf8"))).toBe(true);
    const direct = files
      .filter((f) => f !== leaf && !f.endsWith("url-reader-cache.ts"))
      .filter((f) => DIRECT_CALL.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(
      direct,
      "call invalidateCapabilityReadCaches() (capability-read-caches.ts) so find's registry drops too"
    ).toEqual([]);
  });
});
