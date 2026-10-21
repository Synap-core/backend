import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — API-key identity resolution has ONE door (`resolveKeyIdentity`).
 *
 * Every transport that authenticates an API key must derive the same three
 * identity facts the same way. Before consolidation the derivation was
 * copy-pasted at three sites as
 *
 *     agentUserId = keyRecord.linkedUserId ? keyRecord.userId : undefined
 *
 * which conflated "has a linked human" (DELEGATION) with "is an agent" (the fact
 * the governance membrane needs). The real is-agent signal is the key
 * principal's `users.userType === 'agent'`. `resolveKeyIdentity`
 * (access/key-identity.ts) is now the ONLY place that derivation lives.
 *
 * This test has two halves, mirroring `a2ai-one-door.test.ts`:
 *   1. STATIC (source-grep): the hand-rolled remap may appear ONLY in the
 *      resolver; every key door imports + calls `resolveKeyIdentity`, and every
 *      SERVING door enters the request scope; and the MCP attribution reject
 *      gate keys on the AGENT signal, not `linkedUserId`.
 *   2. CONTRACT (runnable): the same keyRecord fixtures fed through the resolver
 *      derive the correct `{effectiveUserId, agentUserId, isAgent}` — the real
 *      proof the derivation is right.
 *
 * THE DOOR SET IS DERIVED, NOT HAND-WRITTEN. Until 2026-10-13 it was a list of
 * three files, and `/api/external/*` (routers/external/middleware.ts) — a
 * fourth door calling `validateApiKey` — authenticated agent keys as their own
 * principal with no acting agent and no grant, while this test stayed green.
 * A door is now any non-test source file under `src/` that CALLS a key-auth
 * primitive (`.validateApiKey(` / `.getApiKeyStatus(`); it joins the scan by
 * existing, and must either satisfy the rules or be CLASSIFIED below with a
 * reason.
 *
 * WHAT THIS DOES NOT SEE (measured, not implied): granularity is the FILE —
 * `hub-protocol/rest/setup.ts` validates keys at five sites and resolves
 * identity at two, and passes. A door that authenticates through some other
 * primitive (a hand-rolled `api_keys` hash lookup) is invisible to the scan.
 */

