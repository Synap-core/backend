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
import { stripComments } from "../../../../scripts/strip-comments.mjs";

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
  "packages/api/src/services/machine-connect.ts":
    "the device door (MACHINE-IDENTITY-PLAN W2): mints the computer's user_pat (AI — read & propose grant) ONLY at collection by the device code, after a signed-in person approved (tRPC refuses any key or agent caller); hosted agents mint through provisionSurfaceAgentKey.",
  "packages/api/src/routers/hub-protocol/rest/mcp-redeem.ts":
    "/mcp/redeem — CP-asserted one-time code → provisionSurfaceAgentKey.",
  "packages/api/src/routers/oauth/routes.ts":
    "OAuth /token — an MCP (DCR) client's authorization code → provisionSurfaceAgentKey; a pod app's code or refresh token (PB3, refresh.ts) goes to app-connect's mintAppOAuthAccessKey (which hands a SYNAP app to app-person-token's mintPodAppPersonToken).",
  "packages/api/src/routers/hub-protocol/rest/agent-users.ts":
    "POST /agent-users — human session only; 403 for an agent key (2026-10-06).",
  "packages/api/src/services/app-connect.ts":
    "issueKey — behind POST /apps/:id/key AND tRPC apps.issueKey (App Connect, one service). Runs ONLY after the app/connect proposal is approved; owner-only; refuses an agent principal (else an agent key owned by the same human would pass the owner test) AND a grant-bound key (an app key must never mint app keys); mints the app's user_pat and attaches one grant per approved workspace (client_id = app.public_id). mintAppOAuthAccessKey — behind OAuth /token for a pod app (CIMD client) only, after the person's consent approved that app's app/connect request, or at a refresh of that connection (re-derived from the CURRENT approval): a 1 h hub_inbound key held by the app's OWN agent (never claude-web*), one grant per approved workspace, expiring with it — except for a SYNAP app (podAppActsAs = person), which it routes to app-person-token's door instead of minting.",
  "packages/api/src/services/app-person-token.ts":
    'The ONE door for a key HELD BY THE PERSON (key_type app_person), reached ONLY from OAuth /token. mintAppPersonToken — "Sign in with Synap": an `app_…` client (a live app its owner APPROVED, redirect_uri the owner registered, PKCE, single-use code); 30 days; attaches the consented ∩ approved ∩ reachable grant (client_id = the app). mintPodAppPersonToken — a SYNAP pod app (CIMD client_id on an exact https://<id>.synap.live origin, isSynapApp, re-checked here), at a code exchange or a refresh of the person\'s OWN connection: 1 h, the connection\'s key slot, attaches its approval ∩ the person\'s reach (client_id = the connection). Never an agent\'s key; both refuse a non-human holder.',
  "packages/api/src/routers/hub-protocol/rest/keys.ts":
    "/keys/rotate-cli — hub_inbound read+write keys only, keeps expiry (2026-10-06).",
  "apps/api/src/routers/provision.ts":
    "is_internal key behind a CP-signed JWT.",
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

