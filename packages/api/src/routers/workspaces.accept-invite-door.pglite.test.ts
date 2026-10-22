/**
 * ONE accept door (`acceptInviteFor`): the console's "Create account and join"
 * (`POST /api/hub/setup/accept-invite`) gives the same access, with the same
 * side effects, as a signed-in `workspaces.acceptInvite`.
 *
 * Before the door, the REST path wrote bare `workspace_members` rows: no
 * audit line, no `pod_members` row, and the CP's invite row was never told the
 * invite was accepted (it stayed pending for the inviter, forever).
 *
 * Driven through the REAL route / procedure → REAL `acceptInviteFor` → REAL SQL
 * on PGlite. Stubbed: Kratos admin (account creation), the CP (`fetch`, to
 * OBSERVE the lifecycle call), the event log, and `auditLog` (to OBSERVE the
 * audit line: its writer is a raw postgres client this file cannot reach).
 *
 * Also pinned (console-security #72, kept by the door): a pod invite never
 * fans out into a system space (pod-admin).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  audits: [] as Array<Record<string, unknown>>,
  nextIdentity: "",
  cpPrincipal: null as null | { sub: string; email: string; type: string },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const call = (fn: unknown, ...args: unknown[]) =>
    (fn as (...a: unknown[]) => Promise<unknown>)(...args);
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    ensureTeamPersonForMember: async () => undefined,
    podCpAuthHeaders: async () => ({
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod-signed" },
      bearer: "pod-signed",
    }),
    // The REAL helpers, on this PGlite: their default connection is the
    // package's own client, which the export swap above does not reach.
    recordInviteAcceptance: (invite: unknown, userId: string) =>
      call(actual.recordInviteAcceptance, invite, userId, h.db),
    listPodInviteFanOutWorkspaceIds: () =>
      call(actual.listPodInviteFanOutWorkspaceIds, h.db),
  };
});

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  kratosAdmin: {
    createIdentity: vi.fn(async () => ({ data: { id: h.nextIdentity } })),
    deleteIdentity: vi.fn(async () => ({})),
  },
}));

// The CP's signature is not what is under test: the CP "vouches" for
// `h.cpPrincipal`, exactly as a verified invite-accept token would.
vi.mock("../utils/jwks-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyCpJwt: vi.fn(async () => h.cpPrincipal),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return null;
  }),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { config } from "@synap-core/core";
import {
  workspaces,
  workspaceMembers,
  users,
  invites,
  inviteAcceptances,
  podMembers,
  syncGeneration,
} from "@synap/database/schema";
import { registerSetupRoutes } from "./hub-protocol/rest/setup.js";
import { workspacesRouter } from "./workspaces.js";

const OWNER = "owner-1";
const STUDIO = randomUUID();
const PLAZA = randomUUID();
const POD_ADMIN = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const dflt =
      c.name === "id" && type === "uuid" ? " default gen_random_uuid()" : "";
    const now =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    return `"${c.name}" ${type}${dflt}${now}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const owner = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: STUDIO,
    workspaceRole: "owner",
  } as never);

const lifecycleCalls = () =>
  (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>)
    .filter(([url]) => String(url).endsWith("/internal/invites/lifecycle"))
    .map(([, init]) => JSON.parse(String(init.body)));

async function createAccountAndJoin(token: string, email: string) {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request("/setup/accept-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "a-long-password",
      inviteToken: token,
    }),
  });
}

const rowsOf = async (sql: string, params: unknown[]) =>
  (await h.client!.query<Record<string, unknown>>(sql, params)).rows;

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    users,
    invites,
    inviteAcceptances,
    podMembers,
    syncGeneration,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.exec(
    `create unique index on invite_acceptances (invite_id);`
  );
  await h.client!.exec(`create unique index on pod_members (user_id);`);
  for (const [id, name, slug] of [
    [STUDIO, "Studio", null],
    [PLAZA, "Plaza", null],
    [POD_ADMIN, "Pod admin", "pod-admin"],
  ])
    await h.client!.query(
      `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
       values ($1, $2, $3, '{}'::jsonb, $4, now(), now())`,
      [id, name, OWNER, slug]
    );
  for (const ws of [STUDIO, PLAZA, POD_ADMIN])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, OWNER]
    );
  await h.client!.query(
    `insert into users (id, email, name) values ($1, 'alice@example.com', 'Alice')`,
    [OWNER]
  );
  await h.client!.query(
    `insert into pod_members (id, user_id, pod_role) values ($1, $2, 'owner')`,
    [randomUUID(), OWNER]
  );
});

beforeEach(() => {
  (config.server as { controlPlaneUrl?: string }).controlPlaneUrl =
    "https://cp.test";
  h.audits = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ sent: true, ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    )
  );
});

describe("Create account and join goes through the one accept door", () => {
  it("a workspace invite: member, audit line, CP told accepted, invite spent", async () => {
    const created = await owner().createInvite({
      type: "workspace",
      workspaceId: STUDIO,
      email: "bob@example.com",
      role: "editor",
    });
    h.nextIdentity = "bob-1";

    const res = await createAccountAndJoin(created.token, "bob@example.com");
    expect(res.status).toBe(200);

    expect(
      await rowsOf(
        `select role from workspace_members where workspace_id = $1 and user_id = $2`,
        [STUDIO, "bob-1"]
      )
    ).toEqual([{ role: "editor" }]);
    expect(h.audits).toEqual([
      expect.objectContaining({
        subjectType: "workspaceMember",
        action: "add",
        userId: "bob-1",
        workspaceId: STUDIO,
      }),
    ]);
    await vi.waitFor(() =>
      expect(lifecycleCalls()).toEqual([
        expect.objectContaining({
          inviteToken: created.token,
          event: "accepted",
          actorUserId: "bob-1",
        }),
      ])
    );
    expect(
      await rowsOf(`select id from invites where id = $1`, [created.id])
    ).toEqual([]);
  });

  it("a pod invite: pod member, every ORDINARY space, never pod-admin, CP told", async () => {
    const created = await owner().createInvite({
      type: "pod",
      email: "carol@example.com",
      role: "admin",
    });
    h.nextIdentity = "carol-1";

    const res = await createAccountAndJoin(created.token, "carol@example.com");
    expect(res.status).toBe(200);

    const spaces = (
      await rowsOf(
        `select workspace_id from workspace_members where user_id = $1 order by workspace_id`,
        ["carol-1"]
      )
    ).map((r) => r.workspace_id);
    expect(spaces.sort()).toEqual([STUDIO, PLAZA].sort());
    expect(
      await rowsOf(`select pod_role from pod_members where user_id = $1`, [
        "carol-1",
      ])
    ).toEqual([{ pod_role: "member" }]);
    expect(h.audits).toHaveLength(2);
    await vi.waitFor(() =>
      expect(lifecycleCalls()).toEqual([
        expect.objectContaining({
          inviteToken: created.token,
          event: "accepted",
        }),
      ])
    );
  });

  it("parity: a signed-in acceptInvite makes the same audit line and CP call", async () => {
    await h.client!.query(
      `insert into users (id, email, name) values ('dan-1', 'dan@example.com', 'Dan')`
    );
    const created = await owner().createInvite({
      type: "workspace",
      workspaceId: PLAZA,
      email: "dan@example.com",
      role: "viewer",
    });
    const dan = workspacesRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: "dan-1",
      workspaceId: PLAZA,
    } as never);
    await expect(dan.acceptInvite({ token: created.token })).resolves.toEqual({
      status: "accepted",
      type: "workspace",
      workspaceId: PLAZA,
    });
    expect(h.audits).toEqual([
      expect.objectContaining({ userId: "dan-1", workspaceId: PLAZA }),
    ]);
    await vi.waitFor(() =>
      expect(lifecycleCalls()).toEqual([
        expect.objectContaining({
          inviteToken: created.token,
          event: "accepted",
        }),
      ])
    );
  });

  it("parity: an accept the CP vouches for (acceptInviteViaCp) takes the same door", async () => {
    await h.client!.query(
      `insert into users (id, email, name) values ('erin-1', 'erin@example.com', 'Erin')`
    );
    const created = await owner().createInvite({
      type: "pod",
      email: "erin@example.com",
      role: "editor",
    });
    h.cpPrincipal = {
      sub: "cp-erin",
      email: "erin@example.com",
      type: "invite-accept",
    };
    const anonymous = workspacesRouter.createCaller({
      db: h.db,
      authenticated: false,
    } as never);
    await expect(
      anonymous.acceptInviteViaCp({ token: created.token, cpToken: "signed" })
    ).resolves.toEqual({
      status: "accepted",
      type: "pod",
      workspacesJoined: 2,
    });

    expect(
      await rowsOf(`select pod_role from pod_members where user_id = $1`, [
        "erin-1",
      ])
    ).toEqual([{ pod_role: "member" }]);
    expect(
      (
        await rowsOf(
          `select workspace_id from workspace_members where user_id = $1`,
          ["erin-1"]
        )
      )
        .map((r) => r.workspace_id)
        .sort()
    ).toEqual([STUDIO, PLAZA].sort());
    expect(h.audits).toEqual([
      expect.objectContaining({
        userId: "erin-1",
        data: expect.objectContaining({ source: "cp-proxy" }),
      }),
      expect.objectContaining({
        userId: "erin-1",
        data: expect.objectContaining({ source: "cp-proxy" }),
      }),
    ]);
    await vi.waitFor(() =>
      expect(lifecycleCalls()).toEqual([
        expect.objectContaining({
          inviteToken: created.token,
          event: "accepted",
        }),
      ])
    );
  });
});