const SRC = join(process.cwd(), "src");
/** A CALL to a key-auth primitive through an object (`apiKeyService.x(`). */
const KEY_AUTH_CALL = /\.(validateApiKey|getApiKeyStatus)\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__") continue;
      walk(full, out);
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(e.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Every key door, as a path relative to the package root (`src/...`). */
function deriveKeyDoors(): string[] {
  return walk(SRC)
    .filter((f) => KEY_AUTH_CALL.test(readFileSync(f, "utf8")))
    .map((f) => relative(process.cwd(), f))
    .sort();
}

/**
 * Doors that READ a key's state but serve no request as it — exempt from
 * every rule below. Each entry must say why; a stale entry fails the test.
 */
const INTROSPECTION_ONLY: Record<string, string> = {
  "src/services/key-holder-state.ts":
    "describes a key's state to its HOLDER (/auth/key-state); no request runs as the key",
  "src/services/external-registration.ts":
    "verifies a key it just minted (owner + scopes); no request runs as the key",
  "src/routers/hub-protocol/rest/auth.ts":
    "/auth/key-state reads the bearer's status for its holder; no handler runs as the key",
  "src/routers/oauth/routes.ts":
    "RFC 7009 /revoke: possession of the presented token retires it — its status, type and owner are read only to floor revocation to keys this AS mints (a person's app sign-in token included); no request runs as the key",
};

/**
 * Doors that resolve identity to DECIDE a credential question (may this key
 * mint / provision?) and then act as the pod, not as the key — so they enter
 * no acting-agent / grant scope. They still must use `resolveKeyIdentity`.
 */
const CREDENTIAL_CHECK_ONLY: Record<string, string> = {
  "src/routers/hub-protocol/rest/setup.ts":
    "provisioning auth: identity decides whether an agent key may mint/provision (isAgent)",
};

// The ONE door.
const RESOLVER = "src/access/key-identity.ts";
// The exact hand-rolled agentUserId derivation the resolver replaces. It ties
// the acting-agent identity to the DELEGATION fact — the bug being retired.
const BANNED_REMAP = "linkedUserId ? keyRecord.userId";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("tripwire: API-key identity has one door (resolveKeyIdentity)", () => {
  const DOORS = deriveKeyDoors();
  const IDENTITY_DOORS = DOORS.filter((d) => !(d in INTROSPECTION_ONLY));
  const SERVING_DOORS = IDENTITY_DOORS.filter(
    (d) => !(d in CREDENTIAL_CHECK_ONLY)
  );

  it("the derived door scan is not vacuous", () => {
    // Self-check: the pattern still sees a literal call.
    expect(
      KEY_AUTH_CALL.test("await apiKeyService.validateApiKey(token)")
    ).toBe(true);
    expect(KEY_AUTH_CALL.test("async validateApiKey(apiKey: string)")).toBe(
      false
    );
    // The four serving doors known today must all be found by the scan.
    expect(DOORS.length).toBeGreaterThanOrEqual(4);
    for (const known of [
      "src/middleware/api-key-auth.ts",
      "src/routers/hub-protocol/_middleware/auth.ts",
      "src/routers/mcp/http-handler.ts",
      "src/routers/external/middleware.ts",
    ]) {
      expect(
        SERVING_DOORS,
        `${known} must be scanned as a serving door`
      ).toContain(known);
    }
  });

  it("every classified exemption names a door that still exists", () => {
    for (const rel of [
      ...Object.keys(INTROSPECTION_ONLY),
      ...Object.keys(CREDENTIAL_CHECK_ONLY),
    ]) {
      expect(DOORS, `stale classification: ${rel}`).toContain(rel);
    }
  });

  it("each key door imports AND calls resolveKeyIdentity", () => {
    for (const rel of IDENTITY_DOORS) {
      const src = read(rel);
      expect(
        src,
        `${rel} authenticates an API key, so it must import resolveKeyIdentity ` +
          "from the access door (or be classified INTROSPECTION_ONLY with a reason)"
      ).toMatch(
        /import\s*\{[^}]*resolveKeyIdentity[^}]*\}\s*from\s*["'][^"']*access\/key-identity\.js["']/
      );
      expect(
        src,
        `${rel} must CALL resolveKeyIdentity(keyRecord) — not hand-roll the remap`
      ).toMatch(/resolveKeyIdentity\(keyRecord\)/);
    }
  });

  it("each serving door enters the acting-agent AND grant request scope", () => {
    for (const rel of SERVING_DOORS) {
      const src = read(rel);
      expect(
        src,
        `${rel} serves requests as a key, so it must run them inside ` +
          "runWithActingAgent(...) — otherwise an agent key is ungoverned downstream"
      ).toMatch(/runWithActingAgent\(/);
      expect(
        src,
        `${rel} must run requests inside runWithGrant(...) — the key's grant ` +
          "bounds every write gate and scoped read"
      ).toMatch(/runWithGrant\(/);
    }
  });

  it("no key door hand-rolls the linkedUserId→agentUserId remap", () => {
    const offenders = DOORS.filter((rel) => read(rel).includes(BANNED_REMAP));
    expect(
      offenders,
      "the agent-identity derivation belongs ONLY in access/key-identity.ts. " +
        "Call resolveKeyIdentity(keyRecord) instead of hand-rolling it."
    ).toEqual([]);
  });

  it("the resolver keys agentUserId on the is-agent signal, not linkedUserId", () => {
    const src = read(RESOLVER);
    // The acting agent is derived from `isAgent`, never from "has a linked human".
    expect(src).toMatch(
      /agentUserId:\s*isAgent\s*\?\s*keyRecord\.userId\s*:\s*undefined/
    );
    // And `isAgent` itself is the principal's userType, not linkedUserId.
    expect(src).toMatch(/userType\s*===\s*["']agent["']/);
  });

  it("the MCP attribution reject gate keys on the agent signal (admits agents)", () => {
    const src = read("src/routers/mcp/http-handler.ts");
    const at = src.indexOf("function shouldRejectUnattributedWrite");
    expect(at).toBeGreaterThan(-1);
    // The bare-key predicate must AND in `!isAgent` — otherwise a legitimate
    // pod-wide agent (userType='agent', no linked human) is wrongly rejected.
    const body = src.slice(at, at + 900);
    expect(
      body,
      "shouldRejectUnattributedWrite must consult the is-agent signal so a real " +
        "agent principal is ADMITTED, not rejected as an unattributed write."
    ).toMatch(/!isAgent/);
  });
});

// ── CONTRACT: the derivation itself ────────────────────────────────────────────
// Stub the ONE users lookup the resolver performs. `db.query.users.findFirst`
// returns the principal's userType (or undefined for the "system" sentinel).
// The fixtures carry no key `id`, so no grant is read (`grant: null`).
const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: { query: { users: { findFirst: findFirstMock } } },
}));

// Imported AFTER the mock (vi.mock is hoisted above imports by vitest).
import { resolveKeyIdentity } from "../access/key-identity.js";

describe("contract: resolveKeyIdentity derivation", () => {
  beforeEach(() => findFirstMock.mockReset());

  it("agent principal + linked human → human owns data, agent attributed", async () => {
    findFirstMock.mockResolvedValue({ userType: "agent" });
    expect(
      await resolveKeyIdentity({ userId: "agent-1", linkedUserId: "human-1" })
    ).toEqual({
      effectiveUserId: "human-1",
      agentUserId: "agent-1",
      isAgent: true,
      grant: null,
    });
  });

  it("agent principal + NO linked human (pod-wide agent, #1b) → still attributed", async () => {
    findFirstMock.mockResolvedValue({ userType: "agent" });
    expect(
      await resolveKeyIdentity({ userId: "agent-1", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "agent-1",
      agentUserId: "agent-1",
      isAgent: true,
      grant: null,
    });
  });

  it("human principal (PAT) → owner is the user, no agent attribution", async () => {
    findFirstMock.mockResolvedValue({ userType: "human" });
    expect(
      await resolveKeyIdentity({ userId: "human-1", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "human-1",
      agentUserId: undefined,
      isAgent: false,
      grant: null,
    });
  });

  it("no users row (e.g. 'system' sentinel) → not an agent", async () => {
    findFirstMock.mockResolvedValue(undefined);
    expect(
      await resolveKeyIdentity({ userId: "system", linkedUserId: null })
    ).toEqual({
      effectiveUserId: "system",
      agentUserId: undefined,
      isAgent: false,
      grant: null,
    });
  });
});
