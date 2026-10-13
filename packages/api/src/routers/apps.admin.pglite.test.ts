/**
 * `apps.admin*` — the console's door to EVERY member's apps, through the REAL
 * router on PGlite (every @synap/database table). The app is made the way one
 * is made: register → approval recorded → `issueKey` (its own agent, its key,
 * one grant per approved space).
 *
 * Pinned:
 *   - adminList / adminGet: a pod admin reads a MEMBER's app with its owner,
 *     its keys, its last use and the NAMES of the spaces it reaches (the admin
 *     is a member of none of them); a member is refused (FORBIDDEN);
 *   - adminRevoke: the SAME service as the owner's revoke — key off, reach
 *     dropped, event named after the admin — while the member's self-scoped
 *     `revoke` of someone else's app still answers NOT_FOUND;
 *   - adminRemove: refuses a live app (CONFLICT), hides a revoked one from
 *     every listing.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  // The real repository also emits through the postgres-js `sql` client,
  // which this harness has not; the key row lands in PGlite unchanged.
  class PgliteApiKeyRepository {
    async create(input: Record<string, unknown>) {
      const [row] = await (h.db as any)
        .insert(schema.apiKeys)
        .values({
          keyName: input.keyName,
          keyPrefix: input.keyPrefix,
          keyHash: "hash",
          scope: input.scope,
          userId: input.userId,
          linkedUserId: input.linkedUserId ?? null,
          keyType: input.keyType,
          isActive: true,
        })
        .returning();
      return row;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    ApiKeyRepository: PgliteApiKeyRepository,
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { AppRepository } from "@synap/database";
import { issueKey } from "../services/app-connect.js";
import { appsRouter } from "./apps.js";

const ADMIN = "human-admin";
const MEMBER = "human-member";
const SALES = randomUUID();

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

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const caller = (userId: string) =>
  appsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
  } as never);

let publicId = "";

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  h.admins.add(ADMIN);
  for (const [id, name] of [
    [ADMIN, "Ada Admin"],
    [MEMBER, "Marie Member"],
  ])
    await q(
      `insert into users (id, email, name, user_type) values ($1, $1 || '@x', $2, 'human')`,
      [id, name]
    );
  // The member's space — the admin is NOT a member of it.
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Sales', $2)`,
    [SALES, MEMBER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), SALES, MEMBER]
  );
  const repo = new AppRepository(h.db as never);
  const app = await repo.register({ ownerUserId: MEMBER, name: "Acme CRM" });
  await repo.setApprovedRequests(app.id, [
    { permission: "entity.person.read", workspaceId: SALES },
  ]);
  publicId = app.publicId;
  await issueKey({ publicId, ownerUserId: MEMBER, via: "ui" });
  await q(`update api_keys set last_used_at = '2026-10-01T10:00:00Z'`);
}, 120_000);

describe("apps.adminList / adminGet", () => {
  it("a pod admin reads a member's app with its owner, keys, reach and space names", async () => {
    const list = await caller(ADMIN).adminList();
    expect(list).toHaveLength(1);
    const [app] = list;
    expect(app).toMatchObject({
      public_id: publicId,
      name: "Acme CRM",
      owner: { id: MEMBER, name: "Marie Member" },
      workspace_names: { [SALES]: "Sales" },
    });
    expect(app!.keys).toHaveLength(1);
    expect(app!.keys[0]!.isActive).toBe(true);
    expect(app!.grants.flatMap((g) => g.workspaceIds ?? [])).toEqual([SALES]);
    expect(new Date(app!.last_used_at!).toISOString()).toBe(
      "2026-10-01T10:00:00.000Z"
    );
    const one = await caller(ADMIN).adminGet({ publicId });
    expect(one.owner?.name).toBe("Marie Member");
  });

  it("a member is refused, even for their own app", async () => {
    await expect(caller(MEMBER).adminList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller(MEMBER).adminGet({ publicId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("an unknown app is NOT_FOUND", async () => {
    await expect(
      caller(ADMIN).adminGet({ publicId: "app_missing" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("apps.adminRevoke / adminRemove", () => {
  it("a member cannot end someone else's app through either door", async () => {
    await expect(
      caller(MEMBER).adminRevoke({ publicId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The self-scoped door stays floored on the owner: the admin is not it.
    await expect(caller(ADMIN).revoke({ publicId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("removing a LIVE app is a CONFLICT — revoke first", async () => {
    await expect(caller(ADMIN).adminRemove({ publicId })).rejects.toMatchObject(
      { code: "CONFLICT" }
    );
  });

  it("an admin revokes a member's app: key off, reach dropped, still listed as revoked", async () => {
    expect(await caller(ADMIN).adminRevoke({ publicId })).toEqual({
      revoked: true,
      publicId,
    });
    const [app] = await caller(ADMIN).adminList();
    expect(app!.revoked_at).not.toBeNull();
    expect(app!.grants).toEqual([]);
    expect(app!.keys.every((k) => !k.isActive)).toBe(true);
    const keys = await q<{ revoked_by: string }>(
      `select revoked_by from api_keys`
    );
    expect(keys.map((k) => k.revoked_by)).toEqual([ADMIN]);
    // The app's agent left every space: a revoked app reaches nothing.
    const memberships = await q(
      `select 1 from workspace_members wm join apps a on a.agent_user_id = wm.user_id`
    );
    expect(memberships).toEqual([]);
    // The owner's own list reads the same revocation.
    expect(
      (await caller(MEMBER).list({ includeRevoked: true }))[0]!.revoked_at
    ).not.toBeNull();
  });

  it("an admin removes the revoked app for good: no listing shows it", async () => {
    await caller(ADMIN).adminRemove({ publicId });
    expect(await caller(ADMIN).adminList()).toEqual([]);
    expect(await caller(MEMBER).list({ includeRevoked: true })).toEqual([]);
  });
});
