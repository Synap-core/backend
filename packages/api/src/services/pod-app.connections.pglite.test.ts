/**
 * The connections manager and the pod admin's policy for pod apps (spec 17,
 * wave PB4) — end to end on PGlite.
 *
 * The chain is the REAL one, as in oauth-refresh.pglite.test.ts: consent
 * (`decideOAuthAuthorization` → `connectOAuthApp`) → the code → `POST /token`
 * over HTTP → refresh; the person's doors are the REAL `apps` router
 * (`narrow`, `setWriteMode`, `revoke`, `list`), the admin's its `admin*`
 * procedures; webhooks go through the REAL `POST /webhooks` handler and the
 * generic governance door through the REAL `PATCH /agent-users/:id/governance`,
 * behind a stand-in for the hub auth door that resolves the bearer with
 * `apiKeyService.validateApiKey` the way the real one does.
 *
 * Pinned (spec 17 PB4):
 *   N  narrow shrinks the live key now (refused at once) and the next refresh
 *      (narrower grant, memberships, scope); it can only take access away;
 *      an agent's credential cannot narrow;
 *   V  revoke kills keys + refresh families + waiting codes;
 *   P  the unverified switch refuses at /authorize, consent context and the
 *      Allow click; a Synap app still connects; on again, it connects;
 *   A  the admin-only doors refuse a member and an agent's credential;
 *      the admin view groups members per app; "revoke for everyone";
 *   W  a pod app's webhook survives the hourly rotation (and the GC), goes to
 *      the app's own site only, and dies on revoke;
 *   M  "apply automatically" starts off, is the owner's switch, an agent
 *      cannot flip it (the app's door nor the generic governance door), and
 *      revoke resets it.
 *
 * Seams replaced, and why: the event store (`EventRepository`) and `auditLog`
 * write through the postgres-js client this harness has not — both are
 * recorders. `createPendingProposal` inserts on the transaction it is given.
 * `isPodAdmin` reads a set (the pod-admin workspace is not what is tested).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
      return event;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    EventRepository: RecordingEventRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    createPendingProposal: async (
      input: Record<string, unknown>,
      tx?: unknown
    ) => {
      const [row] = await ((tx ?? h.db) as any)
        .insert(schema.proposals)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          workspaceId: input.workspaceId ?? null,
          status: "pending",
          data: input.data,
          agentUserId: input.agentUserId ?? null,
          createdBy: input.createdBy,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppRepository, runWithGrant } from "@synap/database";
import * as schema from "@synap/database/schema";
import { readAgentGovernance } from "@synap/database/agent-governance";
import { liveApiKeyIds } from "@synap/jobs/workers/webhook-worker.js";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "../routers/oauth/consent.js";
import { appsRouter } from "../routers/apps.js";
import { registerWebhooksRoutes } from "../routers/hub-protocol/rest/webhooks.js";
import { registerAgentUsersRoutes } from "../routers/hub-protocol/rest/agent-users.js";
import { registerAppsRoutes } from "../routers/hub-protocol/rest/apps.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import { apiKeyService } from "./api-keys.js";
import { podAppViews } from "./app-connect.js";

const ISSUER = "https://pod.test.synap.live";
const STUDIO = "https://studio.example.com/.well-known/synap-client.json";
const STUDIO_CB = "https://studio.example.com/api/synap/callback";
const NOTES = "https://notes.example.com/.well-known/synap-client.json";
const NOTES_CB = "https://notes.example.com/cb";
const SYNAP_APP =
  "https://content-studio.synap.live/.well-known/synap-client.json";
const SYNAP_CB = "https://content-studio.synap.live/api/synap/callback";

const OWNER = "human-owner";
const MEMBER = "human-member";
const ADMIN = "human-admin";
const SOME_AGENT = "agent-of-owner";
const BRAND = randomUUID();
const SHARED = randomUUID();

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const READ = "entity.post.read";
const CREATE = "entity.post.create";

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
  h.client!.query<T>(sql, params).then((r) => r.rows);

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://pod-admin.test.synap.live";
  delete process.env.POD_ADMIN_DOMAIN;
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, email, name] of [
    [OWNER, "owner@x", "Ada"],
    [MEMBER, "member@x", "Bo"],
    [ADMIN, "admin@x", "Cy"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, email, name]
    );
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, created_via)
     values ($1, 'agent@x', 'agent', $2, 'claude-code', 'cli')`,
    [SOME_AGENT, OWNER]
  );
  for (const [id, name, owner] of [
    [BRAND, "Brand", OWNER],
    [SHARED, "Shared", OWNER],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      id,
      name,
      owner,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, owner]
    );
  }
  // MEMBER reads Brand too: their own connection of the same app.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'viewer')`,
    [randomUUID(), BRAND, MEMBER]
  );
  for (const [clientId, callback] of [
    [STUDIO, STUDIO_CB],
    [NOTES, NOTES_CB],
    [SYNAP_APP, SYNAP_CB],
  ]) {
    await q(
      `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
         requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, created_at)
       values ($1, 'cimd', 'Content Studio', $2, '{}', $3, '{}', now(), now() + interval '1 hour', now())`,
      [clientId, [callback], [READ, CREATE]]
    );
  }
  // The foreign keys the GC and the webhook binding rely on (0305, 0335);
  // the harness DDL above declares none.
  await q(
    `alter table grants add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
  await q(
    `alter table webhook_subscriptions add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
  await h.client!.exec(`
    alter table webhook_subscriptions alter column id set default gen_random_uuid();
    alter table webhook_subscriptions alter column created_at set default now();
    alter table webhook_subscriptions alter column active set default true;
  `);
  h.admins.add(ADMIN);
}, 120_000);

beforeEach(async () => {
  // Every test starts with the pod's default policy (unverified apps allowed).
  await q(`delete from pod_settings`);
});

const ctxOf = (userId: string, agentUserId?: string) =>
  ({
    authenticated: true,
    userId,
    session: { id: "s" },
    ...(agentUserId ? { agentUserId } : {}),
  }) as never;
const caller = (userId: string, agentUserId?: string) =>
  appsRouter.createCaller(ctxOf(userId, agentUserId));

type Pair = { permission: string; workspaceId: string };

function authorizeParams(clientId: string, redirectUri: string) {
  return {
    clientId,
    redirectUri,
    responseType: "code",
    scope: `${READ} ${CREATE}`,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    state: "st",
  };
}

async function consent(
  approved: Pair[],
  opts: { clientId?: string; redirectUri?: string; userId?: string } = {}
): Promise<string> {
  const userId = opts.userId ?? OWNER;
  const { redirectTo } = await decideOAuthAuthorization(
    {
      ...authorizeParams(
        opts.clientId ?? STUDIO,
        opts.redirectUri ?? STUDIO_CB
      ),
      approve: true,
      approved,
    },
    userId,
    ctxOf(userId)
  );
  return new URL(redirectTo).searchParams.get("code")!;
}

async function tokenRequest(
  params: Record<string, string>
): Promise<{ status: number; body: any }> {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

const exchange = (code: string, clientId = STUDIO, redirectUri = STUDIO_CB) =>
  tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: VERIFIER,
  });

async function connect(
  approved: Pair[],
  opts: { clientId?: string; redirectUri?: string; userId?: string } = {}
): Promise<{ access: string; refresh: string }> {
  const code = await consent(approved, opts);
  const { status, body } = await exchange(
    code,
    opts.clientId ?? STUDIO,
    opts.redirectUri ?? STUDIO_CB
  );
  expect(status).toBe(200);
  return { access: body.access_token, refresh: body.refresh_token };
}

const refresh = (refreshToken: string, clientId = STUDIO) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

const valid = async (token: string) =>
  (await apiKeyService.validateApiKey(token)) !== null;

const keyIdOf = async (token: string) =>
  (await apiKeyService.validateApiKey(token))!.id;

const connection = async (clientId = STUDIO, owner = OWNER) =>
  (
    await q<{
      id: string;
      public_id: string;
      agent_user_id: string;
      approved_requests: Pair[] | null;
    }>(
      `select id, public_id, agent_user_id, approved_requests from apps
        where owner_user_id = $1 and oauth_client_id = $2`,
      [owner, clientId]
    )
  )[0]!;

const liveGrantSpaces = async (keyId: string) =>
  (
    await q<{ workspace_ids: string[]; permissions: string[] }>(
      `select workspace_ids, permissions from grants
        where api_key_id = $1 and revoked_at is null order by workspace_ids`,
      [keyId]
    )
  ).map((g) => ({ spaces: g.workspace_ids, permissions: g.permissions }));

const memberships = async (userId: string) =>
  (
    await q<{ workspace_id: string; role: string }>(
      `select workspace_id, role from workspace_members where user_id = $1 order by workspace_id`,
      [userId]
    )
  ).map((m) => `${m.workspace_id}:${m.role}`);

/** The hub auth door, as far as these routes read it: the bearer → its key. */
function hubApp(register: (app: HubHono) => void): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    const rec = bearer ? await apiKeyService.validateApiKey(bearer) : null;
    if (!rec) return c.json({ error: "Unauthenticated" }, 401);
    c.set("userId", rec.linkedUserId ?? rec.userId);
    if (rec.linkedUserId) c.set("agentUserId", rec.userId);
    c.set("apiKeyId", rec.id);
    c.set("scopes", rec.scope ?? []);
    await next();
    return undefined;
  });
  register(app);
  return app;
}

