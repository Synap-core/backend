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
 *   (g) the agentType is decided by WHERE the code goes: a redirect_uri on the
 *       approved Control Plane's origin mints `claude-web` (the CP connector,
 *       whose readers render `pod__` names); any other origin — including an
 *       https look-alike and a CP that is only PENDING — mints
 *       `claude-web-direct`.
 *   (h) RFC 7009 /revoke retires a `claude-web*` key on possession, and is a
 *       no-op 200 for any other key (a human PAT presented is NOT revoked).
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
  resource?: string | null;
  appId?: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface KeyRow {
  id: string;
  userId: string;
  instanceId: string | null;
  status: "valid" | "revoked" | "expired";
}

const store = {
  clients: new Map<string, Record<string, unknown>>(),
  codes: new Map<string, CodeRow>(),
  users: new Map<
    string,
    { id: string; userType: string; agentType?: string | null }
  >(),
  /** trusted_issuers rows, as `TrustedIssuerService.list()` returns them. */
  issuers: [] as Array<{
    issuerUrl: string;
    status: string;
    allowedScopes: string[];
  }>,
  /** api_keys by PLAINTEXT, as `apiKeyService.getApiKeyStatus` resolves them. */
  keys: new Map<string, KeyRow>(),
  /** Make the registry read FAIL (a DB fault), to prove it is not swallowed. */
  issuersFail: false,
  /** Cached metadata documents, by client_id URL (see the client-metadata mock). */
  cimd: new Map<string, Record<string, unknown>>(),
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

vi.mock("@synap/database", async () => {
  // The REAL Control Plane scope set — the resolver must match it exactly, so a
  // hand-copied list here would let the two drift without a red test.
  const schema = await vi.importActual<typeof import("@synap/database/schema")>(
    "@synap/database/schema"
  );
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
                    resource: row.resource ?? null,
                    appId: row.appId ?? null,
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
    // The consent decision refuses any request that entered a key door.
    getActingAgentUserId: () => undefined,
    getRequestGrant: () => undefined,
    and: (...args: unknown[]) => ({ _and: args }),
    eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
    isNull: (a: unknown) => ({ _isNull: a }),
    gt: (a: unknown, b: unknown) => ({ _gt: [a, b] }),
    CONTROL_PLANE_ISSUER_SCOPES: schema.CONTROL_PLANE_ISSUER_SCOPES,
    TrustedIssuerService: class {
      list() {
        return store.issuersFail
          ? Promise.reject(new Error("registry read failed"))
          : Promise.resolve(store.issuers);
      }
    },
  };
});

// The key service /revoke reads and revokes through. Backed by `store.keys`
// so a revoke is OBSERVABLE (the key's status flips), not merely a spy call.
const revokeSpy = vi.fn();
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (plaintext: string) => {
      const row = store.keys.get(plaintext);
      if (!row) return Promise.resolve({ status: "not_found" });
      return Promise.resolve({ status: row.status, record: row });
    },
    revokeApiKey: (keyId: string, revokedBy: string, reason?: string) => {
      revokeSpy(keyId, revokedBy, reason);
      for (const row of store.keys.values()) {
        if (row.id === keyId) row.status = "revoked";
      }
      return Promise.resolve();
    },
  },
}));

// The ONE key-minting door. Captured so we can assert exactly what /token asks
// for — this spy is where the linkedUserId contract is proven.
const provisionSpy = vi.fn();
vi.mock("../../services/agent-identity-service.js", () => ({
  provisionSurfaceAgentKey: (opts: unknown) => provisionSpy(opts),
}));

// Pod apps (PB2): consent files + approves the app's request and /token mints
// its own agent's key through App Connect. Both run for real on PGlite in
// services/pod-app.invariants.pglite.test.ts; here they are spies, so this file
// pins what the HTTP door asks of them and hands back.
const appConnect = vi.hoisted(() => ({
  connect: vi.fn(),
  mint: vi.fn(),
  reuse: vi.fn(),
  isPodAppAgent: vi.fn(),
}));
vi.mock("../../services/app-connect.js", () => ({
  connectOAuthApp: (args: unknown) => appConnect.connect(args),
  mintAppOAuthAccessKey: (args: unknown) => appConnect.mint(args),
  reuseAppOAuthAccessKey: (args: unknown) => appConnect.reuse(args),
  isPodAppAgent: (id: string) => appConnect.isPodAppAgent(id),
  oauthAppOffer: async (_user: string, permissions: string[]) =>
    permissions.map((permission) => ({ permission, workspaces: [] })),
  currentOAuthApproval: async () => [],
}));

// Pod app refresh tokens (PB3). The store runs for real on PGlite in
// services/oauth-refresh.pglite.test.ts; here it is spies, so this file pins
// what the HTTP door asks of it, and that an MCP (DCR) client never reaches it.
const refresh = vi.hoisted(() => ({
  start: vi.fn(),
  redeem: vi.fn(),
  rotate: vi.fn(),
  find: vi.fn(),
  revokeFamily: vi.fn(),
  confirmGrace: vi.fn(),
}));
vi.mock("./refresh.js", async () => {
  const { OAuthError } =
    await vi.importActual<typeof import("./protocol.js")>("./protocol.js");
  class RefreshTokenReuseError extends OAuthError {
    constructor(public readonly familyId: string) {
      super("invalid_grant", "Invalid, expired, or revoked refresh token");
    }
  }
  return {
    RefreshTokenReuseError,
    startRefreshFamily: (c: unknown) => refresh.start(c),
    redeemRefreshToken: (raw: string, clientId: string) =>
      refresh.redeem(raw, clientId),
    rotateRefreshToken: (prev: unknown, id: string) => refresh.rotate(prev, id),
    // PB3b: the key a successor re-derives (refresh.ts derives it by HMAC).
    successorAccessToken: (id: string) => `derived-key:${id}`,
    confirmGraceSuccessor: (r: unknown) => refresh.confirmGrace(r),
    findRefreshToken: (raw: string) => refresh.find(raw),
    revokeRefreshFamily: (t: unknown, reason: string) =>
      refresh.revokeFamily(t, reason),
  };
});

