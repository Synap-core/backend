/**
 * Pod OAuth 2.1 authorization server — end-to-end HTTP flow (Path B).
 *
 * Covers the properties a break in which is silent and severe:
 *   (a) metadata: `issuer` is the pod's canonical PUBLIC_URL, every endpoint is
 *       derived from it, and an unconfigured pod 503s instead of guessing.
 *   (b) DCR mints a public client and freezes its https redirect_uris.
 *   (c) /authorize: an unknown client or unregistered redirect_uri is shown to
 *       the USER and NEVER redirected (RFC 6749 §4.1.2.1); a valid request lands
 *       on the pod-admin consent screen.
 *   (d) PKCE at /token: a WRONG verifier and an ABSENT verifier both FAIL.
 *   (e) the authorization code is SINGLE-USE — a replay is rejected even with
 *       the correct verifier.
 *   (f) ⚠️ the minted key carries `linkedUserId` = the consenting human, and the
 *       mcp.* + hub-protocol.* scopes. This is the governance membrane: the pod
 *       derives `agentUserId = keyRecord.linkedUserId ? keyRecord.userId :
 *       undefined` (mcp/http-handler.ts), and a DEFINED agentUserId is the only
 *       thing that routes an MCP write into a proposal. Omit linkedUserId and
 *       every Claude write silently auto-applies as the operator.
 *
 * Strategy: an IN-MEMORY store that implements the real `db` semantics the code
 * relies on — in particular the atomic `UPDATE … WHERE consumed_at IS NULL …
 * RETURNING` claim — so single-use is genuinely EXERCISED rather than stubbed.
 * `@synap/database/schema` stays REAL, so `mapCpScopesToPodScopes` runs against
 * the actual `isValidScope`. No live Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory store standing in for Postgres ────────────────────────────────

interface CodeRow {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

const store = {
  clients: new Map<string, Record<string, unknown>>(),
  codes: new Map<string, CodeRow>(),
  users: new Map<string, { id: string; userType: string }>(),
};

/**
 * Every WHERE the claim statement issues, captured so a test can assert the
 * route ASKS the database for the atomic guarantee (rather than the in-memory
 * mock inventing it — see the "structurally atomic" test below).
 */
const claimWhere: any[] = [];

/**
 * The mocked `eq`/`and`/... builders produce tagged objects; these readers pull
 * the operand back out. Positional, but the shapes are fixed by the two call
 * sites in store.ts and consent.ts.
 */
function eqValue(cond: any): unknown {
  return cond?._eq?.[1];
}
function firstEqValue(cond: any): unknown {
  if (cond?._eq) return cond._eq[1];
  for (const part of cond?._and ?? []) {
    if (part?._eq) return part._eq[1];
  }
  return undefined;
}

vi.mock("@synap/database", () => {
  return {
    db: {
      insert: (_table: any) => ({
        values: (v: any) => {
          // `oauth_clients` vs `oauth_authorization_codes` — the real schema
          // objects are in play, so discriminate on the row shape.
          if (v.codeHash !== undefined) {
            store.codes.set(v.codeHash, { ...v, consumedAt: null });
          } else {
            store.clients.set(v.clientId, v);
          }
          return Promise.resolve();
        },
      }),
      // The ATOMIC single-use claim: consume only when currently unconsumed AND
      // unexpired, returning the row in the same statement.
      update: (_table: any) => ({
        set: (payload: any) => ({
          where: (cond: any) => (
            claimWhere.push(cond),
            {
              returning: (_cols: unknown) => {
                const hash = firstEqValue(cond) as string;
                const row = store.codes.get(hash);
                if (!row) return Promise.resolve([]);
                if (row.consumedAt !== null) return Promise.resolve([]);
                if (row.expiresAt.getTime() <= Date.now())
                  return Promise.resolve([]);
                row.consumedAt = payload.consumedAt ?? new Date();
                return Promise.resolve([
                  {
                    clientId: row.clientId,
                    userId: row.userId,
                    redirectUri: row.redirectUri,
                    scopes: row.scopes,
                    codeChallenge: row.codeChallenge,
                  },
                ]);
              },
            }
          ),
        }),
      }),
      query: {
        oauthClients: {
          findFirst: ({ where }: any) =>
            Promise.resolve(
              store.clients.get(eqValue(where) as string) ?? null
            ),
        },
        users: {
          findFirst: ({ where }: any) =>
            Promise.resolve(store.users.get(eqValue(where) as string) ?? null),
        },
      },
    },
    users: { id: "users.id" },
    mcpConnectCodes: {},
    and: (...args: unknown[]) => ({ _and: args }),
    eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
    isNull: (a: unknown) => ({ _isNull: a }),
    gt: (a: unknown, b: unknown) => ({ _gt: [a, b] }),
    ApiKeyRepository: class {},
    EventRepository: class {},
    sql: {},
  };
});

