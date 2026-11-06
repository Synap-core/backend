/**
 * TRIPWIRE — only `/mcp/redeem` stamps a key's Synap account origin.
 *
 * WHY (review bf96d410 of the connect wave, lane B; founder decision 4 of
 * 4 Nov 2026). "Is this key the Synap account connector's?" decides what the
 * Control Plane may revoke (`/mcp/revoke`'s floor) and which tool names an
 * agent is taught. It used to be read from the instanceId prefix `mcp:`,
 * which `/setup/agent` let any caller send. Since 0400 it is read from
 * `api_keys.origin` (`isSynapAccountKey`), and that is only as good as the
 * set of doors that write it: one, the redeem door.
 *
 * HOW (derived): walk `packages/api/src`, `apps/api/src` and
 * `packages/database/src` (tests skipped, comments blanked) and collect
 *  - every file that passes a value to `provisionSurfaceAgentKey`'s
 *    `keyOrigin:` option, which must be exactly the redeem door;
 *  - every file naming `SYNAP_ACCOUNT_KEY_ORIGIN` or the literal
 *    `"synap-account"`, which must be the definition, the redeem door, or a
 *    READER listed below with its reason.
 *
 * WHAT IT DOES NOT SEE (stated): a raw `INSERT INTO api_keys (… origin …)`
 * with a value built elsewhere, or an `origin:` written under another name.
 * The rotation doors copy `oldKey.origin` (an existing value, never this
 * one), so they are not on either list; `api-key-mint-sites` keeps the set of
 * minting files itself known.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "apps/api/src", "packages/database/src"].map(
  (r) => join(REPO, r)
);
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

const REDEEM = "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts";

/** Files that may name the origin, and why. */
const NAMES_ORIGIN: Record<string, string> = {
  "packages/api/src/services/synap-account-client.ts":
    "the definition, and isSynapAccountKey (the one reader of the value).",
  [REDEEM]: "the one door that stamps it.",
  "packages/api/src/services/agent-identity-service.ts":
    "READ: adoption never moves an agent holding a Synap account key.",
};

/** A value handed to the option (its type declaration `keyOrigin?:` is not). */
const PASSES_KEY_ORIGIN = /\bkeyOrigin\s*:(?!\s*(?:string|undefined)\b)/;
const NAMES = /\bSYNAP_ACCOUNT_KEY_ORIGIN\b|["'`]synap-account["'`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const passes = new Set<string>();
const names = new Set<string>();
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++;
    const code = stripComments(readFileSync(file, "utf8"), "ts");
    const rel = relative(REPO, file);
    if (PASSES_KEY_ORIGIN.test(code)) passes.add(rel);
    if (NAMES.test(code)) names.add(rel);
  }
}

describe("only /mcp/redeem stamps the Synap account origin", () => {
  it("scans real code and sees the redeem door (non-vacuity)", () => {
    expect(scanned).toBeGreaterThan(200);
    expect(passes.has(REDEEM)).toBe(true);
    expect(names.has(REDEEM)).toBe(true);
    expect(PASSES_KEY_ORIGIN.test("keyOrigin: SYNAP_ACCOUNT_KEY_ORIGIN,")).toBe(
      true
    );
    expect(PASSES_KEY_ORIGIN.test("keyOrigin?: string | null;")).toBe(false);
    expect(NAMES.test('origin: "synap-account"')).toBe(true);
  });

  it("no other file hands provisionSurfaceAgentKey a key origin", () => {
    expect(
      [...passes].sort(),
      "Only /mcp/redeem mints a Synap account key. Another door must not claim it."
    ).toEqual([REDEEM]);
  });

  it("every file naming the origin is on the list, and every listed file still does", () => {
    expect(
      [...names].filter((f) => !(f in NAMES_ORIGIN)).sort(),
      "A new file names the Synap account origin. A reader goes on NAMES_ORIGIN with its reason; a writer is refused."
    ).toEqual([]);
    expect(
      Object.keys(NAMES_ORIGIN)
        .filter((f) => !names.has(f))
        .sort(),
      "Remove entries for files that no longer name it."
    ).toEqual([]);
  });
});
