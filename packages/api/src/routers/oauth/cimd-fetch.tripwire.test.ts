/**
 * TRIPWIRE (spec 17 PB1, T4): a client URL is fetched in exactly one place.
 *
 * The pod fetching a URL a stranger chose is a confused-deputy surface, made
 * safe by `client-metadata.ts` alone (public pinned IP, no redirects, 5 s,
 * 5 KB). A second fetch of a client URL anywhere in the OAuth door would skip
 * every one of those bounds without a test noticing. So:
 *   - no file of the OAuth router other than `client-metadata.ts` makes an
 *     outbound request (fetch / node:http(s) / undici / the pinned GET);
 *   - the pinned GET is used only by the reviewed SSRF-safe clients;
 *   - the CIMD resolver is reached only through the consent module's phase 1.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

const OUTBOUND =
  /\bfetch\s*\(|from\s+["']node:https?["']|from\s+["']https?["']|from\s+["']undici["']|pinnedHttpsGet/;

/** The file's code with its comments removed (prose may say "fetch (…)"). */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("CIMD fetch tripwire", () => {
  it("only client-metadata.ts makes an outbound request in the OAuth router", () => {
    const offenders = sourceFiles(HERE)
      .filter((f) => !f.endsWith("client-metadata.ts"))
      .filter((f) => OUTBOUND.test(code(f)))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
    // Non-vacuity: the pattern does see the one real fetch.
    expect(OUTBOUND.test(code(join(HERE, "client-metadata.ts")))).toBe(true);
  });

  it("the pinned GET is used only by the reviewed SSRF-safe clients", () => {
    const users = sourceFiles(SRC)
      .filter((f) => /pinned-https-get\.js["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .sort();
    expect(users).toEqual([
      "routers/oauth/client-metadata.ts",
      "utils/federation-metadata-client.ts",
    ]);
  });

  it("the CIMD resolver is reached only from consent.ts (phase 1 of /authorize)", () => {
    const callers = sourceFiles(SRC)
      .filter((f) => !f.endsWith("client-metadata.ts"))
      .filter((f) => /\bresolveCimdClient\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(callers).toEqual(["routers/oauth/consent.ts"]);
  });
});