// Pod app clients (CIMD). The fetch + cache is pinned in client-metadata.test.ts;
// here a document either resolves to `store.cimd` or is unreadable.
vi.mock("./client-metadata.js", async () => {
  const actual = await vi.importActual<typeof import("./client-metadata.js")>(
    "./client-metadata.js"
  );
  return {
    ...actual,
    resolveCimdClient: (clientId: string, issuer: string | null) => {
      // The real URL rules run first (length, https, canonical form…).
      try {
        actual.assertClientMetadataUrl(clientId, issuer);
      } catch (err) {
        return Promise.reject(err);
      }
      const row = store.cimd.get(clientId);
      return row
        ? Promise.resolve(row)
        : Promise.reject(
            new actual.ClientMetadataError("the document URL answered 404")
          );
    },
  };
});

// One shared logger so a test can assert what the routes WARNED about.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => log,
}));

// Import AFTER the mocks are registered.
import { oauthApp } from "./routes.js";
import { computeS256Challenge } from "./protocol.js";
import { decideOAuthAuthorization, getOAuthConsentContext } from "./consent.js";

const ISSUER = "https://pod.test.synap.live";
const POD_ADMIN = "https://pod-admin.test.synap.live";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "x".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
/** The `apps` row a pod app's consent approved (the connect spy's answer). */
const APP_ROW_ID = "22222222-2222-4222-8222-222222222222";
const APP_PUBLIC_ID = "app_33333333-3333-4333-8333-333333333333";
const SPACE_ID = "44444444-4444-4444-8444-444444444444";
/** A pod app's consent is an approval: the caller's request context. */
const HUMAN_CTX = { authenticated: true, userId: HUMAN_ID } as never;

