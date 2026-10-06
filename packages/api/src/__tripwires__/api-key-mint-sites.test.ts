/**
 * TRIPWIRE — every file that MINTS an API key is known, with a reason.
 *
 * WHY (2026-10-06 centralisation audit). Revocation has ONE door
 * (`revokeApiKeys`); minting has never had one. The audit counted 18 call
 * sites in 11 files, and four of them were privilege escalations nobody had
 * reviewed as mint doors (`/keys/rotate-cli` widening any key, `POST
 * /agent-users` minting a sibling agent's key…). A mint path that appears
 * without anyone deciding it should exist is how that happened.
 *
 * HOW (derived, not hand-listed): walk `packages/api/src`, `apps/api/src`,
 * `packages/database/src` (tests skipped) and collect every file that calls a
 * mint primitive — a raw `.insert(apiKeys)` / `INSERT INTO api_keys`, the
 * repository's `create`/`rotate`, `generateApiKey`, `mintHubInboundKey`,
 * `createAndVerify{Service,HubInbound}Key`, `provisionSurfaceAgentKey`,
 * `createNamedAgent`. That derived set must EQUAL the keys of `MINT_SITES`:
 *  - a NEW minting file fails until someone adds it here with its reason (and,
 *    for an agent-reachable door, its agent-caller rule);
 *  - a file that STOPPED minting fails until its entry is removed, so the list
 *    never grows stale and never vouches for code that is gone.
 *
 * WHAT IT DOES NOT SEE (stated): granularity is the FILE, not the call site —
 * a second mint added inside an allowlisted file passes. A primitive imported
 * under another name, or a mint built from a variable table, is invisible.
 * When the W1 `grants` record lands, the mint primitives are where it is
 * written, and this list is what it must cover.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const ROOTS = ["packages/api/src", "apps/api/src", "packages/database/src"].map(
  (r) => join(REPO, r)
);
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

/** Every file that mints, and why it may. */
const MINT_SITES: Record<string, string> = {
  "packages/database/src/repositories/api-key-repository.ts":
    "PRIMITIVE — ApiKeyRepository.create / .rotate (raw insert).",
  "packages/api/src/services/api-keys.ts":
    "PRIMITIVE — apiKeyService.generateApiKey (raw insert) + scheduled rotation.",
  "packages/api/src/services/hub-integration-registration.ts":
    "PRIMITIVE — mintHubInboundKey (hub_inbound keys for integrations).",
  "packages/api/src/services/external-registration.ts":
    "createAndVerify{HubInbound,Service}Key — mint then self-verify.",
  "packages/api/src/services/agent-identity-service.ts":
    "provisionSurfaceAgentKey (the agent door) + createNamedAgent.",
  "packages/api/src/routers/api-keys.ts":
    "tRPC apiKeys.* — human session; governed (apiKey/create) for agents; pod-admin system/service keys.",
  "packages/api/src/routers/hub-protocol/rest/setup.ts":
    "/setup/agent, /setup/service (refuses agent keys), /setup/external-user (sub-token subset).",
  "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts":
    "/mcp/redeem — CP-asserted one-time code → provisionSurfaceAgentKey.",
  "packages/api/src/routers/oauth/routes.ts":
    "OAuth /token — authorization code → provisionSurfaceAgentKey.",
  "packages/api/src/routers/hub-protocol/rest/agent-users.ts":
    "POST /agent-users — human session only; 403 for an agent key (2026-10-06).",
  "packages/api/src/routers/hub-protocol/rest/keys.ts":
    "/keys/rotate-cli — hub_inbound read+write keys only, keeps expiry (2026-10-06).",
  "packages/api/src/routers/intelligence-registry.ts":
    "provisionAgent / rotateAgentKey — pod-admin provisioning of agent services.",
  "packages/api/src/routers/intelligence.ts":
    "provisionService — pod-admin provisioning of an intelligence service key.",
  "apps/api/src/routers/provision.ts":
    "is_internal key behind a CP-signed JWT; activate-addon agent key.",
  "packages/api/src/scripts/provision-agent.ts":
    "Operator CLI script (no HTTP door).",
  "packages/database/src/scripts/init-hub-keys.ts":
    "Operator bootstrap script, raw SQL (no HTTP door).",
};