/** A signed-in person at the Hub door (`X-Session-Token`): no key, no agent. */
function sessionApp(register: (app: HubHono) => void, userId: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  register(app);
  return app;
}

const createWebhook = (token: string, url: string) =>
  hubApp(registerWebhooksRoutes).request("/webhooks", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ url, eventTypes: ["entity.created"] }),
  });

describe("N — narrow without a new consent", () => {
  it("narrowing a space away stops the live token now; the next refresh is the narrower key", async () => {
    const { access, refresh: rt } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: CREATE, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    const app = await connection();
    expect((await memberships(app.agent_user_id)).sort()).toEqual(
      [`${BRAND}:editor`, `${SHARED}:viewer`].sort()
    );

    const narrowed = await caller(OWNER).narrow({
      publicId: app.public_id,
      approved: [{ permission: READ, workspaceId: BRAND }],
    });
    expect(narrowed.approved_requests).toEqual([
      { permission: READ, workspaceId: BRAND },
    ]);
    // The live key shrinks NOW: the token the app holds is refused.
    expect(await valid(access)).toBe(false);
    // The agent left the space it lost, and is a viewer where it only reads.
    expect(await memberships(app.agent_user_id)).toEqual([`${BRAND}:viewer`]);

    // The next refresh mints from the narrowed approval.
    const r = await refresh(rt);
    expect(r.status).toBe(200);
    expect(r.body.synap_grant).toEqual([
      { permission: READ, workspaceId: BRAND, workspaceName: "Brand" },
    ]);
    const keyId = await keyIdOf(r.body.access_token);
    expect(await liveGrantSpaces(keyId)).toEqual([
      { spaces: [BRAND], permissions: [READ] },
    ]);
    const [key] = await q<{ scope: string[] }>(
      `select scope from api_keys where id = $1`,
      [keyId]
    );
    expect(key!.scope).toEqual(["hub-protocol.read"]);
  });

  it("can only take access away: a pair not approved is refused, nothing changes", async () => {
    const app = await connection();
    await expect(
      caller(OWNER).narrow({
        publicId: app.public_id,
        approved: [
          { permission: READ, workspaceId: BRAND },
          { permission: CREATE, workspaceId: BRAND },
        ],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await connection()).approved_requests).toEqual([
      { permission: READ, workspaceId: BRAND },
    ]);
  });

  it("an agent's credential cannot narrow (nor anyone but the owner)", async () => {
    const { access } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    const app = await connection();
    await expect(
      caller(OWNER, SOME_AGENT).narrow({
        publicId: app.public_id,
        approved: [{ permission: READ, workspaceId: BRAND }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(MEMBER).narrow({
        publicId: app.public_id,
        approved: [{ permission: READ, workspaceId: BRAND }],
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await connection()).approved_requests).toHaveLength(2);
    expect(await valid(access)).toBe(true);
  });

  it("the Hub door (the browser's settings): the person narrows; the app's own token cannot", async () => {
    const { access } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    const app = await connection();
    const narrow = (hub: HubHono, headers: Record<string, string> = {}) =>
      hub.request(`/apps/${app.public_id}/narrow`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          approved: [{ permission: READ, workspaceId: BRAND }],
        }),
      });
    const byApp = await narrow(hubApp(registerAppsRoutes), {
      authorization: `Bearer ${access}`,
    });
    expect(byApp.status).toBe(403);
    expect((await connection()).approved_requests).toHaveLength(2);

    const byPerson = await narrow(sessionApp(registerAppsRoutes, OWNER));
    expect(byPerson.status).toBe(200);
    expect(((await byPerson.json()) as any).app.approved_requests).toEqual([
      { permission: READ, workspaceId: BRAND },
    ]);
    expect(await valid(access)).toBe(false);

    const listed = await sessionApp(registerAppsRoutes, OWNER).request(
      "/pod-apps"
    );
    const row = ((await listed.json()) as any).apps.find(
      (a: any) => a.public_id === app.public_id
    );
    expect(row.pod_app).toMatchObject({
      client_id: STUDIO,
      domain: "studio.example.com",
      verified: false,
      approved: [
        { permission: READ, workspaceId: BRAND, workspaceName: "Brand" },
      ],
    });
  });
});

describe("V — revoke kills keys, refresh families and waiting codes", () => {
  it("after the person revokes: the token is refused, a refresh is invalid_grant, a waiting code mints nothing", async () => {
    const opts = { clientId: NOTES, redirectUri: NOTES_CB };
    const { access, refresh: rt } = await connect(
      [{ permission: READ, workspaceId: BRAND }],
      opts
    );
    // A second consent leaves a code waiting (never exchanged yet).
    const waiting = await consent(
      [{ permission: READ, workspaceId: BRAND }],
      opts
    );
    const app = await connection(NOTES);
    await caller(OWNER).revoke({ publicId: app.public_id });

    expect(await valid(access)).toBe(false);
    const r = await refresh(rt, NOTES);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    const live = await q<{ id: string }>(
      `select id from oauth_refresh_tokens where app_id = $1 and revoked_at is null`,
      [app.id]
    );
    expect(live).toEqual([]);
    // The waiting code is burned at the row (I6), not only refused later by
    // the revoked app: /token's own app check must not be the only guard.
    const unburned = await q<{ code_hash: string }>(
      `select code_hash from oauth_authorization_codes where app_id = $1 and consumed_at is null`,
      [app.id]
    );
    expect(unburned).toEqual([]);
    const code = await exchange(waiting, NOTES, NOTES_CB);
    expect(code.status).toBe(400);
    expect(code.body.access_token).toBeUndefined();
    const liveKeys = await q<{ id: string }>(
      `select id from api_keys where user_id = $1 and is_active = true`,
      [app.agent_user_id]
    );
    expect(liveKeys).toEqual([]);
    expect(await memberships(app.agent_user_id)).toEqual([]);
  });
});

describe("P — the pod admin's switch for unverified apps (F4)", () => {
  const authorize = (clientId: string, redirectUri: string) =>
    oauthApp.request(
      `/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: READ,
        state: "st",
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
      }).toString()}`
    );

  it("off: /authorize, the consent context and the Allow click refuse an unverified app; a Synap app connects", async () => {
    const policy = await caller(ADMIN).adminSetPolicy({
      allowUnverified: false,
    });
    expect(policy).toMatchObject({ allowUnverified: false, changedBy: ADMIN });

    const res = await authorize(STUDIO, STUDIO_CB);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toMatch(/turned off apps that are not Synap apps/);
    await expect(
      getOAuthConsentContext(authorizeParams(STUDIO, STUDIO_CB), OWNER)
    ).rejects.toThrow(/turned off apps that are not Synap apps/);
    const codesBefore = await q(
      `select code_hash from oauth_authorization_codes`
    );
    await expect(
      consent([{ permission: READ, workspaceId: BRAND }])
    ).rejects.toThrow(/turned off apps that are not Synap apps/);
    expect(
      await q(`select code_hash from oauth_authorization_codes`)
    ).toHaveLength(codesBefore.length);

    const synap = await authorize(SYNAP_APP, SYNAP_CB);
    expect(synap.status).toBe(302);
  });

  it("on again (or never set): the same app reaches the consent screen", async () => {
    expect((await caller(ADMIN).adminPolicy()).allowUnverified).toBe(true);
    const res = await authorize(STUDIO, STUDIO_CB);
    expect(res.status).toBe(302);
  });
});

describe("A — the admin-only doors", () => {
  it("refuse a member and an agent's credential acting for the admin", async () => {
    for (const c of [caller(MEMBER), caller(ADMIN, SOME_AGENT)]) {
      await expect(c.adminPolicy()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        c.adminSetPolicy({ allowUnverified: false })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.adminPodApps()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(
        c.adminRevokeClient({ clientId: STUDIO })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await caller(ADMIN).adminPolicy()).allowUnverified).toBe(true);
  });

  it("the admin sees each app once with its members, and can end it for everyone", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const member = await connect([{ permission: READ, workspaceId: BRAND }], {
      userId: MEMBER,
    });
    const groups = await caller(ADMIN).adminPodApps();
    const studio = groups.find((g) => g.client_id === STUDIO)!;
    expect(studio).toMatchObject({
      domain: "studio.example.com",
      verified: false,
      live: 2,
    });
    expect(
      studio.members
        .filter((m) => !m.revoked_at)
        .map((m) => m.owner?.id)
        .sort()
    ).toEqual([MEMBER, OWNER].sort());

    const { revoked } = await caller(ADMIN).adminRevokeClient({
      clientId: STUDIO,
    });
    expect(revoked).toBe(2);
    expect(await valid(member.access)).toBe(false);
    const after = (await caller(ADMIN).adminPodApps()).find(
      (g) => g.client_id === STUDIO
    )!;
    expect(after.live).toBe(0);
  });
});

describe("W — a pod app's webhook follows its connection", () => {
  it("only to its own site; survives every rotation and the GC; dies on revoke", async () => {
    const { access, refresh: rt } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: CREATE, workspaceId: BRAND },
    ]);
    const elsewhere = await createWebhook(access, "https://evil.example/hook");
    expect(elsewhere.status).toBe(403);

    const created = await createWebhook(
      access,
      "https://studio.example.com/api/synap/webhook"
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const row = async () =>
      (
        await q<{ api_key_id: string }>(
          `select api_key_id from webhook_subscriptions where id = $1`,
          [id]
        )
      )[0];
    expect((await row())!.api_key_id).toBe(await keyIdOf(access));

    // Four rotations: past the GC's two kept dead keys.
    let token = rt;
    let current = access;
    for (let i = 0; i < 4; i++) {
      const r = await refresh(token);
      expect(r.status).toBe(200);
      token = r.body.refresh_token;
      current = r.body.access_token;
    }
    const kept = await row();
    expect(kept).toBeDefined();
    const currentKey = await keyIdOf(current);
    expect(kept!.api_key_id).toBe(currentKey);
    expect(await liveApiKeyIds([kept!.api_key_id])).toEqual(
      new Set([currentKey])
    );

    const app = await connection();
    await caller(OWNER).revoke({ publicId: app.public_id });
    expect(await row()).toBeUndefined();
  });
});