// `mapCpScopesToPodScopes` (the mcp→hub-protocol peering rule /token reuses)
// lives in mcp-redeem.ts, whose `_shared.js` import drags in the whole hub
// router + access registry. Stub that ONE module so the real scope mapper still
// runs against the real `isValidScope` without booting the tRPC tree.
vi.mock("../hub-protocol/rest/_shared.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../utils/jwks-client.js", () => ({
  verifyTrustedIssuerJwt: vi.fn(),
}));

// The ONE key-minting door. Captured so we can assert exactly what /token asks
// for — this spy is where the linkedUserId contract is proven.
const provisionSpy = vi.fn();
vi.mock("../../services/agent-identity-service.js", () => ({
  provisionSurfaceAgentKey: (opts: unknown) => provisionSpy(opts),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Import AFTER the mocks are registered.
import { oauthApp } from "./routes.js";
import { computeS256Challenge } from "./protocol.js";
import { decideOAuthAuthorization } from "./consent.js";

const ISSUER = "https://pod.test.synap.live";
const POD_ADMIN = "https://pod-admin.test.synap.live";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "x".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);

beforeEach(() => {
  store.clients.clear();
  store.codes.clear();
  store.users.clear();
  claimWhere.length = 0;
  store.users.set(HUMAN_ID, { id: HUMAN_ID, userType: "human" });
  provisionSpy.mockReset();
  provisionSpy.mockResolvedValue({
    agentUserId: "agent-user-1",
    alreadyValid: false,
    registration: { outcome: "CONNECTED_VERIFIED" },
    apiKey: { expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000) },
    plainKey: "synap_live_TESTKEY",
    keyId: "key-1",
  });
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = POD_ADMIN;
  delete process.env.POD_ADMIN_DOMAIN;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function register(overrides: Record<string, unknown> = {}) {
  const res = await oauthApp.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CALLBACK],
      client_name: "Claude",
      ...overrides,
    }),
  });
  return { res, body: (await res.json()) as any };
}

function authorizeUrl(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return `/authorize?${qs}`;
}

/** Run the consent decision the pod-admin screen would make, returning the code. */
async function consentAndExtractCode(clientId: string, state?: string) {
  const { redirectTo } = await decideOAuthAuthorization(
    {
      clientId,
      redirectUri: CALLBACK,
      responseType: "code",
      scope: "mcp.read mcp.write",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      state: state ?? null,
      approve: true,
    },
    HUMAN_ID
  );
  return { redirectTo, code: new URL(redirectTo).searchParams.get("code")! };
}

async function token(params: Record<string, string>) {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { res, body: (await res.json()) as any };
}

// ─── (a) Metadata ────────────────────────────────────────────────────────────