/** Comments blanked so prose naming a primitive is not a mint. */
function codeLines(src: string): string[] {
  return stripComments(src, "ts").split("\n");
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
 * P2b — an AI's key always carries its limits. Files that mint an AGENT's key
 * through a raw primitive (not `provisionSurfaceAgentKey` / `createNamedAgent`,
 * which attach it themselves), with how many such mints they hold. Each must
 * attach the agent's grant at least that many times (`attachAgentKeyGrant`,
 * or `attachGrantOrRevoke` inside the agent-identity service).
 *
 * NOT COVERED (stated): which mints are agent keys is a review decision made
 * here; granularity is a COUNT per file, so an attach that guards a different
 * mint than the one added passes. A file absent from this map mints no agent
 * key by its own primitive (the `is_internal` IS key in provision.ts is the
 * IS's service key, owned by "system", not an agent).
 */
// The bundled-agent provisioning doors (intelligenceRegistry.provisionAgent /
// rotateAgentKey, intelligence.provisionService, the CP activate-addon, the
// provision-agent script) were removed with OpenClaw (2026-10-14): every other
// agent key goes through the agent door, so one raw agent-key minter is left.
const AGENT_KEY_MINTS: Partial<Record<keyof typeof MINT_SITES, number>> = {
  "packages/api/src/services/agent-identity-service.ts": 2,
};
const ATTACH_CALL = /\b(?:attachAgentKeyGrant|attachGrantOrRevoke)\(/;

describe("every agent key minted by a raw primitive carries its grant", () => {
  it("each agent-key mint file attaches the grant as often as it mints", () => {
    expect(Object.keys(AGENT_KEY_MINTS).length).toBeGreaterThanOrEqual(1);
    expect(ATTACH_CALL.test("await attachAgentKeyGrant({")).toBe(true);
    const short: string[] = [];
    for (const [file, mints] of Object.entries(AGENT_KEY_MINTS)) {
      const lines = codeLines(readFileSync(join(REPO, file), "utf8"));
      const attaches = lines.filter((l) => ATTACH_CALL.test(l)).length;
      expect(minting.has(file), `${file} must still mint`).toBe(true);
      if (attaches < mints!)
        short.push(`${file}: ${attaches} attach for ${mints} agent mints`);
    }
    expect(
      short,
      "Attach the agent's grant after each mint (attachAgentKeyGrant)."
    ).toEqual([]);
  });
});

/**
 * P5 — deny by default: a key with NO grant row may touch nothing, so EVERY
 * mint attaches one. For each minting file (the derived set above) that is not
 * a PRIMITIVE, the attaches must be at least as many as the mints:
 *   - mints   = MINT_CALL lines, minus calls to a primitive that attaches
 *               itself (`provisionSurfaceAgentKey`, `createNamedAgent` — the
 *               agent door — and `.rotate(`, which carries the old key's grants);
 *   - attaches = `attach{Grant,Grants}OrRevoke`, `attachFullAccessGrant`,
 *               `attachAgentKeyGrant`, `carryOver`, or a raw `INSERT INTO
 *               grants` in the same statement (operator script). NOT
 *               `.attachMany(`: it also edits a live key's grants, and counting
 *               it let a removed mint attach pass (negative control, P5).
 * A PRIMITIVE mints for its callers, which are minting files themselves and
 * so are held to the rule — the coverage is transitive.
 *
 * NOT COVERED (stated): granularity is a COUNT per file, so an attach that
 * guards a different mint than the one added passes, and an attach on a path
 * the mint does not reach is counted. Self-attaching primitives are trusted by
 * name; `agent-identity-service.ts` is itself counted (its two raw mints).
 */
const PRIMITIVES = new Set([
  "packages/database/src/repositories/api-key-repository.ts",
  "packages/api/src/services/api-keys.ts",
  "packages/api/src/services/hub-integration-registration.ts",
  "packages/api/src/services/external-registration.ts",
]);
const SELF_ATTACHING_MINT =
  /\b(?:provisionSurfaceAgentKey|createNamedAgent)\(|apiKeyRepo\w*\.rotate\(/;
const GRANT_ATTACH =
  /\b(?:attachGrantOrRevoke|attachGrantsOrRevoke|attachFullAccessGrant|attachAgentKeyGrant|carryOver)\(|INSERT INTO grants/;

/** [mints, attaches] in one file's code lines (definitions excluded). */
function mintAndAttachCounts(src: string): [number, number] {
  const lines = codeLines(src).filter((l) => !/\bfunction\s/.test(l));
  const mints = lines.filter(
    (l) => MINT_CALL.test(l) && !SELF_ATTACHING_MINT.test(l)
  ).length;
  return [mints, lines.filter((l) => GRANT_ATTACH.test(l)).length];
}

describe("every mint attaches a grant (P5 — deny by default)", () => {
  it("the rule can see a mint and an attach (non-vacuity)", () => {
    expect(
      mintAndAttachCounts(
        "const k = await apiKeyRepo.create({});\nawait attachFullAccessGrant({});"
      )
    ).toEqual([1, 1]);
    expect(
      mintAndAttachCounts("const k = await apiKeyRepo.create({});")
    ).toEqual([1, 0]);
    expect(
      mintAndAttachCounts("const k = await provisionSurfaceAgentKey({});")
    ).toEqual([0, 0]);
    for (const p of PRIMITIVES) expect(minting.has(p), p).toBe(true);
  });

  it("each minting file attaches at least as often as it mints", () => {
    const checked = [...minting].filter((f) => !PRIMITIVES.has(f));
    expect(checked.length).toBeGreaterThanOrEqual(10);
    let mintsSeen = 0;
    const short: string[] = [];
    for (const file of checked) {
      const [mints, attaches] = mintAndAttachCounts(
        readFileSync(join(REPO, file), "utf8")
      );
      mintsSeen += mints;
      if (attaches < mints)
        short.push(`${file}: ${attaches} attach for ${mints} mints`);
    }
    // 14 since the bundled-agent provisioning doors were removed (2026-10-14).
    expect(mintsSeen).toBeGreaterThanOrEqual(14);
    expect(
      short,
      "Attach a grant after each mint — a key with no grant touches nothing. Use attachFullAccessGrant for a key that is its holder's own full reach."
    ).toEqual([]);
  });

  it("the repository's rotation carries the grants it is trusted for", () => {
    expect(
      readFileSync(
        join(REPO, "packages/database/src/repositories/api-key-repository.ts"),
        "utf8"
      )
    ).toMatch(/carryOver\(/);
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
  "packages/api/src/services/app-connect.ts":
    "sweepDeadOAuthKeys (PB3 GC) — deletes a pod app connection's keys that are already REVOKED (is_active = false) only, beyond the newest two; their grants cascade.",
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