describe("M — 'apply automatically' is the owner's, after connecting", () => {
  it("starts off; an agent cannot flip it at the app's door nor the generic one; the owner can; revoke resets it", async () => {
    const { access } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: CREATE, workspaceId: BRAND },
    ]);
    const app = await connection();
    const posture = async () =>
      (await readAgentGovernance({
        db: h.db as never,
        agentUserId: app.agent_user_id,
      }))!.posture;

    // Never set at consent.
    const [listed] = (await caller(OWNER).list()).filter(
      (a) => a.public_id === app.public_id
    );
    expect(listed!.pod_app).toMatchObject({
      domain: "studio.example.com",
      verified: false,
      write_mode: { applyAutomatically: false, writeMode: "ask-first" },
    });
    expect(await posture()).toBe("ask-first");

    // An agent acting for the owner, at the app's door…
    await expect(
      caller(OWNER, SOME_AGENT).setWriteMode({
        publicId: app.public_id,
        applyAutomatically: true,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // …and at the generic agent-governance door, which its creator check
    // would otherwise pass as the owner (posture null = follow the pod default).
    const generic = new OpenAPIHono<{ Variables: HubVariables }>() as HubHono;
    generic.use("*", async (c, next) => {
      c.set("userId", OWNER);
      c.set("agentUserId", SOME_AGENT);
      c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
      await next();
    });
    registerAgentUsersRoutes(generic);
    const patched = await generic.request(
      `/agent-users/${app.agent_user_id}/governance`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture: null }),
      }
    );
    expect(patched.status).toBe(403);
    expect(await posture()).toBe("ask-first");
    // A scoped key the owner holds — a "Sign in with Synap" token is one — is
    // the owner within a grant only: it cannot flip the app's AI there either.
    const scopedDoor = new OpenAPIHono<{
      Variables: HubVariables;
    }>() as HubHono;
    scopedDoor.use("*", async (c, next) => {
      c.set("userId", OWNER);
      c.set("keyType", "app_person");
      c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
      await runWithGrant(
        {
          scopes: [{ permissions: [READ, CREATE], workspaceIds: [BRAND] }],
          clientId: null,
        },
        () => next()
      );
    });
    registerAgentUsersRoutes(scopedDoor);
    const scopedPatch = await scopedDoor.request(
      `/agent-users/${app.agent_user_id}/governance`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture: null }),
      }
    );
    expect(scopedPatch.status).toBe(403);
    expect(((await scopedPatch.json()) as { error: string }).error).toMatch(
      /scoped key/
    );
    expect(await posture()).toBe("ask-first");
    // The app's own token cannot either.
    const own = await hubApp(registerAppsRoutes).request(
      `/apps/${app.public_id}/write-mode`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applyAutomatically: true }),
      }
    );
    expect(own.status).toBe(403);
    expect(await posture()).toBe("ask-first");

    // The owner, signed in as themselves.
    const on = await caller(OWNER).setWriteMode({
      publicId: app.public_id,
      applyAutomatically: true,
    });
    expect(on.applyAutomatically).toBe(true);
    expect(await posture()).toBeNull();

    // Revoke ends the choice: a reconnect starts at ask-first again.
    await caller(OWNER).revoke({ publicId: app.public_id });
    expect(await posture()).toBe("ask-first");
  });
});