describe("discovery metadata", () => {
  it("serves RFC 8414 metadata whose issuer is the canonical PUBLIC_URL", async () => {
    const res = await oauthApp.request(
      "/.well-known/oauth-authorization-server"
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(doc.token_endpoint).toBe(`${ISSUER}/token`);
    expect(doc.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("canonicalizes a PUBLIC_URL with a trailing slash", async () => {
    process.env.PUBLIC_URL = `${ISSUER}/`;
    const res = await oauthApp.request(
      "/.well-known/oauth-authorization-server"
    );
    const doc = (await res.json()) as any;
    // A trailing slash here would make every derived endpoint a double-slash URL
    // and break the byte-for-byte issuer comparison a strict client performs.
    expect(doc.issuer).toBe(ISSUER);
  });

  it("serves RFC 9728 protected-resource metadata pointing at itself", async () => {
    const res = await oauthApp.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.resource).toBe(`${ISSUER}/mcp`);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it("also answers the `/mcp`-suffixed well-known paths clients probe", async () => {
    for (const p of [
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      expect((await oauthApp.request(p)).status).toBe(200);
    }
  });

  it("503s rather than guessing an issuer from the Host header", async () => {
    delete process.env.PUBLIC_URL;
    const res = await oauthApp.request(
      "/.well-known/oauth-authorization-server"
    );
    expect(res.status).toBe(503);
  });

  it("503s when PUBLIC_URL is not canonical (has a query string)", async () => {
    process.env.PUBLIC_URL = "https://pod.test.synap.live?x=1";
    expect(
      (await oauthApp.request("/.well-known/oauth-authorization-server")).status
    ).toBe(503);
  });
});

// ─── (b) Dynamic client registration ─────────────────────────────────────────

describe("POST /register", () => {
  it("registers a public client and returns 201 with a generated client_id", async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^dcr_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
    expect(body.redirect_uris).toEqual([CALLBACK]);
  });

  it("never lets the client choose its own client_id", async () => {
    const { body } = await register({ client_id: "attacker-chosen" });
    expect(body.client_id).not.toBe("attacker-chosen");
  });

  it("rejects a non-https redirect_uri with 400", async () => {
    const { res, body } = await register({
      redirect_uris: ["http://claude.ai/cb"],
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a non-JSON body", async () => {
    const res = await oauthApp.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

// ─── (c) /authorize ──────────────────────────────────────────────────────────

describe("GET /authorize", () => {
  it("redirects a valid request to the pod-admin consent screen", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        scope: "mcp.read mcp.write",
        state: "st-1",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe(POD_ADMIN);
    expect(target.pathname).toBe("/oauth/consent");
    expect(target.searchParams.get("client_id")).toBe(client.client_id);
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(target.searchParams.get("code_challenge")).toBe(CHALLENGE);
  });

  it("shows an UNKNOWN client_id to the user and does NOT redirect", async () => {
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: "dcr_nope",
        redirect_uri: CALLBACK,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    // RFC 6749 §4.1.2.1 — redirecting here would be to an UNVALIDATED URI.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("shows an UNREGISTERED redirect_uri to the user and does NOT redirect", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://attacker.example/steal",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    expect(res.status).toBe(400);
    // The open-redirect hole: this MUST NOT bounce the browser to the attacker.
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a PKCE-less request back to the client as an error", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        state: "st-2",
      })
    );
    // redirect_uri IS validated by now, so the error goes back to the client.
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("state")).toBe("st-2");
  });

  it("rejects code_challenge_method=plain", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        code_challenge: CHALLENGE,
        code_challenge_method: "plain",
      })
    );
    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error")
    ).toBe("invalid_request");
  });
});

// ─── Consent ─────────────────────────────────────────────────────────────────

describe("consent decision", () => {
  it("Deny returns access_denied to the client and mints NO code", async () => {
    const { body: client } = await register();
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: client.client_id,
        redirectUri: CALLBACK,
        responseType: "code",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        state: "st-3",
        approve: false,
      },
      HUMAN_ID
    );
    const back = new URL(redirectTo);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("st-3");
    expect(back.searchParams.get("code")).toBeNull();
    expect(store.codes.size).toBe(0);
  });

  it("refuses to let an AGENT user author its own consent", async () => {
    const { body: client } = await register();
    const agentId = "22222222-2222-4222-8222-222222222222";
    store.users.set(agentId, { id: agentId, userType: "agent" });
    await expect(
      decideOAuthAuthorization(
        {
          clientId: client.client_id,
          redirectUri: CALLBACK,
          responseType: "code",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          approve: true,
        },
        agentId
      )
    ).rejects.toThrow(/human/i);
    expect(store.codes.size).toBe(0);
  });

  it("re-validates the redirect_uri at Allow (a tampered round-trip is rejected)", async () => {
    const { body: client } = await register();
    await expect(
      decideOAuthAuthorization(
        {
          clientId: client.client_id,
          // Rewritten in the consent screen's URL bar after /authorize approved
          // the real one — must not be honored.
          redirectUri: "https://attacker.example/steal",
          responseType: "code",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          approve: true,
        },
        HUMAN_ID
      )
    ).rejects.toThrow();
    expect(store.codes.size).toBe(0);
  });

  it("stores only a HASH of the code, never the code itself", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    expect(store.codes.has(code)).toBe(false);
    expect(store.codes.size).toBe(1);
    const [row] = [...store.codes.values()];
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
    // The consenting human is bound to the code — this is what becomes
    // linkedUserId at /token.
    expect(row.userId).toBe(HUMAN_ID);
  });
});

