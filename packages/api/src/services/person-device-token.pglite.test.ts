/**
 * A Synap app signs a person in on a device — end to end
 * on PGlite through the REAL doors:
 *
 *   `GET /authorize` (oauthApp) → `decideOAuthAuthorization` (the consent
 *   screen's service) → `POST /token` (oauthApp → `signInPersonDevice`, the one
 *   mint door) → the token on the REAL app session gate
 *   (`appSessionMiddleware` → `resolvePersonDeviceSession`) → the REAL tRPC
 *   context (`createContext`) and the REAL `devices` procedures → refresh,
 *   revoke and the devices list; and the same token refused by the REAL agent
 *   doors (`mcpHttpApp`, `hubAuthMiddleware`).
 *
 * Rows that rule out a wrong rule:
 *  (a) /authorize: any loopback port is accepted, `localhost` is refused AND
 *      not redirected, a resource naming /mcp is refused; the sign-in hints
 *      reach the consent screen;
 *  (b) the token is the PERSON on /trpc (the device marked `current`), while
 *      the same person in a browser session sees it as another device;
 *  (c) /mcp (a write) and Hub REST answer 401 to it;
 *  (d) a reused refresh token ends the DEVICE, its live access token too;
 *  (e) the absolute cap is enforced — past it nothing refreshes or
 *      authenticates, and near it nothing is minted past it;
 *  (f) signing out (devices.revoke, /revoke with either token) stops the
 *      device at once; another person's device is "not found";
 *  (g) a refresh token is bound to its client;
 *  (h) an agent cannot sign in as a device;
 *  (l) every way a person loses access ends their devices — removed
 *      from the pod (the account kept, or deleted with its identity),
 *      unlinked from an issuer, the Kratos identity disabled or deleted —
 *      and a person with no access gets none; removal from one space while
 *      another remains does not.
 *
 * Mocked: audit log (a recorder on the postgres-js client), the guest check
 * (a constant answer), the Kratos half of the session gate (a stand-in that
 * knows one browser cookie), the Kratos admin API (a map of identity
 * states), the event log, and the integration connections removal.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const unlink = actual.unlinkFederatedIdentity as (
    input: unknown,
    conn?: unknown
  ) => Promise<unknown>;
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    // The event log (realtime fan-out) is not under test; membership
    // removals append to it.
    eventRepository: { append: async (event: unknown) => event },
    // Its default executor is the package's own pool, not this database.
    unlinkFederatedIdentity: (input: unknown, conn?: unknown) =>
      unlink(input, conn ?? h.db),
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
// Kratos admin: each identity answers active unless a test says otherwise
// ("gone" = 404, "down" = Kratos unreachable).
const kratos = vi.hoisted(() => ({
  identity: new Map<string, "active" | "inactive" | "gone" | "down">(),
  deleted: [] as string[],
}));
vi.mock("@synap/auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const fail = (status: number) =>
    Object.assign(new Error(`kratos ${status}`), { response: { status } });
  return {
    ...actual,
    kratosAdmin: {
      getIdentity: async ({ id }: { id: string }) => {
        const state = kratos.identity.get(id) ?? "active";
        if (state === "gone") throw fail(404);
        if (state === "down") throw fail(503);
        return { data: { id, state } };
      },
      deleteIdentity: async ({ id }: { id: string }) => {
        kratos.deleted.push(id);
        return {};
      },
      deleteIdentityCredentials: async () => ({}),
    },
  };
});
// The person's integration connections (outside the pod database): removing
// them can fail, which keeps the account (removeFromPod).
const connections = vi.hoisted(() => ({ failFor: new Set<string>() }));
vi.mock("./capabilities/capability-nango-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllUserConnections: async (userId: string) => {
    if (connections.failFor.has(userId)) {
      throw new Error("the connections service did not answer");
    }
  },
}));
vi.mock("../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: async () => false,
}));

import { Hono, type MiddlewareHandler } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { successorRefreshToken } from "../routers/oauth/refresh.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
  signAuthRequestTime,
  verifyAuthRequestTime,
} from "../routers/oauth/consent.js";
import { appSessionMiddleware } from "../middleware/app-session.js";
import {
  liveDeviceIds,
  revokePersonDevice,
} from "@synap/database/person-devices";
import { createContext } from "../context.js";
import { router } from "../trpc.js";
import { devicesRouter } from "../routers/devices.js";
import { apiKeysRouter } from "../routers/api-keys.js";
import { machinesRouter } from "../routers/machines.js";
import { secretsVaultRouter } from "../routers/secrets-vault.js";
import { workspacesRouter } from "../routers/workspaces.js";
import { webhooksRouter } from "../routers/webhooks.js";
import { inviteProcedures } from "../routers/workspaces/invites.js";
import { applicationConnectionsRouter } from "../routers/application-connections.js";
import {
  STEP_UP_REQUIRED,
  runAsDeviceSession,
} from "../utils/device-session.js";
import { applyVaultSecretGrant } from "./vault-secret-grant.js";
import { mcpHttpApp } from "../routers/mcp/http-handler.js";
import { hubAuthMiddleware } from "../routers/hub-protocol/_middleware/auth.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import {
  PERSON_DEVICE_ABSOLUTE_CAP_MS,
  PERSON_DEVICE_MAX_ACTIVE,
  signInPersonDevice,
} from "./person-device-token.js";

const ISSUER = "https://pod.test.synap.live";
const DESKTOP = "synap-desktop";
const RELAY = "synap-relay";
const LOOPBACK = "http://127.0.0.1:53111/oauth/callback";
const PERSON = "person-ada";
const OTHER = "person-bob";
const AGENT = "agent-claude";
// Losing access to the pod, "(l)": the pod owner removes or unlinks people.
const OWNER = "person-owner";
const CAROL = "person-carol";
const DAN = "person-dan";
const EVE = "person-eve";
const FRAN = "person-fran";
const GIL = "person-gil";
const NOBODY = "person-nobody";
const IVY = "person-ivy";
const HAL = "person-hal";
const WS_ADMIN = randomUUID();
const WS_TEAM = randomUUID();
const WS_BOBS = randomUUID();
const BROWSER_COOKIE = "ory_kratos_session=ada-browser";

const VERIFIER = "d".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const DAY_MS = 24 * 60 * 60 * 1000;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://admin.pod.test.synap.live";
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, name, user_type) values
       ($1, 'ada@x', 'Ada', 'human'), ($2, 'bob@x', 'Bob', 'human'),
       ($3, 'claude@agents', 'Claude', 'agent')`,
    [PERSON, OTHER, AGENT]
  );
  await q(
    `insert into users (id, email, name, user_type) values
       ($1, 'owner@x', 'Owner', 'human'), ($2, 'carol@x', 'Carol', 'human'),
       ($3, 'dan@x', 'Dan', 'human'), ($4, 'eve@x', 'Eve', 'human'),
       ($5, 'fran@x', 'Fran', 'human'), ($6, 'gil@x', 'Gil', 'human'),
       ($7, 'nobody@x', 'Nobody', 'human'), ($8, 'ivy@x', 'Ivy', 'human'),
       ($9, 'hal@x', 'Hal', 'human')`,
    [OWNER, CAROL, DAN, EVE, FRAN, GIL, NOBODY, IVY, HAL]
  );
  // Every person here holds access (a space); NOBODY holds none.
  await q(
    `insert into workspaces (id, name, owner_id, system_slug) values
       ($1, 'Pod admin', $4, 'pod-admin'), ($2, 'Team', $4, null),
       ($3, 'Bob''s space', $5, null)`,
    [WS_ADMIN, WS_TEAM, WS_BOBS, OWNER, OTHER]
  );
  const member = (ws: string, user: string, role: string) =>
    q(
      `insert into workspace_members (id, workspace_id, user_id, role)
         values (gen_random_uuid(), $1, $2, $3)`,
      [ws, user, role]
    );
  await member(WS_ADMIN, OWNER, "owner");
  await member(WS_TEAM, OWNER, "owner");
  for (const person of [PERSON, OTHER, CAROL, DAN, EVE, FRAN, GIL, IVY, HAL]) {
    await member(WS_TEAM, person, "editor");
  }
  await member(WS_BOBS, OTHER, "owner");
  await member(WS_BOBS, EVE, "editor");
}, 120_000);

// ─── The doors ───────────────────────────────────────────────────────────────

/** The Kratos half: one browser session (Ada's cookie), nothing else. */
const kratosStandIn: MiddlewareHandler = async (c, next) => {
  if ((c.req.header("cookie") ?? "") !== BROWSER_COOKIE) {
    return c.json({ error: "Invalid session" }, 401);
  }
  c.set("userId" as never, PERSON as never);
  c.set(
    "session" as never,
    {
      identity: { id: PERSON, traits: { email: "ada@x", name: "Ada" } },
      active: true,
    } as never
  );
  return next();
};