describe("S7 — the pod app lists cost a fixed number of queries", () => {
  /** Every pod app row, and podAppViews over them with its query count. */
  async function views() {
    const rows = (
      await new AppRepository(h.db as never).listAll({ includeRevoked: true })
    ).filter((r) => r.app.mode === "oauth" && r.app.oauthClientId);
    const spy = vi.spyOn(
      h.client as unknown as { query: (...a: unknown[]) => unknown },
      "query"
    );
    try {
      const out = await podAppViews(rows, new Map());
      return { rows, out, queries: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }
  const newestConsent = async (appId: string) =>
    (
      await q<{ at: Date }>(
        `select max(created_at) as at from proposals
          where target_type = 'app' and proposal_type = 'connect'
            and status = 'approved' and target_id = $1`,
        [appId]
      )
    )[0]!.at;

  it("one pod app or three: the same queries; write mode and connected_at stay each row's own", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const one = await views();
    expect(one.rows.length).toBeGreaterThan(0);

    // MEMBER has no connection of these two yet (one row per person and
    // app): two new rows.
    await connect([{ permission: READ, workspaceId: BRAND }], {
      clientId: NOTES,
      redirectUri: NOTES_CB,
      userId: MEMBER,
    });
    await connect([{ permission: READ, workspaceId: BRAND }], {
      clientId: SYNAP_APP,
      redirectUri: SYNAP_CB,
      userId: MEMBER,
    });
    // A second consent of the same app: connected_at is the newest one.
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const notes = (await caller(MEMBER).list()).find(
      (a) => a.pod_app?.client_id === NOTES
    )!;
    await caller(MEMBER).setWriteMode({
      publicId: notes.public_id,
      applyAutomatically: true,
    });

    const three = await views();
    expect(three.rows.length).toBeGreaterThanOrEqual(one.rows.length + 2);
    expect(three.queries).toBe(one.queries);

    for (const row of three.rows) {
      const view = three.out.get(row.app.publicId)!;
      expect(view.write_mode.applyAutomatically).toBe(
        row.app.publicId === notes.public_id && !row.app.revokedAt
      );
      const newest = await newestConsent(row.app.id);
      expect(view.connected_at?.getTime() ?? null).toBe(
        newest ? new Date(newest).getTime() : null
      );
    }
  });
});