// ─── (d)(e)(f) /token ────────────────────────────────────────────────────────

describe("POST /token", () => {
  it("exchanges a code for an access token when the PKCE verifier matches", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);

    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });

    expect(res.status).toBe(200);
    expect(body.access_token).toBe("synap_live_TESTKEY");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  // ⚠️ THE GOVERNANCE MEMBRANE — see the file header.
  it("mints the key with linkedUserId = the consenting human", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });

    expect(provisionSpy).toHaveBeenCalledTimes(1);
    const opts = provisionSpy.mock.calls[0][0];
    // Without this, http-handler.ts computes `agentUserId = undefined` and every
    // Claude write bypasses checkPermissionOrPropose() — auto-applying with the
    // operator's authority, with no error to notice.
    expect(opts.linkedUserId).toBe(HUMAN_ID);
    expect(opts.createdByUserId).toBe(HUMAN_ID);
  });

  it("mints with the mcp.* scopes AND their hub-protocol.* peers", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    const opts = provisionSpy.mock.calls[0][0];
    // MCP tool dispatch rides the hub, so the peers are functionally required.
    expect(opts.scopes).toEqual(
      expect.arrayContaining([
        "mcp.read",
        "mcp.write",
        "hub-protocol.read",
        "hub-protocol.write",
      ])
    );
  });

  it("uses agentType claude-web-direct so Path B is separable from Path A", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    const opts = provisionSpy.mock.calls[0][0];
    expect(opts.agentType).toBe("claude-web-direct");
    // Instance keyed on (client, human) so re-authorizing rotates only this
    // connection's key and never revokes another human's.
    expect(opts.instanceId).toContain(HUMAN_ID);
    expect(opts.instanceId).toContain(client.client_id);
  });

  // ── (d) PKCE enforcement ───────────────────────────────────────────────────

  it("FAILS with a WRONG code_verifier and mints nothing", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);

    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: "y".repeat(64),
    });

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("FAILS with an ABSENT code_verifier and mints nothing", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);

    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      // no code_verifier at all
    });

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("burns the code even when PKCE fails — a guessed verifier is not retryable", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);

    await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: "y".repeat(64),
    });
    // Now the CORRECT verifier must still fail: claim-before-verify means a
    // failed exchange consumes the code.
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  // ── (e) Single use ─────────────────────────────────────────────────────────

  it("REJECTS a replayed authorization code (single-use)", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    const args = {
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    };

    const first = await token(args);
    expect(first.res.status).toBe(200);

    const replay = await token(args);
    expect(replay.res.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    // Exactly ONE key was ever minted from this code.
    expect(provisionSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The replay test above proves the ROUTE consumes the code and rejects a
   * second exchange. It cannot prove the DATABASE is atomic — the in-memory
   * store implements those semantics itself. This test proves the remaining
   * half statically: the claim is ONE `UPDATE … SET consumed_at … WHERE
   * code_hash = ? AND consumed_at IS NULL AND expires_at > now RETURNING`, so
   * the single-use guarantee is the database's row lock and not a
   * read-then-write the caller could lose a race on.
   */
  it("asks the database for the guarantee: claim is one atomic UPDATE…RETURNING", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });

    expect(claimWhere).toHaveLength(1);
    const parts = claimWhere[0]._and;
    // code_hash = ? AND consumed_at IS NULL AND expires_at > now
    expect(parts.some((p: any) => p?._eq)).toBe(true);
    expect(parts.some((p: any) => p?._isNull)).toBe(true);
    expect(parts.some((p: any) => p?._gt)).toBe(true);
  });

  it("rejects an EXPIRED code", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    for (const row of store.codes.values()) {
      row.expiresAt = new Date(Date.now() - 1000);
    }
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("rejects an unknown code with the SAME generic error (no existence oracle)", async () => {
    const { body: client } = await register();
    const { body } = await token({
      grant_type: "authorization_code",
      code: "totally-made-up",
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(body.error).toBe("invalid_grant");
  });

  // ── Binding checks ─────────────────────────────────────────────────────────

  it("rejects a code redeemed by a DIFFERENT client", async () => {
    const { body: clientA } = await register();
    const { body: clientB } = await register({ client_name: "Other" });
    const { code } = await consentAndExtractCode(clientA.client_id);

    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientB.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("rejects a redirect_uri that differs from the authorize request's", async () => {
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/other_callback",
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("rejects an unsupported grant_type", async () => {
    const { res, body } = await token({
      grant_type: "refresh_token",
      refresh_token: "whatever",
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("unsupported_grant_type");
  });

  it("fails loudly (500) rather than returning a broken token when minting fails", async () => {
    provisionSpy.mockResolvedValue({
      agentUserId: "agent-user-1",
      alreadyValid: false,
      registration: {
        outcome: "VERIFICATION_FAILED",
        verificationError: "nope",
      },
      apiKey: {},
      plainKey: "synap_live_TESTKEY",
      keyId: "key-1",
    });
    const { body: client } = await register();
    const { code } = await consentAndExtractCode(client.client_id);
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(500);
    expect(body.error).toBe("server_error");
  });
});

// ─── Full flow ───────────────────────────────────────────────────────────────

describe("full authorization code flow", () => {
  it("discovery → register → authorize → consent → token", async () => {
    // 1. Discovery
    const meta = (await (
      await oauthApp.request("/.well-known/oauth-authorization-server")
    ).json()) as any;
    expect(meta.issuer).toBe(ISSUER);

    // 2. DCR
    const { body: client } = await register();

    // 3. Authorize → consent screen
    const authRes = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        scope: "mcp.read mcp.write",
        state: "opaque-state",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    expect(authRes.status).toBe(302);

    // 4. The human allows
    const { redirectTo } = await consentAndExtractCode(
      client.client_id,
      "opaque-state"
    );
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    // `state` is the client's CSRF token and must round-trip verbatim.
    expect(back.searchParams.get("state")).toBe("opaque-state");

    // 5. Token exchange
    const { res, body } = await token({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(200);
    expect(body.access_token).toBeTruthy();
    expect(provisionSpy.mock.calls[0][0].linkedUserId).toBe(HUMAN_ID);
  });
});