beforeEach(() => {
  store.clients.clear();
  store.codes.clear();
  store.users.clear();
  store.issuers.length = 0;
  store.issuersFail = false;
  store.keys.clear();
  store.cimd.clear();
  log.warn.mockClear();
  revokeSpy.mockReset();
  claimWhere.length = 0;
  store.users.set(HUMAN_ID, { id: HUMAN_ID, userType: "human" });
  appConnect.connect.mockReset();
  appConnect.connect.mockResolvedValue({
    appId: APP_ROW_ID,
    publicId: APP_PUBLIC_ID,
    proposalId: "proposal-1",
  });
  appConnect.mint.mockReset();
  appConnect.reuse.mockReset();
  appConnect.isPodAppAgent.mockReset();
  appConnect.isPodAppAgent.mockResolvedValue(false);
  for (const spy of Object.values(refresh)) spy.mockReset();
  refresh.start.mockResolvedValue("RT-1");
  refresh.find.mockResolvedValue(null);
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
async function consentAndExtractCode(
  clientId: string,
  state?: string,
  redirectUri: string = CALLBACK
) {
  const { redirectTo } = await decideOAuthAuthorization(
    {
      clientId,
      redirectUri,
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

describe("consent context", () => {
  it("says when the client registered itself", async () => {
    const { body: client } = await register();
    const registeredAt = new Date("2026-10-17T09:00:00Z");
    store.clients.get(client.client_id)!.createdAt = registeredAt;
    const context = await getOAuthConsentContext(
      {
        clientId: client.client_id,
        redirectUri: CALLBACK,
        responseType: "code",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        state: null,
      },
      HUMAN_ID
    );
    expect(context).toMatchObject({
      appSignIn: null,
      clientName: "Claude",
      redirectHost: "claude.ai",
      registeredAt,
    });
  });
});

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

  // Flipped on purpose in PB3: this used `refresh_token`, which is now a
  // supported grant (pod apps only; a DCR client is refused it, below).
  it("rejects an unsupported grant_type", async () => {
    const { res, body } = await token({
      grant_type: "client_credentials",
      client_id: "whatever",
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

// ─── (g) CP connector vs direct client ───────────────────────────────────────

const CP_ORIGIN = "https://api.synap.live";
const CP_CALLBACK = `${CP_ORIGIN}/pods/pod-1/connect-mcp/callback`;

async function controlPlaneIssuerScopes(): Promise<string[]> {
  const schema = await vi.importActual<typeof import("@synap/database/schema")>(
    "@synap/database/schema"
  );
  return [...schema.CONTROL_PLANE_ISSUER_SCOPES];
}

/** DCR → consent → /token for one redirect_uri; returns the mint options. */
async function mintFor(redirectUri: string) {
  const { body: client } = await register({ redirect_uris: [redirectUri] });
  const { code } = await consentAndExtractCode(
    client.client_id,
    undefined,
    redirectUri
  );
  const result = await token({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_verifier: VERIFIER,
  });
  return { ...result, opts: provisionSpy.mock.calls[0]?.[0] };
}

describe("POST /token — agentType by redirect origin", () => {
  it("mints claude-web for a redirect on the APPROVED Control Plane's origin", async () => {
    store.issuers.push({
      issuerUrl: CP_ORIGIN,
      status: "approved",
      allowedScopes: await controlPlaneIssuerScopes(),
    });
    const { res, opts } = await mintFor(CP_CALLBACK);
    expect(res.status).toBe(200);
    expect(opts.agentType).toBe("claude-web");
    // The legacy door's labels, so the agent user reads the same either way.
    expect(opts.agentLabel).toBe("Claude (Web)");
    expect(opts.keyName).toBe("Claude Web Hub Key");
    expect(opts.linkedUserId).toBe(HUMAN_ID);
  });

  it("mints claude-web-direct when the Control Plane is only PENDING", async () => {
    store.issuers.push({
      issuerUrl: CP_ORIGIN,
      status: "pending",
      allowedScopes: await controlPlaneIssuerScopes(),
    });
    const { opts } = await mintFor(CP_CALLBACK);
    expect(opts.agentType).toBe("claude-web-direct");
  });

  it("mints claude-web-direct for an approved issuer WITHOUT the Control Plane scopes", async () => {
    // A third-party application issuer is approved with no issuer-wide scope.
    store.issuers.push({
      issuerUrl: CP_ORIGIN,
      status: "approved",
      allowedScopes: [],
    });
    const { opts } = await mintFor(CP_CALLBACK);
    expect(opts.agentType).toBe("claude-web-direct");
  });

  it("mints claude-web-direct for an https look-alike of the CP origin", async () => {
    store.issuers.push({
      issuerUrl: CP_ORIGIN,
      status: "approved",
      allowedScopes: await controlPlaneIssuerScopes(),
    });
    const { opts } = await mintFor(
      "https://api.synap.live.evil.example/pods/pod-1/connect-mcp/callback"
    );
    expect(opts.agentType).toBe("claude-web-direct");
    expect(opts.agentLabel).toBe("Claude (Web, direct)");
  });

  it("fails loudly (500) and mints nothing when the registry read FAILS", async () => {
    store.issuersFail = true;
    const { res, body } = await mintFor(CP_CALLBACK);
    expect(res.status).toBe(500);
    expect(body.error).toBe("server_error");
    expect(provisionSpy).not.toHaveBeenCalled();
  });
});

// ─── (h) RFC 7009 /revoke ────────────────────────────────────────────────────

const DIRECT_AGENT = "agent-direct";
const CP_AGENT = "agent-cp";
const OTHER_AGENT = "agent-raycast";

function seedKeys() {
  store.users.set(DIRECT_AGENT, {
    id: DIRECT_AGENT,
    userType: "agent",
    agentType: "claude-web-direct",
  });
  store.users.set(CP_AGENT, {
    id: CP_AGENT,
    userType: "agent",
    agentType: "claude-web",
  });
  store.users.set(OTHER_AGENT, {
    id: OTHER_AGENT,
    userType: "agent",
    agentType: "raycast",
  });
  store.keys.set("synap_direct", {
    id: "key-direct",
    userId: DIRECT_AGENT,
    instanceId: `oauth:client-a:${HUMAN_ID}`,
    status: "valid",
  });
  store.keys.set("synap_legacy_cp", {
    id: "key-legacy-cp",
    userId: CP_AGENT,
    instanceId: `mcp:cp-user:pod-1`,
    status: "valid",
  });
  store.keys.set("synap_human_pat", {
    id: "key-human",
    userId: HUMAN_ID,
    instanceId: null,
    status: "valid",
  });
  store.keys.set("synap_raycast", {
    id: "key-raycast",
    userId: OTHER_AGENT,
    instanceId: null,
    status: "valid",
  });
}

async function revoke(params: Record<string, string>) {
  return oauthApp.request("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

describe("POST /revoke (RFC 7009)", () => {
  beforeEach(seedKeys);

  it("is advertised in the AS metadata", async () => {
    const doc = (await (
      await oauthApp.request("/.well-known/oauth-authorization-server")
    ).json()) as any;
    expect(doc.revocation_endpoint).toBe(`${ISSUER}/revoke`);
  });

  it("revokes a claude-web-direct key presented by its holder", async () => {
    const res = await revoke({ token: "synap_direct", client_id: "client-a" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(revokeSpy).toHaveBeenCalledWith(
      "key-direct",
      DIRECT_AGENT,
      expect.any(String)
    );
    expect(store.keys.get("synap_direct")!.status).toBe("revoked");
  });

  it("revokes a LEGACY consent-code claude-web key on possession (no client binding)", async () => {
    const res = await revoke({
      token: "synap_legacy_cp",
      client_id: "the-cp-client",
    });
    expect(res.status).toBe(200);
    expect(store.keys.get("synap_legacy_cp")!.status).toBe("revoked");
  });

  it("does NOT revoke a human PAT presented here — 200, key still live", async () => {
    const res = await revoke({ token: "synap_human_pat" });
    expect(res.status).toBe(200);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(store.keys.get("synap_human_pat")!.status).toBe("valid");
  });

  it("does NOT revoke another agent's key (raycast) — 200, key still live", async () => {
    const res = await revoke({ token: "synap_raycast" });
    expect(res.status).toBe(200);
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(store.keys.get("synap_raycast")!.status).toBe("valid");
  });

  it("refuses a client the key was not issued to, and keeps the key", async () => {
    const res = await revoke({ token: "synap_direct", client_id: "client-b" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("unauthorized_client");
    expect(store.keys.get("synap_direct")!.status).toBe("valid");
  });

  it("answers 200 for an unknown or already-revoked token (no existence oracle)", async () => {
    expect((await revoke({ token: "synap_nope" })).status).toBe(200);
    store.keys.get("synap_direct")!.status = "revoked";
    expect((await revoke({ token: "synap_direct" })).status).toBe(200);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("400s when no token is presented", async () => {
    const res = await revoke({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_request");
  });
});

// ─── (i) RFC 9207 — `iss` on every authorization response (PB1, I7) ─────────

/** A cached app (CIMD) client, as client-metadata.ts would hand it back. */
const APP_ID = "https://studio.example.com/.well-known/synap-client.json";
const APP_CALLBACK = "https://studio.example.com/api/synap/callback";
function cacheApp(overrides: Record<string, unknown> = {}) {
  store.cimd.set(APP_ID, {
    clientId: APP_ID,
    clientKind: "cimd",
    clientName: "Content Studio",
    redirectUris: [APP_CALLBACK],
    scopes: ["mcp.read"],
    requestedPermissions: ["entity.post.read", "entity.post.create"],
    createdAt: new Date(),
    ...overrides,
  });
}

function authorizeApp(params: Record<string, string> = {}) {
  return oauthApp.request(
    authorizeUrl({
      response_type: "code",
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      scope: "entity.post.read",
      state: "st-app",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      ...params,
    })
  );
}

describe("RFC 9207 — every authorization response carries iss", () => {
  it("advertises iss responses and CIMD client ids in the AS metadata", async () => {
    const doc = (await (
      await oauthApp.request("/.well-known/oauth-authorization-server")
    ).json()) as any;
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    expect(doc.client_id_metadata_document_supported).toBe(true);
    // DCR stays advertised for MCP clients (claude.ai registers through it).
    expect(doc.registration_endpoint).toBe(`${ISSUER}/register`);
  });

  it("on a phase-2 ERROR redirect from /authorize", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        state: "st-9",
      })
    );
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("invalid_request");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
  });

  it("on a DENY from the consent screen", async () => {
    const { body: client } = await register();
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: client.client_id,
        redirectUri: CALLBACK,
        responseType: "code",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        state: "st-d",
        approve: false,
      },
      HUMAN_ID
    );
    const back = new URL(redirectTo);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
  });

  it("on SUCCESS (the code redirect)", async () => {
    const { body: client } = await register();
    const { redirectTo } = await consentAndExtractCode(client.client_id, "s");
    const back = new URL(redirectTo);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("s");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
  });

  it("uses the CANONICAL issuer even when PUBLIC_URL has a trailing slash", async () => {
    process.env.PUBLIC_URL = `${ISSUER}/`;
    const { body: client } = await register();
    const { redirectTo } = await consentAndExtractCode(client.client_id);
    expect(new URL(redirectTo).searchParams.get("iss")).toBe(ISSUER);
  });

  it("a phase-1 error is still shown, never redirected (no iss to leak)", async () => {
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: "dcr_nope",
        redirect_uri: CALLBACK,
      })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

// ─── (j) RFC 8707 — the resource parameter (PB1) ─────────────────────────────
//
// STRICT for app (CIMD) clients; LENIENT for DCR clients (claude.ai, the CP
// connector) until claude.ai's real value is observed in the logs: an
// unrecognised resource from a DCR client is logged and treated as absent,
// never refused. A RECOGNISED resource is bound to the code for both kinds.

describe("RFC 8707 — resource", () => {
  /** /authorize for a DCR client (`dcr`) or the cached app client (`cimd`). */
  async function authorizeWith(
    kind: "dcr" | "cimd",
    resource: string | string[]
  ) {
    let clientId = APP_ID;
    let redirectUri = APP_CALLBACK;
    let scope = "entity.post.read";
    if (kind === "dcr") {
      const { body: client } = await register();
      clientId = client.client_id;
      redirectUri = CALLBACK;
      scope = "mcp.read";
    } else {
      cacheApp();
    }
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state: "st-r",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    for (const r of [resource].flat()) qs.append("resource", r);
    return {
      res: await oauthApp.request(`/authorize?${qs.toString()}`),
      clientId,
      redirectUri,
    };
  }

  it("accepts this pod's /mcp and forwards it to the consent screen", async () => {
    const { res } = await authorizeWith("dcr", `${ISSUER}/mcp`);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe(POD_ADMIN);
    expect(target.searchParams.get("resource")).toBe(`${ISSUER}/mcp`);
  });

  it("accepts this pod's /api/hub, a trailing slash dropped", async () => {
    const { res } = await authorizeWith("cimd", `${ISSUER}/api/hub/`);
    const target = new URL(res.headers.get("location")!);
    expect(target.searchParams.get("resource")).toBe(`${ISSUER}/api/hub`);
  });

  const FOREIGN = [
    "https://claude.ai/whatever",
    "https://other-pod.synap.live/mcp",
    `${ISSUER}/admin`,
    ISSUER,
    "",
  ];

  for (const foreign of FOREIGN) {
    it(`CIMD: refuses resource=${JSON.stringify(foreign)} with invalid_target (redirected, with iss)`, async () => {
      const { res } = await authorizeWith("cimd", foreign);
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get("location")!);
      expect(back.origin + back.pathname).toBe(APP_CALLBACK);
      expect(back.searchParams.get("error")).toBe("invalid_target");
      expect(back.searchParams.get("iss")).toBe(ISSUER);
    });

    it(`DCR: resource=${JSON.stringify(foreign)} is logged and treated as absent, never refused`, async () => {
      const { res, clientId } = await authorizeWith("dcr", foreign);
      const target = new URL(res.headers.get("location")!);
      expect(target.origin).toBe(POD_ADMIN);
      expect(target.searchParams.has("resource")).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ clientId, resource: foreign }),
        expect.stringMatching(/unrecognised resource/)
      );
    });
  }

  it("CIMD: refuses a repeated resource parameter", async () => {
    const { res } = await authorizeWith("cimd", [
      `${ISSUER}/mcp`,
      `${ISSUER}/api/hub`,
    ]);
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("invalid_target");
  });

  it("DCR: a repeated resource parameter is logged and treated as absent", async () => {
    const { res } = await authorizeWith("dcr", [
      `${ISSUER}/mcp`,
      `${ISSUER}/api/hub`,
    ]);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe(POD_ADMIN);
    expect(target.searchParams.has("resource")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  async function dcrCodeFor(resource?: string) {
    const { body: client } = await register();
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: client.client_id,
        redirectUri: CALLBACK,
        responseType: "code",
        scope: "mcp.read mcp.write",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        resource,
        approve: true,
      },
      HUMAN_ID
    );
    return {
      clientId: client.client_id as string,
      code: new URL(redirectTo).searchParams.get("code")!,
    };
  }

  it("binds the canonical resource to the code", async () => {
    await dcrCodeFor(`${ISSUER}/mcp/`);
    const [row] = [...store.codes.values()];
    expect(row!.resource).toBe(`${ISSUER}/mcp`);
  });

  it("DCR end to end: an unrecognised resource → authorize, code and token all issued, unbound, warned", async () => {
    const odd = "https://claude.ai/whatever";
    const { res: authRes, clientId } = await authorizeWith("dcr", odd);
    expect(new URL(authRes.headers.get("location")!).origin).toBe(POD_ADMIN);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId, resource: odd }),
      expect.stringMatching(/unrecognised resource/)
    );

    // The consent screen round-trips the same value; it is dropped again.
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId,
        redirectUri: CALLBACK,
        responseType: "code",
        scope: "mcp.read",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        resource: odd,
        approve: true,
      },
      HUMAN_ID
    );
    const code = new URL(redirectTo).searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect([...store.codes.values()][0]!.resource ?? null).toBeNull();

    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      resource: odd,
    });
    expect(res.status).toBe(200);
    expect(body.access_token).toBeTruthy();
  });

  it("CIMD: the consent decision re-validates resource (a tampered round-trip is refused)", async () => {
    cacheApp();
    await expect(
      decideOAuthAuthorization(
        {
          clientId: APP_ID,
          redirectUri: APP_CALLBACK,
          responseType: "code",
          scope: "entity.post.read",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          resource: "https://evil.example/mcp",
          approve: true,
        },
        HUMAN_ID
      )
    ).rejects.toMatchObject({ code: "invalid_target" });
    expect(store.codes.size).toBe(0);
  });

  it("DCR: a code bound to /mcp refuses a DIFFERENT recognised resource at /token, and mints nothing", async () => {
    const { clientId, code } = await dcrCodeFor(`${ISSUER}/mcp`);
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      resource: `${ISSUER}/api/hub`,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_target");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("DCR: a code bound to /mcp refuses a FOREIGN resource at /token (the binding holds)", async () => {
    const { clientId, code } = await dcrCodeFor(`${ISSUER}/mcp`);
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      resource: "https://claude.ai/whatever",
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_target");
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("CIMD: /token refuses a foreign resource even when the code named none", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: APP_ID,
        redirectUri: APP_CALLBACK,
        responseType: "code",
        scope: "entity.post.read",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        approve: true,
        approved: [{ permission: "entity.post.read", workspaceId: SPACE_ID }],
      },
      HUMAN_ID,
      HUMAN_CTX
    );
    const { res, body } = await token({
      grant_type: "authorization_code",
      code: new URL(redirectTo).searchParams.get("code")!,
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      code_verifier: VERIFIER,
      resource: "https://other-pod.synap.live/mcp",
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_target");
  });

  it("/token accepts the matching resource", async () => {
    const { clientId, code } = await dcrCodeFor(`${ISSUER}/mcp`);
    const { res } = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      resource: `${ISSUER}/mcp`,
    });
    expect(res.status).toBe(200);
  });

  it("a missing resource stays accepted for both kinds", async () => {
    const dcr = await authorizeWith("dcr", []);
    expect(new URL(dcr.res.headers.get("location")!).origin).toBe(POD_ADMIN);
    const app = await authorizeWith("cimd", []);
    expect(new URL(app.res.headers.get("location")!).origin).toBe(POD_ADMIN);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

// ─── (k) Pod app clients — CIMD at /authorize, consent and /token (PB1) ──────

describe("CIMD clients", () => {
  it("a cached app client reaches the consent screen with its declared scopes", async () => {
    cacheApp();
    const res = await authorizeApp({
      scope: "entity.post.read entity.post.delete mcp.read",
    });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe(POD_ADMIN);
    expect(target.searchParams.get("client_id")).toBe(APP_ID);
    // entity.post.delete is not declared in the document: dropped.
    expect(target.searchParams.get("scope")).toBe("entity.post.read mcp.read");
  });

  it("a redirect_uri the document does not list is shown to the user, never redirected", async () => {
    cacheApp();
    const res = await authorizeApp({
      redirect_uri: "https://studio.example.com/other",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("an unreadable document is shown to the user, never redirected", async () => {
    const res = await authorizeApp();
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toMatch(/could not be read/);
  });

  it("asking for nothing it declared is invalid_scope (never a fallback), with iss", async () => {
    cacheApp();
    const res = await authorizeApp({ scope: "entity.task.delete" });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(APP_CALLBACK);
    expect(back.searchParams.get("error")).toBe("invalid_scope");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
  });

  it("an app that names no scope at all gets invalid_scope too", async () => {
    cacheApp();
    const res = await authorizeApp({ scope: "" });
    expect(
      new URL(res.headers.get("location")!).searchParams.get("error")
    ).toBe("invalid_scope");
  });

  it("DCR regression: an MCP client's unknown scope still falls back to its registered set", async () => {
    const { body: client } = await register();
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: CALLBACK,
        scope: "entity.post.read",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    const target = new URL(res.headers.get("location")!);
    expect(target.origin).toBe(POD_ADMIN);
    expect(target.searchParams.get("scope")).toBe("mcp.read mcp.write");
  });

  it("I2: a DCR client asking for app permissions is granted none of them", async () => {
    const { body: client } = await register({
      scope: "mcp.read entity.post.read document.update",
    });
    expect(client.scope).toBe("mcp.read");
  });

  it("the consent decision issues a code to the app's own redirect_uri, with iss", async () => {
    cacheApp();
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: APP_ID,
        redirectUri: APP_CALLBACK,
        responseType: "code",
        scope: "entity.post.read",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        state: "st-app",
        approve: true,
        approved: [{ permission: "entity.post.read", workspaceId: SPACE_ID }],
      },
      HUMAN_ID,
      HUMAN_CTX
    );
    const back = new URL(redirectTo);
    expect(back.origin + back.pathname).toBe(APP_CALLBACK);
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    const [row] = [...store.codes.values()];
    expect(row).toMatchObject({
      clientId: APP_ID,
      scopes: ["entity.post.read"],
    });
  });

  /** A pod app consents and gets a code (the connect spy approves it). */
  async function appCode(scope = "entity.post.read") {
    cacheApp();
    // /token re-reads the client from oauth_clients (the cache row).
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const { redirectTo } = await decideOAuthAuthorization(
      {
        clientId: APP_ID,
        redirectUri: APP_CALLBACK,
        responseType: "code",
        scope,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        approve: true,
        approved: [{ permission: "entity.post.read", workspaceId: SPACE_ID }],
      },
      HUMAN_ID,
      HUMAN_CTX
    );
    return new URL(redirectTo).searchParams.get("code")!;
  }

  const APP_AGENT_ID = "55555555-5555-4555-8555-555555555555";
  function mintAnswers() {
    appConnect.mint.mockResolvedValue({
      accessToken: "synap_hub_live_APPKEY",
      keyId: "app-key-1",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      agentUserId: APP_AGENT_ID,
      publicId: APP_PUBLIC_ID,
      grant: [
        {
          permission: "entity.post.read",
          workspaceId: SPACE_ID,
          workspaceName: "Brand",
        },
      ],
      user: { id: HUMAN_ID, name: "Ada" },
    });
  }

  // Flipped on purpose in PB2 (was: /token refuses a CIMD code with
  // unauthorized_client). A CIMD code now mints — through the app's OWN agent
  // (mintAppOAuthAccessKey), never the shared claude-web* door.
  it("TRIPWIRE I3: a CIMD client's key is its own app agent's, never a claude-web* key", async () => {
    const code = await appCode("mcp.read entity.post.read");
    mintAnswers();
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(200);
    expect(body.access_token).toBe("synap_hub_live_APPKEY");
    // The shared MCP door (claude-web / claude-web-direct) is never reached.
    expect(provisionSpy).not.toHaveBeenCalled();
    // The app's own door, for THIS person's approved connection and slot.
    expect(appConnect.mint).toHaveBeenCalledTimes(1);
    expect(appConnect.mint).toHaveBeenCalledWith({
      appId: APP_ROW_ID,
      ownerUserId: HUMAN_ID,
      oauthClientId: APP_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
    });
    // An app gets what it was approved, never mcp.* (I2).
    expect(body.scope).toBe("entity.post.read");
    expect(body.scope).not.toMatch(/mcp/);
  });

  it("consent files and approves the app's request BEFORE a code exists, and binds the code to it", async () => {
    await appCode();
    expect(appConnect.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: HUMAN_ID,
        oauthClientId: APP_ID,
        name: "Content Studio (studio.example.com)",
        // What the app asked for AND declared — never mcp.*.
        permissions: ["entity.post.read"],
        approved: [{ permission: "entity.post.read", workspaceId: SPACE_ID }],
        ctx: HUMAN_CTX,
      })
    );
    const [row] = [...store.codes.values()];
    expect(row).toMatchObject({
      appId: APP_ROW_ID,
      scopes: ["entity.post.read"],
    });
  });

  it("a refused consent (widened, agent caller…) issues no code", async () => {
    cacheApp();
    appConnect.connect.mockRejectedValue(
      Object.assign(new Error("not on offer"), { code: "FORBIDDEN" })
    );
    await expect(
      decideOAuthAuthorization(
        {
          clientId: APP_ID,
          redirectUri: APP_CALLBACK,
          responseType: "code",
          scope: "entity.post.read",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          approve: true,
          approved: [
            { permission: "entity.post.create", workspaceId: SPACE_ID },
          ],
        },
        HUMAN_ID,
        HUMAN_CTX
      )
    ).rejects.toThrow(/not on offer/);
    expect(store.codes.size).toBe(0);
  });

  it("the token response carries the Synap grant and user (spec 17 §6.6), 1 h, no-store", async () => {
    const code = await appCode();
    mintAnswers();
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(3590);
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    expect(body.synap_grant).toEqual([
      {
        permission: "entity.post.read",
        workspaceId: SPACE_ID,
        workspaceName: "Brand",
      },
    ]);
    expect(body.synap_user).toEqual({ id: HUMAN_ID, name: "Ada" });
    // Flipped on purpose in PB3 (was: no refresh_token): a pod app's code
    // starts a refresh family for its connection.
    expect(body.refresh_token).toBe("RT-1");
    expect(refresh.start).toHaveBeenCalledWith({
      clientId: APP_ID,
      userId: HUMAN_ID,
      appId: APP_ROW_ID,
    });
  });

  it("a connection revoked (or narrowed to nothing) since consent: invalid_grant, no key", async () => {
    const code = await appCode();
    const { TRPCError } = await import("@trpc/server");
    appConnect.mint.mockRejectedValue(
      new TRPCError({
        code: "CONFLICT",
        message: "This app's connection was revoked.",
      })
    );
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body).not.toHaveProperty("access_token");
  });

  it("a CIMD code that names no approved app redeems to nothing", async () => {
    const code = await appCode();
    const [row] = [...store.codes.values()];
    row!.appId = null;
    const { res, body } = await token({
      grant_type: "authorization_code",
      code,
      client_id: APP_ID,
      redirect_uri: APP_CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(appConnect.mint).not.toHaveBeenCalled();
  });

  it("an app that asks only for mcp.* is refused at consent (a pod app gets no MCP access in v1)", async () => {
    cacheApp();
    await expect(
      decideOAuthAuthorization(
        {
          clientId: APP_ID,
          redirectUri: APP_CALLBACK,
          responseType: "code",
          scope: "mcp.read",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          approve: true,
          approved: [],
        },
        HUMAN_ID,
        HUMAN_CTX
      )
    ).rejects.toThrow(/asks for nothing a pod app can be given/);
    expect(appConnect.connect).not.toHaveBeenCalled();
    expect(store.codes.size).toBe(0);
  });

  it("/revoke retires a pod app's key (its holder is a pod app agent)", async () => {
    store.users.set(APP_AGENT_ID, {
      id: APP_AGENT_ID,
      userType: "agent",
      agentType: APP_PUBLIC_ID,
    });
    store.keys.set("synap_hub_live_APPKEY", {
      id: "app-key-1",
      userId: APP_AGENT_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
      status: "valid",
    });
    appConnect.isPodAppAgent.mockResolvedValue(true);
    const res = await oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "synap_hub_live_APPKEY",
        client_id: APP_ID,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect(appConnect.isPodAppAgent).toHaveBeenCalledWith(APP_AGENT_ID);
    expect(store.keys.get("synap_hub_live_APPKEY")!.status).toBe("revoked");
  });

  it("/revoke still ignores an agent key that is neither claude-web* nor a pod app's", async () => {
    store.users.set("other-agent", {
      id: "other-agent",
      userType: "agent",
      agentType: "claude-code",
    });
    store.keys.set("synap_hub_live_OTHER", {
      id: "other-key",
      userId: "other-agent",
      instanceId: null,
      status: "valid",
    });
    const res = await oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "synap_hub_live_OTHER" }).toString(),
    });
    expect(res.status).toBe(200);
    expect(store.keys.get("synap_hub_live_OTHER")!.status).toBe("valid");
  });

  it("the consent context shows a pod app by its domain, unverified, with the spaces on offer", async () => {
    cacheApp({ requestedTemplates: ["content-studio"] });
    const context = await getOAuthConsentContext(
      {
        clientId: APP_ID,
        redirectUri: APP_CALLBACK,
        responseType: "code",
        scope: "entity.post.read mcp.read",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      },
      HUMAN_ID
    );
    expect(context.clientKind).toBe("cimd");
    expect(context.app).toMatchObject({
      domain: "studio.example.com",
      verified: false,
      permissions: [{ permission: "entity.post.read", workspaces: [] }],
      templates: ["content-studio"],
      ignoredScopes: ["mcp.read"],
    });
  });

  it("a Synap app (exact https://<id>.synap.live origin) is shown verified; a look-alike is not", async () => {
    const synap =
      "https://content-studio.synap.live/.well-known/synap-client.json";
    const lookalike =
      "https://content-studio.synap.live.evil.example/.well-known/synap-client.json";
    for (const [id, verified] of [
      [synap, true],
      [lookalike, false],
    ] as const) {
      const callback = `${new URL(id).origin}/cb`;
      store.cimd.set(id, {
        ...store.cimd.get(APP_ID),
        clientId: id,
        clientKind: "cimd",
        clientName: "Content Studio",
        redirectUris: [callback],
        scopes: [],
        requestedPermissions: ["entity.post.read"],
        createdAt: new Date(),
      });
      const context = await getOAuthConsentContext(
        {
          clientId: id,
          redirectUri: callback,
          responseType: "code",
          scope: "entity.post.read",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
        },
        HUMAN_ID
      );
      expect(context.app?.verified).toBe(verified);
    }
  });

  it("a DCR client's consent context has no app section (MCP consent unchanged)", async () => {
    const { body: client } = await register();
    const context = await getOAuthConsentContext(
      {
        clientId: client.client_id,
        redirectUri: CALLBACK,
        responseType: "code",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
      },
      HUMAN_ID
    );
    expect(context.clientKind).toBe("dcr");
    expect(context.app).toBeNull();
    expect(appConnect.connect).not.toHaveBeenCalled();
  });

  it("validation stays bounded: a 513-char client_id is refused at /authorize, a 512-char one is not", async () => {
    const url = (n: number) => {
      const base = "https://studio.example.com/";
      return base + "a".repeat(n - base.length);
    };
    const long = await authorizeApp({ client_id: url(513) });
    expect(long.status).toBe(400);
    expect(long.headers.get("location")).toBeNull();
    expect(await long.text()).toMatch(/longer than 512/);

    const max = url(512);
    cacheApp();
    store.cimd.set(max, { ...store.cimd.get(APP_ID)!, clientId: max });
    const ok = await authorizeApp({ client_id: max });
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get("location")!).origin).toBe(POD_ADMIN);
  });

  it("a DCR-shaped client_id never resolves to a cached document's row", async () => {
    store.clients.set("dcr_squat", {
      clientId: "dcr_squat",
      clientKind: "cimd",
      clientName: "x",
      redirectUris: [CALLBACK],
      scopes: ["mcp.read"],
      requestedPermissions: [],
      createdAt: new Date(),
    });
    const res = await oauthApp.request(
      authorizeUrl({
        response_type: "code",
        client_id: "dcr_squat",
        redirect_uri: CALLBACK,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  // ─── PB3 — refresh tokens (pod apps only) ──────────────────────────────────

  const REDEEMED = {
    id: "rt-row-1",
    familyId: "family-1",
    clientId: APP_ID,
    userId: HUMAN_ID,
    appId: APP_ROW_ID,
  };
  const refreshGrant = (extra: Record<string, string> = {}) =>
    token({
      grant_type: "refresh_token",
      refresh_token: "RT-1",
      client_id: APP_ID,
      ...extra,
    });

  it("refresh: redeems the token, mints from the connection's approval, rotates, same response shape", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    refresh.redeem.mockResolvedValue(REDEEMED);
    refresh.rotate.mockResolvedValue("RT-2");
    mintAnswers();
    const { res, body } = await refreshGrant({ scope: "entity.post.delete" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(refresh.redeem).toHaveBeenCalledWith("RT-1", APP_ID);
    // PB3b: the key is the one the successor re-derives (the reuse grace).
    const [[minted]] = appConnect.mint.mock.calls;
    expect(minted).toEqual({
      appId: APP_ROW_ID,
      ownerUserId: HUMAN_ID,
      oauthClientId: APP_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
      plainKey: expect.stringMatching(/^derived-key:/),
    });
    const successorId = minted.plainKey.slice("derived-key:".length);
    expect(refresh.rotate).toHaveBeenCalledWith(REDEEMED, successorId);
    expect(body).toMatchObject({
      access_token: "synap_hub_live_APPKEY",
      token_type: "Bearer",
      refresh_token: "RT-2",
      // The approval, never the request's `scope`.
      scope: "entity.post.read",
      synap_user: { id: HUMAN_ID, name: "Ada" },
    });
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it("refresh: a token the store refuses (unknown, reused, expired) mints nothing", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const { OAuthError } = await import("./protocol.js");
    refresh.redeem.mockRejectedValue(
      new OAuthError(
        "invalid_grant",
        "Invalid, expired, or revoked refresh token"
      )
    );
    const { res, body } = await refreshGrant();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(appConnect.mint).not.toHaveBeenCalled();
    expect(refresh.rotate).not.toHaveBeenCalled();
  });

  it("refresh: a connection revoked (or narrowed to nothing) since is invalid_grant, no successor", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    refresh.redeem.mockResolvedValue(REDEEMED);
    const { TRPCError } = await import("@trpc/server");
    appConnect.mint.mockRejectedValue(
      new TRPCError({
        code: "CONFLICT",
        message: "This app has nothing approved.",
      })
    );
    const { res, body } = await refreshGrant();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(refresh.rotate).not.toHaveBeenCalled();
  });

  it("refresh within the reuse grace (PB3b): the live key handed back, the successor answered, nothing minted or rotated", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const grace = { successorId: "rt-row-2", refreshToken: "RT-2" };
    refresh.redeem.mockResolvedValue({ ...REDEEMED, grace });
    refresh.confirmGrace.mockResolvedValue(undefined);
    // The same answer a mint gives, handed back by the reuse door instead.
    mintAnswers();
    appConnect.reuse.mockImplementation(
      appConnect.mint.getMockImplementation()!
    );
    const { res, body } = await refreshGrant();
    expect(res.status).toBe(200);
    expect(appConnect.reuse).toHaveBeenCalledWith({
      appId: APP_ROW_ID,
      ownerUserId: HUMAN_ID,
      oauthClientId: APP_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
      accessToken: "derived-key:rt-row-2",
    });
    expect(appConnect.mint).not.toHaveBeenCalled();
    expect(refresh.rotate).not.toHaveBeenCalled();
    expect(refresh.confirmGrace).toHaveBeenCalledWith({ ...REDEEMED, grace });
    expect(body).toMatchObject({
      access_token: "synap_hub_live_APPKEY",
      refresh_token: "RT-2",
    });
  });

  it("refresh within the reuse grace, the live key not reusable: one is minted (random, same slot), not rotated", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const grace = { successorId: "rt-row-2", refreshToken: "RT-2" };
    refresh.redeem.mockResolvedValue({ ...REDEEMED, grace });
    refresh.confirmGrace.mockResolvedValue(undefined);
    appConnect.reuse.mockResolvedValue(null);
    mintAnswers();
    const { res, body } = await refreshGrant();
    expect(res.status).toBe(200);
    expect(appConnect.mint).toHaveBeenCalledWith({
      appId: APP_ROW_ID,
      ownerUserId: HUMAN_ID,
      oauthClientId: APP_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
    });
    expect(refresh.rotate).not.toHaveBeenCalled();
    expect(body.refresh_token).toBe("RT-2");
  });

  it("refresh within the reuse grace, the successor spent meanwhile: invalid_grant", async () => {
    cacheApp();
    store.clients.set(APP_ID, store.cimd.get(APP_ID)!);
    const grace = { successorId: "rt-row-2", refreshToken: "RT-2" };
    refresh.redeem.mockResolvedValue({ ...REDEEMED, grace });
    appConnect.reuse.mockResolvedValue(null);
    mintAnswers();
    const { OAuthError } = await import("./protocol.js");
    refresh.confirmGrace.mockRejectedValue(
      new OAuthError(
        "invalid_grant",
        "Invalid, expired, or revoked refresh token"
      )
    );
    const { res, body } = await refreshGrant();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body).not.toHaveProperty("refresh_token");
  });

  it("refresh: an MCP (DCR) client is unauthorized_client and never reaches the store", async () => {
    const { body: client } = await register();
    const { res, body } = await refreshGrant({ client_id: client.client_id });
    expect(res.status).toBe(400);
    expect(body.error).toBe("unauthorized_client");
    expect(refresh.redeem).not.toHaveBeenCalled();
  });

  it("refresh: an unknown client is invalid_client (401); a missing token or client is invalid_request", async () => {
    const unknown = await refreshGrant({
      client_id: "https://nope.example/c.json",
    });
    expect(unknown.res.status).toBe(401);
    expect(unknown.body.error).toBe("invalid_client");
    const noToken = await token({
      grant_type: "refresh_token",
      client_id: APP_ID,
    });
    expect(noToken.body.error).toBe("invalid_request");
    const noClient = await token({
      grant_type: "refresh_token",
      refresh_token: "RT-1",
    });
    expect(noClient.body.error).toBe("invalid_request");
    expect(refresh.redeem).not.toHaveBeenCalled();
  });

  it("an MCP (DCR) code exchange still answers no refresh_token and starts no family", async () => {
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
    expect(body).not.toHaveProperty("refresh_token");
    expect(refresh.start).not.toHaveBeenCalled();
  });

  const REFRESH_ROW = {
    familyId: "family-1",
    clientId: APP_ID,
    userId: HUMAN_ID,
    appId: APP_ROW_ID,
  };
  const revokeToken = (params: Record<string, string>) =>
    oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });

  it("/revoke with token_type_hint=refresh_token revokes the token's family", async () => {
    refresh.find.mockResolvedValue(REFRESH_ROW);
    const res = await revokeToken({
      token: "RT-1",
      token_type_hint: "refresh_token",
      client_id: APP_ID,
    });
    expect(res.status).toBe(200);
    expect(refresh.find).toHaveBeenCalledWith("RT-1");
    expect(refresh.revokeFamily).toHaveBeenCalledWith(
      REFRESH_ROW,
      expect.any(String)
    );
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("/revoke of a refresh token WITHOUT a hint: the key lookup misses, the refresh lookup revokes it", async () => {
    refresh.find.mockResolvedValue(REFRESH_ROW);
    const res = await revokeToken({ token: "RT-1" });
    expect(res.status).toBe(200);
    expect(refresh.revokeFamily).toHaveBeenCalledTimes(1);
  });

  it("/revoke of a refresh token by another client: 400 unauthorized_client, the family kept", async () => {
    refresh.find.mockResolvedValue(REFRESH_ROW);
    for (const hint of ["refresh_token", "access_token"]) {
      const res = await revokeToken({
        token: "RT-1",
        token_type_hint: hint,
        client_id: "https://other.example.com/c.json",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe("unauthorized_client");
    }
    expect(refresh.revokeFamily).not.toHaveBeenCalled();
  });

  it("/revoke hinted refresh_token but holding an ACCESS key still retires the key (the hint only orders)", async () => {
    store.users.set(APP_AGENT_ID, {
      id: APP_AGENT_ID,
      userType: "agent",
      agentType: APP_PUBLIC_ID,
    });
    store.keys.set("synap_hub_live_APPKEY", {
      id: "app-key-1",
      userId: APP_AGENT_ID,
      instanceId: `oauth:${APP_ID}:${HUMAN_ID}`,
      status: "valid",
    });
    appConnect.isPodAppAgent.mockResolvedValue(true);
    const res = await revokeToken({
      token: "synap_hub_live_APPKEY",
      token_type_hint: "refresh_token",
    });
    expect(res.status).toBe(200);
    expect(store.keys.get("synap_hub_live_APPKEY")!.status).toBe("revoked");
  });
});