/** A call to a mint primitive — never its own definition. */
const MINT_CALL =
  /\.insert\(apiKeys\)|INSERT INTO api_keys|\.generateApiKey\(|apiKeyRepo\w*\.(?:create|rotate)\(|ApiKeyRepository\([^)]*\)\.(?:create|rotate)\(|(?<!function )\b(?:mintHubInboundKey|createAndVerifyServiceKey|createAndVerifyHubInboundKey|provisionSurfaceAgentKey|createNamedAgent)\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Strip comment lines so prose naming a primitive is not a mint. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

const minting = new Set<string>();
let scanned = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    scanned++;
    if (codeLines(readFileSync(file, "utf8")).some((l) => MINT_CALL.test(l))) {
      minting.add(relative(REPO, file));
    }
  }
}

describe("API-key mint sites are known", () => {
  it("scans real code and recognises a mint (non-vacuity)", () => {
    expect(scanned).toBeGreaterThan(200);
    expect(minting.size).toBeGreaterThanOrEqual(10);
    expect(MINT_CALL.test("await db.insert(apiKeys).values({")).toBe(true);
    expect(MINT_CALL.test("await createNamedAgent({ name })")).toBe(true);
    expect(MINT_CALL.test("export async function createNamedAgent(")).toBe(
      false
    );
  });

  it("every minting file is on the list (no NEW mint door)", () => {
    const unlisted = [...minting].filter((f) => !(f in MINT_SITES)).sort();
    expect(
      unlisted,
      "A new file mints API keys. Decide whether it should exist, how an agent caller is treated, and add it to MINT_SITES with its reason."
    ).toEqual([]);
  });

  it("every listed file still mints (no STALE entry)", () => {
    const stale = Object.keys(MINT_SITES)
      .filter((f) => !minting.has(f))
      .sort();
    expect(stale, "Remove entries for files that no longer mint.").toEqual([]);
  });
});

/**
 * Hard DELETEs of api_keys rows bypass the revoke door and its cache drop: a
 * deleted ACTIVE key keeps validating from the verification cache for up to
 * 30s. Each file that hard-deletes must say why that is safe.
 */
const DELETE_SITES: Record<string, string> = {
  "packages/api/src/routers/api-keys.ts":
    "apiKeys.delete removes an already-REVOKED key only (refuses an active one).",
  "packages/api/src/routers/system.ts":
    "User delete — revokeApiKeys(tx) runs first, then the rows are removed.",
  "apps/api/src/routers/provision.ts":
    "IS re-provision — revokeApiKeys runs first, then the replaced rows are removed.",
  "packages/database/src/repositories/api-key-repository.ts":
    "ApiKeyRepository.delete — no caller today; route a new caller through revokeApiKeys first.",
};
const DELETE_CALL = /\.delete\(apiKeys\)|DELETE FROM api_keys/;
const deleting = new Set<string>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (codeLines(readFileSync(file, "utf8")).some((l) => DELETE_CALL.test(l)))
      deleting.add(relative(REPO, file));
  }
}

describe("API-key hard deletes are known", () => {
  it("finds the delete sites (non-vacuity)", () => {
    expect(deleting.size).toBeGreaterThanOrEqual(3);
  });

  it("every hard-deleting file is on the list, and every entry still deletes", () => {
    expect([...deleting].sort()).toEqual(Object.keys(DELETE_SITES).sort());
  });

  it("the active-key deleters revoke through the door first", () => {
    for (const f of [
      "packages/api/src/routers/system.ts",
      "apps/api/src/routers/provision.ts",
    ]) {
      expect(readFileSync(join(REPO, f), "utf8")).toMatch(/revokeApiKeys\(/);
    }
  });
});