const appRouter = router({
  devices: devicesRouter,
  apiKeys: apiKeysRouter,
  machines: machinesRouter,
  secretsVault: secretsVaultRouter,
  workspaces: workspacesRouter,
  integrations: webhooksRouter,
});

function appApi() {
  const app = new Hono();
  app.use("/trpc/*", appSessionMiddleware(kratosStandIn));
  app.use("/trpc/*", async (c) => {
    const ctx = await createContext(c.req.raw, c);
    return fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router: appRouter,
      createContext: async () => ctx as never,
    });
  });
  return app;
}

async function trpc(
  auth: { bearer?: string; cookie?: string },
  path: string,
  input?: unknown,
  kind: "query" | "mutation" = path === "devices.list" ? "query" : "mutation"
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  const res =
    kind === "query"
      ? await appApi().request(
          `/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`}`,
          { headers }
        )
      : await appApi().request(`/trpc/${path}`, {
          method: "POST",
          headers,
          // superjson, as the app's tRPC client sends it.
          body: JSON.stringify({ json: input }),
        });
  return { status: res.status, body: await res.json() };
}

const listDevices = async (auth: { bearer?: string; cookie?: string }) => {
  const res = await trpc(auth, "devices.list");
  expect(res.status).toBe(200);
  return res.body.result.data.json as Array<{ id: string; current: boolean }>;
};

async function tokenRequest(
  params: Record<string, string>,
  userAgent = "SynapDesktop/2.0 (Macintosh)"
): Promise<{ status: number; body: any }> {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent,
    },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

const refresh = (refreshToken: string, clientId = DESKTOP) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

const revokeRequest = (params: Record<string, string>) =>
  oauthApp.request("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

const MIN_MS = 60 * 1000;

/** A Kratos session (as the consent procedure sees it) signed in `ago` ms back. */
/**
 * A console session signed in `agoMs` ago. `methods` = how, most recent
 * last, each with its own age (default: the pod password, at that time).
 */
const kratosCtx = (
  userId: string,
  agoMs: number,
  methods: Array<{ method: string; agoMs: number }> = [
    { method: "password", agoMs },
  ]
) =>
  ({
    authenticated: true,
    userId,
    sessionKind: "kratos",
    session: {
      identity: { id: userId, traits: { email: `${userId}@x` } },
      active: true,
      authenticated_at: new Date(Date.now() - agoMs).toISOString(),
      authentication_methods: methods.map((m) => ({
        method: m.method,
        completed_at: new Date(Date.now() - m.agoMs).toISOString(),
      })),
    },
  }) as never;

/**
 * The consent click by `userId` → the code it redirects with. By default the
 * person signed in to the console a minute ago (a FRESH sign-in). A request
 * for a fresh sign-in (`prompt` / `maxAge`) carries /authorize's signed time:
 * by default just BEFORE that sign-in (the person signed in for it).
 */
async function consent(
  userId = PERSON,
  opts: {
    signedInAgoMs?: number;
    prompt?: string;
    maxAge?: number;
    requestedAgoMs?: number;
    methods?: Array<{ method: string; agoMs: number }>;
  } = {}
): Promise<string> {
  const signedInAgo = opts.signedInAgoMs ?? MIN_MS;
  const requestedAgo = opts.requestedAgoMs ?? signedInAgo + 1_000;
  const { redirectTo } = await decideOAuthAuthorization(
    {
      clientId: DESKTOP,
      redirectUri: LOOPBACK,
      responseType: "code",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      state: "st",
      resource: ISSUER,
      approve: true,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.maxAge !== undefined ? { maxAge: opts.maxAge } : {}),
      ...(opts.prompt || opts.maxAge !== undefined
        ? { authRequest: signAuthRequestTime(Date.now() - requestedAgo) }
        : {}),
    },
    userId,
    kratosCtx(userId, signedInAgo, opts.methods)
  );
  const url = new URL(redirectTo);
  expect(url.searchParams.get("iss")).toBe(ISSUER);
  return url.searchParams.get("code")!;
}

/** Consent + the code exchange: a new device. */
async function signIn(
  label = "Ada's MacBook",
  signedInAgoMs = MIN_MS
): Promise<{
  access: string;
  refresh: string;
  deviceId: string;
  body: any;
}> {
  const code = await consent(PERSON, { signedInAgoMs });
  const { status, body } = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: DESKTOP,
    redirect_uri: LOOPBACK,
    code_verifier: VERIFIER,
    resource: ISSUER,
    synap_device_label: label,
  });
  expect(status).toBe(200);
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    deviceId: body.synap_device_id,
    body,
  };
}

const device = async (id: string) =>
  (
    await q<{
      user_id: string;
      client_id: string;
      label: string | null;
      user_agent: string | null;
      expires_at: Date;
      revoked_at: Date | null;
      created_at: Date;
      auth_time: Date | null;
    }>(`select * from person_devices where id = $1`, [id])
  ).rows[0]!;

// ─── (a) /authorize ──────────────────────────────────────────────────────────

describe("(a) /authorize for a Synap app", () => {
  const authorize = (over: Record<string, string>) => {
    const params = new URLSearchParams({
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      response_type: "code",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "st",
      ...over,
    });
    return oauthApp.request(`/authorize?${params}`);
  };

  it("any loopback port reaches the consent screen, with the sign-in hints", async () => {
    const res = await authorize({
      redirect_uri: "http://127.0.0.1:61999/oauth/callback",
      resource: ISSUER,
      login_hint: "ada@x",
      prompt: "create",
    });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://admin.pod.test.synap.live");
    expect(to.searchParams.get("client_id")).toBe(DESKTOP);
    expect(to.searchParams.get("login_hint")).toBe("ada@x");
    expect(to.searchParams.get("prompt")).toBe("create");
    expect(to.searchParams.get("resource")).toBe(ISSUER);
  });

  it("a request for a fresh sign-in carries its own signed time (auth_req); others do not", async () => {
    const fresh = new URL(
      (await authorize({ prompt: "login" })).headers.get("location")!
    );
    const stamped = verifyAuthRequestTime(fresh.searchParams.get("auth_req"));
    expect(stamped).not.toBeNull();
    expect(Math.abs(Date.now() - stamped!)).toBeLessThan(10_000);
    const plain = new URL(
      (await authorize({ prompt: "create" })).headers.get("location")!
    );
    expect(plain.searchParams.has("auth_req")).toBe(false);
  });

  it("a `localhost` redirect is refused and shown, never redirected", async () => {
    const res = await authorize({
      redirect_uri: "http://localhost:53111/oauth/callback",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("a resource naming /mcp is refused back to the app (invalid_target)", async () => {
    const res = await authorize({ resource: `${ISSUER}/mcp` });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(LOOPBACK);
    expect(back.searchParams.get("error")).toBe("invalid_target");
  });

  it("the metadata names the Synap apps (what an app feature-detects)", async () => {
    const res = await oauthApp.request(
      "/.well-known/oauth-authorization-server"
    );
    const doc = (await res.json()) as { synap_first_party_clients: string[] };
    expect(doc.synap_first_party_clients.sort()).toEqual([DESKTOP, RELAY]);
  });
});

// ─── (b) the person on /trpc ─────────────────────────────────────────────────

describe("(b) the device token is the person on the app API", () => {
  it("/token answers a device: 1 h access, rotating refresh, stored hashed", async () => {
    const s = await signIn();
    expect(s.access.startsWith("synap_pd_")).toBe(true);
    expect(s.body.token_type).toBe("Bearer");
    expect(s.body.expires_in).toBeGreaterThan(3500);
    expect(s.body.expires_in).toBeLessThanOrEqual(3600);
    const row = await device(s.deviceId);
    expect(row.user_id).toBe(PERSON);
    expect(row.client_id).toBe(DESKTOP);
    expect(row.label).toBe("Ada's MacBook");
    expect(row.user_agent).toContain("SynapDesktop");
    const capMs = new Date(row.expires_at).getTime() - Date.now();
    expect(capMs).toBeGreaterThan(PERSON_DEVICE_ABSOLUTE_CAP_MS - DAY_MS);
    expect(capMs).toBeLessThanOrEqual(PERSON_DEVICE_ABSOLUTE_CAP_MS);
    // Neither token's plaintext is in any table.
    for (const table of ["person_device_tokens", "oauth_refresh_tokens"]) {
      const dump = JSON.stringify((await q(`select * from ${table}`)).rows);
      expect(dump).not.toContain(s.access);
      expect(dump).not.toContain(s.refresh);
    }
  });

  it("on /trpc it is the person, and marks its own device current", async () => {
    const s = await signIn();
    const viaDevice = await listDevices({ bearer: s.access });
    expect(viaDevice.find((d) => d.id === s.deviceId)?.current).toBe(true);
    // The same person in a browser session sees it as another device.
    const viaBrowser = await listDevices({ cookie: BROWSER_COOKIE });
    expect(viaBrowser.find((d) => d.id === s.deviceId)?.current).toBe(false);
  });

  it("CONTROL — no credential is 401", async () => {
    expect((await trpc({}, "devices.list")).status).toBe(401);
  });
});

// ─── (c) refused on the agent doors ──────────────────────────────────────────

describe("(c) /mcp and Hub REST refuse a device token", () => {
  it("an /mcp write is 401", async () => {
    const s = await signIn();
    const res = await mcpHttpApp.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${s.access}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "synap_create_entity", arguments: { title: "x" } },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("a Hub REST call is 401", async () => {
    const s = await signIn();
    const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    hub.use("/*", hubAuthMiddleware as never);
    hub.get("/entities", (c) => c.json({ reached: true }));
    const root = new Hono();
    root.route("/api/hub", hub);
    const res = await root.request("/api/hub/entities", {
      headers: { authorization: `Bearer ${s.access}` },
    });
    expect(res.status).toBe(401);
  });
});

// ─── (d) refresh: rotation and reuse ─────────────────────────────────────────

describe("(d) refresh rotates; a reused refresh token ends the device", () => {
  it("a refresh answers a new pair that works", async () => {
    const s = await signIn();
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    expect(r.body.synap_device_id).toBe(s.deviceId);
    expect(r.body.refresh_token).not.toBe(s.refresh);
    expect(await listDevices({ bearer: r.body.access_token })).not.toEqual([]);
  });

  it("a database error after the claim spends nothing: the same token refreshes after", async () => {
    const s = await signIn();
    await q(
      `alter table person_device_tokens rename to person_device_tokens_away`
    );
    let failed: { status: number; body: any };
    try {
      failed = await refresh(s.refresh);
    } finally {
      await q(
        `alter table person_device_tokens_away rename to person_device_tokens`
      );
    }
    expect(failed.status).toBe(500);
    const again = await refresh(s.refresh);
    expect(again.status).toBe(200);
    expect((await device(s.deviceId)).revoked_at).toBeNull();
  });

  it("a successor is random, never derivable from its row id", async () => {
    const s = await signIn();
    const next = await refresh(s.refresh);
    expect(next.status).toBe(200);
    const [row] = (
      await q<{ replaced_by: string }>(
        `select replaced_by from oauth_refresh_tokens where device_id = $1 and replaced_by is not null`,
        [s.deviceId]
      )
    ).rows;
    expect(row?.replaced_by).toBeTruthy();
    expect(next.body.refresh_token).not.toBe(
      successorRefreshToken(row!.replaced_by)
    );
  });

  it("replaying the used token: invalid_grant, the device ends, its live access token stops", async () => {
    const s = await signIn();
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    // Its successor has been used: no retry grace can apply.
    const next = await refresh(r.body.refresh_token);
    expect(next.status).toBe(200);
    const replay = await refresh(s.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
    expect(
      (await trpc({ bearer: next.body.access_token }, "devices.list")).status
    ).toBe(401);
    expect((await refresh(next.body.refresh_token)).status).toBe(400);
  });
});

// ─── (k) a lost refresh response ─────────────────────────────────────────────

describe("(k) a retry after a lost refresh response", () => {
  const refreshRows = async (deviceId: string) =>
    (
      await q<{
        id: string;
        revoked_at: Date | null;
        last_used_at: Date | null;
      }>(
        `select id, revoked_at, last_used_at from oauth_refresh_tokens where device_id = $1 order by created_at, id`,
        [deviceId]
      )
    ).rows;

  it("within 30 s, the successor unused: a fresh pair, the device and family live on", async () => {
    const s = await signIn();
    const lost = await refresh(s.refresh); // the response never reaches the app
    expect(lost.status).toBe(200);
    const retry = await refresh(s.refresh);
    expect(retry.status).toBe(200);
    expect(retry.body.synap_device_id).toBe(s.deviceId);
    expect((await device(s.deviceId)).revoked_at).toBeNull();
    // The lost successor is retired. Presenting it later means TWO parties
    // hold this device's tokens (the retry could have been a thief's): a
    // reuse, and the device ends.
    expect((await refresh(lost.body.refresh_token)).status).toBe(400);
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
  });

  it("the retry's own successor works (the family lives on)", async () => {
    const s = await signIn();
    await refresh(s.refresh);
    const retry = await refresh(s.refresh);
    expect(retry.status).toBe(200);
    const onward = await refresh(retry.body.refresh_token);
    expect(onward.status).toBe(200);
    expect(await listDevices({ bearer: onward.body.access_token })).not.toEqual(
      []
    );
    const rows = await refreshRows(s.deviceId);
    expect(rows.filter((r) => !r.revoked_at && !r.last_used_at)).toHaveLength(
      1
    );
  });

  it("once the successor was used, the retry is a reuse: the device ends", async () => {
    const s = await signIn();
    const first = await refresh(s.refresh);
    expect((await refresh(first.body.refresh_token)).status).toBe(200);
    expect((await refresh(s.refresh)).status).toBe(400);
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
  });

  it("two retries of the same token at once (a double submit): one pair, the other refused, the device lives", async () => {
    const s = await signIn();
    expect((await refresh(s.refresh)).status).toBe(200); // response lost
    const [a, b] = await Promise.all([refresh(s.refresh), refresh(s.refresh)]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of [a, b]) {
      if (r.status !== 200) expect(r.body.error).toBe("invalid_grant");
    }
    expect((await device(s.deviceId)).revoked_at).toBeNull();
    // The app keeps the pair of the LATEST success, and it works.
    const kept = ok[ok.length - 1]!;
    expect((await refresh(kept.body.refresh_token)).status).toBe(200);
  });

  it("at 31 s the retry is a reuse: the device ends", async () => {
    const s = await signIn();
    expect((await refresh(s.refresh)).status).toBe(200);
    await q(
      `update oauth_refresh_tokens set last_used_at = now() - interval '31 seconds' where device_id = $1 and last_used_at is not null`,
      [s.deviceId]
    );
    expect((await refresh(s.refresh)).status).toBe(400);
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
  });
});

// ─── (e) the absolute cap ────────────────────────────────────────────────────

describe("(e) the 180-day absolute cap", () => {
  it("past the cap nothing refreshes or authenticates", async () => {
    const s = await signIn();
    await q(
      `update person_devices set expires_at = now() - interval '1 minute' where id = $1`,
      [s.deviceId]
    );
    const r = await refresh(s.refresh);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    expect((await trpc({ bearer: s.access }, "devices.list")).status).toBe(401);
  });

  it("near the cap, nothing is minted past it", async () => {
    const s = await signIn();
    await q(
      `update person_devices set expires_at = now() + interval '20 minutes' where id = $1`,
      [s.deviceId]
    );
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    expect(r.body.expires_in).toBeLessThanOrEqual(20 * 60);
    const cap = new Date((await device(s.deviceId)).expires_at).getTime();
    // The successor (the unused row) was issued after the cap moved in: it
    // must not outlive it. (The used first row predates the move.)
    const rows = (
      await q<{ expires_at: Date }>(
        `select expires_at from oauth_refresh_tokens where device_id = $1 and last_used_at is null`,
        [s.deviceId]
      )
    ).rows;
    expect(rows.length).toBe(1);
    expect(new Date(rows[0]!.expires_at).getTime()).toBeLessThanOrEqual(cap);
  });
});

// ─── (f) signing out ─────────────────────────────────────────────────────────

describe("(f) signing a device out stops it at once", () => {
  it("devices.revoke (from the browser) ends it: access 401, refresh invalid_grant", async () => {
    const s = await signIn();
    const res = await trpc({ cookie: BROWSER_COOKIE }, "devices.revoke", {
      deviceId: s.deviceId,
    });
    expect(res.status).toBe(200);
    expect(res.body.result.data.json.status).toBe("revoked");
    expect((await trpc({ bearer: s.access }, "devices.list")).status).toBe(401);
    expect((await refresh(s.refresh)).status).toBe(400);
    const listed = await listDevices({ cookie: BROWSER_COOKIE });
    expect(listed.map((d) => d.id)).not.toContain(s.deviceId);
  });

  it("an app signs ITSELF out without a step-up, and never as a proposal", async () => {
    const s = await signIn("Ada's old laptop", 3 * 60 * MIN_MS); // stale clock
    const other = await signIn("Ada's phone", 3 * 60 * MIN_MS);
    // Another device from a stale app: a step-up is asked first.
    const refused = await trpc({ bearer: s.access }, "devices.revoke", {
      deviceId: other.deviceId,
    });
    expect(refused.status).toBe(403);
    expect((await device(other.deviceId)).revoked_at).toBeNull();
    // Itself: signed out at once.
    const res = await trpc({ bearer: s.access }, "devices.revoke", {
      deviceId: s.deviceId,
    });
    expect(res.status).toBe(200);
    expect(res.body.result.data.json.status).toBe("revoked");
    expect((await trpc({ bearer: s.access }, "devices.list")).status).toBe(401);
    expect(
      (
        await q(`select 1 from proposals where data::text like $1`, [
          `%${s.deviceId}%`,
        ])
      ).rows
    ).toHaveLength(0);
  });

  it("another person's device is not found, and stays signed in", async () => {
    const theirs = await signInPersonDevice({
      personUserId: OTHER,
      clientId: DESKTOP,
    });
    if (!theirs.ok) throw new Error("bob signs in");
    const res = await trpc({ cookie: BROWSER_COOKIE }, "devices.revoke", {
      deviceId: theirs.deviceId,
    });
    expect(res.status).toBe(404);
    expect((await device(theirs.deviceId)).revoked_at).toBeNull();
  });

  it("/revoke with the refresh token (the app's sign out) ends the device", async () => {
    const s = await signIn();
    const res = await revokeRequest({
      token: s.refresh,
      token_type_hint: "refresh_token",
      client_id: DESKTOP,
    });
    expect(res.status).toBe(200);
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
    expect((await trpc({ bearer: s.access }, "devices.list")).status).toBe(401);
  });

  it("/revoke with the access token: another client is refused, the right one ends it", async () => {
    const s = await signIn();
    const wrong = await revokeRequest({ token: s.access, client_id: RELAY });
    expect(wrong.status).toBe(400);
    expect((await device(s.deviceId)).revoked_at).toBeNull();
    const right = await revokeRequest({ token: s.access, client_id: DESKTOP });
    expect(right.status).toBe(200);
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
  });
});

// ─── (i) credential doors ────────────────────────────────────────────────────

describe("(i) a STALE device token cannot create, widen or approve a credential", () => {
  const DOORS: Array<[string, unknown, "query" | "mutation"]> = [
    [
      "apiKeys.create",
      {
        keyName: "from a phone",
        scope: ["hub-protocol.read"],
        grant: { permissions: ["entity.read"] },
      },
      "mutation",
    ],
    ["apiKeys.beginMcpConnect", { agentType: "claude-web" }, "mutation"],
    [
      "apiKeys.decideDeviceRequest",
      { requestId: randomUUID(), userCode: "ABCD-1234", decision: "approve" },
      "mutation",
    ],
    [
      "apiKeys.setGrants",
      { keyId: randomUUID(), grants: [{ permissions: ["entity.read"] }] },
      "mutation",
    ],
    ["apiKeys.getDeviceRequest", { userCode: "ABCD-1234" }, "query"],
    ["machines.revoke", { machineId: "m-1" }, "mutation"],
    ["devices.revoke", { deviceId: randomUUID() }, "mutation"],
    // Reading a secret's value, and giving someone else lasting access.
    ["secretsVault.reveal", { id: randomUUID() }, "mutation"],
    [
      "workspaces.createInvite",
      {
        type: "workspace",
        workspaceId: randomUUID(),
        email: "someone@example.com",
        role: "viewer",
      },
      "mutation",
    ],
    [
      "integrations.create",
      {
        name: "from a phone",
        url: "not a url",
        eventTypes: ["entity.created"],
      },
      "mutation",
    ],
  ];

  it.each(DOORS)(
    "%s answers 403 STEP_UP_REQUIRED to a device whose sign-in is 6 minutes old",
    async (path, input, kind) => {
      const s = await signIn("stale", 6 * MIN_MS);
      const res = await trpc({ bearer: s.access }, path, input, kind);
      expect(res.status).toBe(403);
      expect(res.body.error.json.data.reasonCode).toBe(STEP_UP_REQUIRED);
    }
  );

  it.each(DOORS)(
    "CONTROL — %s is not refused that way to the same person's browser session",
    async (path, input, kind) => {
      const res = await trpc({ cookie: BROWSER_COOKIE }, path, input, kind);
      expect(res.body.error?.json?.data?.reasonCode).not.toBe(STEP_UP_REQUIRED);
    }
  );

  it.each(DOORS)(
    "CONTROL — %s is not refused that way to a device that signed in a minute ago",
    async (path, input, kind) => {
      const s = await signIn("fresh", MIN_MS);
      const res = await trpc({ bearer: s.access }, path, input, kind);
      expect(res.body.error?.json?.data?.reasonCode).not.toBe(STEP_UP_REQUIRED);
    }
  );

  it("CONTROL — a grant only to the caller is not a step-up: a stale device makes its own space", async () => {
    const s = await signIn("stale", 6 * MIN_MS);
    const res = await trpc(
      { bearer: s.access },
      "workspaces.create",
      { name: `From a phone ${randomUUID().slice(0, 8)}` },
      "mutation"
    );
    expect(res.body.error?.json?.data?.reasonCode).not.toBe(STEP_UP_REQUIRED);
    expect(res.status).toBe(200);
  });
});

// ─── (j) step-up ─────────────────────────────────────────────────────────────

describe("(j) step-up: the clock is the device's real sign-in", () => {
  const DECIDE = {
    requestId: randomUUID(),
    userCode: "ABCD-1234",
    decision: "approve",
  };
  const decideDevice = (bearer: string) =>
    trpc({ bearer }, "apiKeys.decideDeviceRequest", DECIDE, "mutation");
  const stepUpRequired = (res: { status: number; body: any }) =>
    res.status === 403 &&
    res.body.error?.json?.data?.reasonCode === STEP_UP_REQUIRED;
  const age = async (deviceId: string, minutes: number) =>
    q(
      `update person_devices set auth_time = now() - ($2 || ' minutes')::interval where id = $1`,
      [deviceId, String(minutes)]
    );

  it("a fresh device passes decideDeviceRequest's door (the request itself is unknown)", async () => {
    const s = await signIn("fresh", MIN_MS);
    const res = await decideDevice(s.access);
    expect(stepUpRequired(res)).toBe(false);
  });

  it("6 minutes after its sign-in it gets 403 STEP_UP_REQUIRED", async () => {
    const s = await signIn("aging", MIN_MS);
    await age(s.deviceId, 6);
    expect(stepUpRequired(await decideDevice(s.access))).toBe(true);
  });

  it("a refreshed token stays stale: a refresh never renews the clock", async () => {
    const s = await signIn("refreshing", MIN_MS);
    await age(s.deviceId, 6);
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    expect(stepUpRequired(await decideDevice(r.body.access_token))).toBe(true);
  });

  it("a device minted from an old sign-in needs a step-up at once", async () => {
    const s = await signIn("old session", 3 * 60 * MIN_MS);
    expect(stepUpRequired(await decideDevice(s.access))).toBe(true);
  });

  it("the clock is the sign-in, not the mint: minted 4 minutes after a sign-in, it passes", async () => {
    const s = await signIn("recent session", 4 * MIN_MS);
    expect(stepUpRequired(await decideDevice(s.access))).toBe(false);
    const row = await q<{ auth_time: Date }>(
      `select auth_time from person_devices where id = $1`,
      [s.deviceId]
    );
    const lag = Date.now() - new Date(row.rows[0]!.auth_time).getTime();
    expect(lag).toBeGreaterThan(3.5 * MIN_MS);
  });

  it("a step-up re-confirms the SAME device: its clock moves, no device is added", async () => {
    const s = await signIn("phone", 3 * 60 * MIN_MS);
    expect(stepUpRequired(await decideDevice(s.access))).toBe(true);
    const before = await q<{ n: number }>(
      `select count(*)::int as n from person_devices where user_id = $1`,
      [PERSON]
    );
    const code = await consent(PERSON, {
      prompt: "login",
      signedInAgoMs: 10_000,
    });
    const { status, body } = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      code_verifier: VERIFIER,
      synap_device_refresh_token: s.refresh,
    });
    expect(status).toBe(200);
    expect(body.synap_device_id).toBe(s.deviceId);
    const after = await q<{ n: number }>(
      `select count(*)::int as n from person_devices where user_id = $1`,
      [PERSON]
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(stepUpRequired(await decideDevice(body.access_token))).toBe(false);
  });

  it("a step-up with another person's device refresh token is refused and spends nothing", async () => {
    const bobs = await signInPersonDevice({
      personUserId: OTHER,
      clientId: DESKTOP,
      authTime: new Date(Date.now() - 3 * 60 * MIN_MS),
    });
    if (!bobs.ok) throw new Error("bob signs in");
    const code = await consent(PERSON, {
      prompt: "login",
      signedInAgoMs: 10_000,
    });
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      code_verifier: VERIFIER,
      synap_device_refresh_token: bobs.refreshToken,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    // Bob's token was not spent: it still refreshes.
    expect((await refresh(bobs.refreshToken)).status).toBe(200);
    const bobDevice = await device(bobs.deviceId);
    expect(new Date(bobDevice.created_at).getTime()).toBeGreaterThan(0);
  });

  it('"Confirm it\'s you" can never make a device, and "Sign in" can never re-confirm one', async () => {
    const s = await signIn("laptop", 3 * 60 * MIN_MS);
    const count = async () =>
      (
        await q<{ n: number }>(
          `select count(*)::int as n from person_devices where user_id = $1`,
          [PERSON]
        )
      ).rows[0]!.n;
    const exchange = (code: string, deviceRefresh?: string) =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: DESKTOP,
        redirect_uri: LOOPBACK,
        code_verifier: VERIFIER,
        ...(deviceRefresh ? { synap_device_refresh_token: deviceRefresh } : {}),
      });
    const before = await count();
    // The screen the person saw names which act it is.
    const ctxFor = (prompt?: string) =>
      getOAuthConsentContext(
        {
          clientId: DESKTOP,
          redirectUri: LOOPBACK,
          responseType: "code",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          resource: ISSUER,
          ...(prompt ? { prompt } : {}),
        },
        PERSON,
        (kratosCtx(PERSON, 10_000) as { session: never }).session
      );
    expect((await ctxFor("login")).reconfirmDevice).toBe(true);
    expect((await ctxFor()).reconfirmDevice).toBe(false);

    // A step-up code without the device's refresh token: refused, no device.
    const confirm = await consent(PERSON, {
      prompt: "login",
      signedInAgoMs: 10_000,
    });
    const minted = await exchange(confirm);
    expect(minted.status).toBe(400);
    expect(minted.body.error).toBe("invalid_grant");
    expect(await count()).toBe(before);

    // A sign-in code presented as a re-confirmation: refused, unspent.
    const signInCode = await consent(PERSON, { signedInAgoMs: 10_000 });
    const reconfirmed = await exchange(signInCode, s.refresh);
    expect(reconfirmed.status).toBe(400);
    expect(reconfirmed.body.error).toBe("invalid_grant");
    expect((await refresh(s.refresh)).status).toBe(200);
    expect(await count()).toBe(before);
  });

  it("prompt=login on a sign-in from before the request is refused (LOGIN_REQUIRED), before any code", async () => {
    await expect(
      consent(PERSON, {
        prompt: "login",
        signedInAgoMs: 30 * MIN_MS,
        requestedAgoMs: 0,
      })
    ).rejects.toMatchObject({ reasonCode: "LOGIN_REQUIRED" });
    await expect(
      consent(PERSON, {
        maxAge: 0,
        signedInAgoMs: 30 * MIN_MS,
        requestedAgoMs: 0,
      })
    ).rejects.toMatchObject({ reasonCode: "LOGIN_REQUIRED" });
    // A Synap app's prompt=login is OIDC too: a sign-in one minute old but
    // made BEFORE the request does not satisfy it.
    await expect(
      consent(PERSON, {
        prompt: "login",
        signedInAgoMs: MIN_MS,
        requestedAgoMs: 0,
      })
    ).rejects.toMatchObject({ reasonCode: "LOGIN_REQUIRED" });
    // max_age wider than the sign-in's age is satisfied.
    await expect(
      consent(PERSON, { maxAge: 3600, signedInAgoMs: 30 * MIN_MS })
    ).resolves.toBeTruthy();
  });

  it("a Synap Cloud sign-in never sets the clock: a device minted from one needs a step-up at once", async () => {
    const code = await consent(PERSON, {
      methods: [{ method: "oidc", agoMs: MIN_MS }],
    });
    const { body } = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      code_verifier: VERIFIER,
      resource: ISSUER,
      synap_device_label: "Cloud laptop",
    });
    expect((await device(body.synap_device_id)).auth_time).toBeNull();
    expect(stepUpRequired(await decideDevice(body.access_token))).toBe(true);
  });

  it('"Confirm it\'s you" answered with Synap Cloud only is refused (POD_CREDENTIAL_REQUIRED), before any code', async () => {
    const codesBefore = await q<{ n: number }>(
      `select count(*)::int as n from oauth_authorization_codes`
    );
    // Password 3 h ago, then a (possibly silent) Cloud re-login just now.
    await expect(
      consent(PERSON, {
        prompt: "login",
        signedInAgoMs: 10_000,
        methods: [
          { method: "password", agoMs: 180 * MIN_MS },
          { method: "oidc", agoMs: 10_000 },
        ],
      })
    ).rejects.toMatchObject({ reasonCode: "POD_CREDENTIAL_REQUIRED" });
    const codesAfter = await q<{ n: number }>(
      `select count(*)::int as n from oauth_authorization_codes`
    );
    expect(codesAfter.rows[0]!.n).toBe(codesBefore.rows[0]!.n);
    // The screen knows before the click.
    const shown = await getOAuthConsentContext(
      {
        clientId: DESKTOP,
        redirectUri: LOOPBACK,
        responseType: "code",
        codeChallenge: CHALLENGE,
        codeChallengeMethod: "S256",
        resource: ISSUER,
        prompt: "login",
        authRequest: signAuthRequestTime(Date.now() - 11_000),
      },
      PERSON,
      (
        kratosCtx(PERSON, 10_000, [
          { method: "password", agoMs: 180 * MIN_MS },
          { method: "oidc", agoMs: 10_000 },
        ]) as unknown as { session: never }
      ).session
    );
    expect(shown.podCredentialRequired).toBe(true);
    expect(shown.reauthenticate).toBe(false);
  });

  it("CONTROL — the same step-up answered with the pod password after the request passes", async () => {
    await expect(
      consent(PERSON, {
        prompt: "login",
        signedInAgoMs: 10_000,
        methods: [
          { method: "oidc", agoMs: 180 * MIN_MS },
          { method: "password", agoMs: 10_000 },
        ],
      })
    ).resolves.toBeTruthy();
  });

  it("a secret grant asks for it where it is written (a service with no ctx)", async () => {
    const secretId = randomUUID();
    const grant = () =>
      applyVaultSecretGrant({
        secretId,
        grantedTo: PERSON,
        workspaceId: null,
        scope: "session",
        ttlMinutes: 5,
        createdBy: PERSON,
      });
    await expect(
      runAsDeviceSession(
        { id: "d", authTime: new Date(Date.now() - 6 * MIN_MS) },
        grant
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const none = await q<{ n: number }>(
      `select count(*)::int as n from vault_grants where grantable_id = $1`,
      [secretId]
    );
    expect(none.rows[0]!.n).toBe(0);
    await runAsDeviceSession({ id: "d", authTime: new Date() }, grant);
    const one = await q<{ n: number }>(
      `select count(*)::int as n from vault_grants where grantable_id = $1`,
      [secretId]
    );
    expect(one.rows[0]!.n).toBe(1);
  });
});

// ─── (g) binding ─────────────────────────────────────────────────────────────

describe("(g) a device's refresh token is bound to its client", () => {
  it("presented by Relay: invalid_grant, and not spent", async () => {
    const s = await signIn();
    const wrong = await refresh(s.refresh, RELAY);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    expect((await refresh(s.refresh)).status).toBe(200);
  });
});

// ─── (h) never an agent ──────────────────────────────────────────────────────

describe("(h) an agent cannot sign in as a device", () => {
  it("the consent refuses an agent, and the mint door refuses one", async () => {
    await expect(consent(AGENT)).rejects.toThrow(/human/i);
    const minted = await signInPersonDevice({
      personUserId: AGENT,
      clientId: DESKTOP,
    });
    expect(minted).toEqual({ ok: false, reason: "not_a_person" });
    const count = await q<{ n: number }>(
      `select count(*)::int as n from person_devices where user_id = $1`,
      [AGENT]
    );
    expect(count.rows[0]!.n).toBe(0);
  });

  it("a device token cannot authorize a connection (no 1 h → 180 d escalation)", async () => {
    const s = await signIn();
    await expect(
      decideOAuthAuthorization(
        {
          clientId: DESKTOP,
          redirectUri: LOOPBACK,
          responseType: "code",
          codeChallenge: CHALLENGE,
          codeChallengeMethod: "S256",
          approve: true,
        },
        PERSON,
        {
          authenticated: true,
          userId: PERSON,
          session: {
            identity: { id: PERSON, traits: { email: "ada@x" } },
            active: true,
            device: { id: s.deviceId, clientId: DESKTOP },
          },
        } as never
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/console/),
    });
  });

  it("a non-first-party client id never gets a device", async () => {
    const minted = await signInPersonDevice({
      personUserId: PERSON,
      clientId: "dcr_somebody",
    });
    expect(minted).toEqual({ ok: false, reason: "not_first_party" });
  });

  it("CONTROL — the devices made above are a plausible set (non-vacuity)", async () => {
    const n = await q<{ n: number }>(
      `select count(*)::int as n from person_devices where user_id = $1 and client_id = $2`,
      [randomUUID(), DESKTOP]
    );
    expect(n.rows[0]!.n).toBe(0);
    const ada = await q<{ n: number }>(
      `select count(*)::int as n from person_devices where user_id = $1`,
      [PERSON]
    );
    expect(ada.rows[0]!.n).toBeGreaterThan(5);
  });
});

// ─── (l) losing access to the pod ends the device ───────────────────────────

describe("(l) every way a person loses access to the pod ends their devices", () => {
  /** Consent + code exchange for `userId` (a fresh console sign-in). */
  async function deviceFor(userId: string, label = "A laptop") {
    const code = await consent(userId);
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      code_verifier: VERIFIER,
      resource: ISSUER,
      synap_device_label: label,
    });
    return res;
  }
  async function signedIn(userId: string, label?: string) {
    const res = await deviceFor(userId, label);
    expect(res.status).toBe(200);
    const d = {
      access: res.body.access_token as string,
      refresh: res.body.refresh_token as string,
      deviceId: res.body.synap_device_id as string,
    };
    expect((await trpc({ bearer: d.access }, "devices.list")).status).toBe(200);
    return d;
  }
  /** The pod owner, as pod-admin's Members page calls the doors. */
  const asOwner = () =>
    router({
      removeFromPod: inviteProcedures.removeFromPod,
      connections: applicationConnectionsRouter,
    }).createCaller(kratosCtx(OWNER, MIN_MS));

  it("removed from the pod with the account kept (its connections would not go): 401, the device ended", async () => {
    const carol = await signedIn(CAROL);
    connections.failFor.add(CAROL);
    await expect(asOwner().removeFromPod({ userId: CAROL })).rejects.toThrow(
      /account was kept/
    );
    // The door's own outcome: memberships gone, the account still here.
    expect(
      (await q(`select 1 from users where id = $1`, [CAROL])).rows
    ).toHaveLength(1);
    expect(
      (await q(`select 1 from workspace_members where user_id = $1`, [CAROL]))
        .rows
    ).toHaveLength(0);

    expect((await trpc({ bearer: carol.access }, "devices.list")).status).toBe(
      401
    );
    const ended = await device(carol.deviceId);
    expect(ended.revoked_at).not.toBeNull();
    expect((await refresh(carol.refresh)).body.error).toBe("invalid_grant");
    // Adding the person back does not revive the device.
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
         values (gen_random_uuid(), $1, $2, 'editor')`,
      [WS_TEAM, CAROL]
    );
    expect((await trpc({ bearer: carol.access }, "devices.list")).status).toBe(
      401
    );
  });

  it("removed from the pod (the account and Kratos identity go): 401", async () => {
    const dan = await signedIn(DAN);
    await asOwner().removeFromPod({ userId: DAN });
    expect(kratos.deleted).toContain(DAN);
    expect((await trpc({ bearer: dan.access }, "devices.list")).status).toBe(
      401
    );
    expect((await refresh(dan.refresh)).body.error).toBe("invalid_grant");
  });

  it("a socket's device is re-checked (liveDeviceIds): live stays, signed out and lost access do not, and lost access ends it", async () => {
    const JUN = "person-jun";
    const KAI = "person-kai";
    await q(
      `insert into users (id, email, name, user_type) values
         ($1, 'jun@x', 'Jun', 'human'), ($2, 'kai@x', 'Kai', 'human')`,
      [JUN, KAI]
    );
    for (const u of [JUN, KAI]) {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role)
           values (gen_random_uuid(), $1, $2, 'editor')`,
        [WS_TEAM, u]
      );
    }
    const live = await signedIn(JUN, "live");
    const out = await signedIn(JUN, "signed out");
    const lost = await signedIn(KAI);
    await revokePersonDevice(h.db, {
      deviceId: out.deviceId,
      reason: "signed out",
    });
    await q(`delete from workspace_members where user_id = $1`, [KAI]);

    const result = await liveDeviceIds(h.db, [
      live.deviceId,
      out.deviceId,
      lost.deviceId,
      randomUUID(),
    ]);
    expect([...result]).toEqual([live.deviceId]);
    expect((await device(lost.deviceId)).revoked_at).not.toBeNull();
    expect((await device(live.deviceId)).revoked_at).toBeNull();
  });

  it("CONTROL — removed from one space but still in another: the device keeps working", async () => {
    const eve = await signedIn(EVE);
    await asOwner().removeFromPod({ userId: EVE });
    expect((await trpc({ bearer: eve.access }, "devices.list")).status).toBe(
      200
    );
    expect((await refresh(eve.refresh)).status).toBe(200);
  });

  it("unlinked from an app's issuer: every device of the person ends, the access stays", async () => {
    const laptop = await signedIn(FRAN, "Fran's laptop");
    const phone = await signedIn(FRAN, "Fran's other computer");
    const issuerId = randomUUID();
    const connectionId = randomUUID();
    await q(
      `insert into trusted_issuers (id, issuer_url, display_name, status)
         values ($1, 'https://id.example.com', 'Example ID', 'approved')`,
      [issuerId]
    );
    await q(
      `insert into federated_application_connections
         (id, issuer_id, client_id, display_name, status)
         values ($1, $2, 'example-app', 'Example', 'approved')`,
      [connectionId, issuerId]
    );
    await q(
      `insert into federated_identity_links (issuer_id, issuer_subject, user_id)
         values ($1, 'sub-fran', $2)`,
      [issuerId, FRAN]
    );
    const outcome = await asOwner().connections.unlinkAccount({
      connectionId,
      userId: FRAN,
    });
    expect(outcome.status).toBe("unlinked");
    for (const d of [laptop, phone]) {
      expect((await trpc({ bearer: d.access }, "devices.list")).status).toBe(
        401
      );
      expect((await device(d.deviceId)).revoked_at).not.toBeNull();
      expect((await refresh(d.refresh)).body.error).toBe("invalid_grant");
    }
    // Unlink is not removal: Fran is still a member, and signs in again.
    expect(
      (await q(`select 1 from workspace_members where user_id = $1`, [FRAN]))
        .rows
    ).toHaveLength(1);
    await signedIn(FRAN, "Fran signs in again");
  });

  it("the Kratos identity disabled or deleted: the next refresh ends the device; Kratos down spends nothing", async () => {
    const gil = await signedIn(GIL);
    kratos.identity.set(GIL, "down");
    const down = await refresh(gil.refresh);
    expect(down.status).toBe(500);
    expect(down.body.error).toBe("server_error");
    // Nothing was spent: the same token refreshes once Kratos answers.
    kratos.identity.set(GIL, "active");
    const next = await refresh(gil.refresh);
    expect(next.status).toBe(200);

    kratos.identity.set(GIL, "inactive");
    const disabled = await refresh(next.body.refresh_token);
    expect(disabled.body.error).toBe("invalid_grant");
    expect((await device(gil.deviceId)).revoked_at).not.toBeNull();
    expect(
      (await trpc({ bearer: next.body.access_token }, "devices.list")).status
    ).toBe(401);

    kratos.identity.set(GIL, "active");
    const second = await signedIn(GIL, "Gil's second laptop");
    kratos.identity.set(GIL, "gone");
    expect((await refresh(second.refresh)).body.error).toBe("invalid_grant");
    expect((await device(second.deviceId)).revoked_at).not.toBeNull();
    kratos.identity.delete(GIL);
  });

  it("a removed person's step-up is refused, and ends the device", async () => {
    const ivy = await signedIn(IVY);
    connections.failFor.add(IVY);
    await expect(asOwner().removeFromPod({ userId: IVY })).rejects.toThrow(
      /account was kept/
    );
    // Ivy's Kratos identity was kept, so she can still sign in to the
    // console and click "Confirm it's you" — the step-up must not revive her.
    const code = await consent(IVY, { prompt: "login", signedInAgoMs: 10_000 });
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: DESKTOP,
      redirect_uri: LOOPBACK,
      code_verifier: VERIFIER,
      synap_device_refresh_token: ivy.refresh,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect((await device(ivy.deviceId)).revoked_at).not.toBeNull();
  });

  it("a person with no access to the pod gets no device", async () => {
    const res = await deviceFor(NOBODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(
      (await q(`select 1 from person_devices where user_id = $1`, [NOBODY]))
        .rows
    ).toHaveLength(0);
  });
});

// ─── (m) at most 20 live devices per person ─────────────────────────────────

describe("(m) a person holds at most 20 live devices", () => {
  it("the 21st sign-in ends the least recently used device, and only it", async () => {
    const ids: string[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < PERSON_DEVICE_MAX_ACTIVE; i++) {
      const d = await signInPersonDevice({
        personUserId: HAL,
        clientId: DESKTOP,
        authTime: new Date(),
      });
      if (!d.ok) throw new Error("hal signs in");
      ids.push(d.deviceId);
      tokens.push(d.accessToken);
    }
    // Every device was used recently except the 6th, the least recent.
    await q(
      `update person_devices set last_used_at = now() - interval '1 minute' where user_id = $1`,
      [HAL]
    );
    await q(
      `update person_devices set last_used_at = now() - interval '9 days' where id = $1`,
      [ids[5]]
    );
    const live = async () =>
      (
        await q<{ id: string }>(
          `select id from person_devices where user_id = $1 and revoked_at is null`,
          [HAL]
        )
      ).rows.map((r) => r.id);
    expect(await live()).toHaveLength(PERSON_DEVICE_MAX_ACTIVE);

    const newest = await signInPersonDevice({
      personUserId: HAL,
      clientId: DESKTOP,
      authTime: new Date(),
    });
    if (!newest.ok) throw new Error("hal signs in again");
    const after = await live();
    expect(after).toHaveLength(PERSON_DEVICE_MAX_ACTIVE);
    expect(after).toContain(newest.deviceId);
    expect(after).not.toContain(ids[5]);
    expect((await trpc({ bearer: tokens[5]! }, "devices.list")).status).toBe(
      401
    );
    expect((await trpc({ bearer: tokens[4]! }, "devices.list")).status).toBe(
      200
    );
  });
});
