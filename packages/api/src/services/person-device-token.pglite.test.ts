/**
 * A Synap app signs a person in on a device (join plan target A) — end to end
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
 * Rows that rule out a wrong rule (threats: services/person-device-token.ts):
 *  (a) /authorize: any loopback port is accepted, `localhost` is refused AND
 *      not redirected, a resource naming /mcp is refused; the sign-in hints
 *      reach the consent screen;
 *  (b) the token is the PERSON on /trpc (the device marked `current`), while
 *      the same person in a browser session sees it as another device;
 *  (c) T1: /mcp (a write) and Hub REST answer 401 to it;
 *  (d) T2: a reused refresh token ends the DEVICE, its live access token too;
 *  (e) T3: the absolute cap is enforced — past it nothing refreshes or
 *      authenticates, and near it nothing is minted past it;
 *  (f) signing out (devices.revoke, /revoke with either token) stops the
 *      device at once; another person's device is "not found";
 *  (g) a refresh token is bound to its client;
 *  (h) T5: an agent cannot sign in as a device.
 *
 * Mocked: audit log (a recorder on the postgres-js client), the guest check
 * (a constant answer), the Kratos half of the session gate (a stand-in that
 * knows one browser cookie).
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
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
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
import { oauthApp } from "../routers/oauth/routes.js";
import { decideOAuthAuthorization } from "../routers/oauth/consent.js";
import { appSessionMiddleware } from "../middleware/app-session.js";
import { createContext } from "../context.js";
import { router } from "../trpc.js";
import { devicesRouter } from "../routers/devices.js";
import { mcpHttpApp } from "../routers/mcp/http-handler.js";
import { hubAuthMiddleware } from "../routers/hub-protocol/_middleware/auth.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import {
  PERSON_DEVICE_ABSOLUTE_CAP_MS,
  signInPersonDevice,
} from "./person-device-token.js";

const ISSUER = "https://pod.test.synap.live";
const DESKTOP = "synap-desktop";
const RELAY = "synap-relay";
const LOOPBACK = "http://127.0.0.1:53111/oauth/callback";
const PERSON = "person-ada";
const OTHER = "person-bob";
const AGENT = "agent-claude";
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

const appRouter = router({ devices: devicesRouter });

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
  path: "devices.list" | "devices.revoke",
  input?: unknown
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  if (auth.cookie) headers.cookie = auth.cookie;
  const res =
    path === "devices.list"
      ? await appApi().request(`/trpc/${path}`, { headers })
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

/** The consent click by `userId` → the code it redirects with. */
async function consent(userId = PERSON): Promise<string> {
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
    },
    userId
  );
  const url = new URL(redirectTo);
  expect(url.searchParams.get("iss")).toBe(ISSUER);
  return url.searchParams.get("code")!;
}

/** Consent + the code exchange: a new device. */
async function signIn(label = "Ada's MacBook"): Promise<{
  access: string;
  refresh: string;
  deviceId: string;
  body: any;
}> {
  const code = await consent();
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

  it("replaying the used token: invalid_grant, the device ends, its live access token stops", async () => {
    const s = await signIn();
    const r = await refresh(s.refresh);
    expect(r.status).toBe(200);
    const replay = await refresh(s.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await device(s.deviceId)).revoked_at).not.toBeNull();
    expect(
      (await trpc({ bearer: r.body.access_token }, "devices.list")).status
    ).toBe(401);
    expect((await refresh(r.body.refresh_token)).status).toBe(400);
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
    const rows = (
      await q<{ expires_at: Date }>(
        `select expires_at from oauth_refresh_tokens where device_id = $1`,
        [s.deviceId]
      )
    ).rows;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(cap);
    }
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
    ).rejects.toThrow(/console/);
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
