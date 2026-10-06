/**
 * grantRoles — a person's reusable permission lists, and the lineage a key
 * minted from one carries.
 *
 * Through the REAL procedures on PGlite (every @synap/database table). Stubbed:
 * the db handle, the key event spine, and the governance gate (a human minting
 * their own key is granted; the gate ladder is pinned elsewhere).
 *
 * Pinned: CRUD round-trips the `GrantRole` shape (lifetime: days / never /
 * none); another person can neither see nor change a role; an AGENT key is
 * refused on every write; a malformed pattern stores nothing; a key minted
 * with `roleId` records the lineage, and someone else's role id mints no
 * usable key.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";

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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantRolesRouter } from "./grant-roles.js";
import { apiKeysRouter } from "./api-keys.js";

const ALICE = "alice-roles";
const BOB = "bob-roles";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "usage_count"
        ? " default 0"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "is_active"
            ? " default true"
            : c.name === "never_expires"
              ? " default false"
              : c.name === "description" && cfg.name === "grant_roles"
                ? " default ''"
                : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const roles = (userId: string, agentUserId?: string) =>
  grantRolesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    ...(agentUserId ? { agentUserId, apiKeyId: "k" } : {}),
  } as never);

const keys = (userId: string) =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
  } as never);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
}, 120_000);

describe("grantRoles — a person's reusable permission lists", () => {
  it("creates, lists and updates a role in the GrantRole shape", async () => {
    const made = await roles(ALICE).create({
      name: "Portfolio site",
      description: "Reads portfolio items",
      grant: { permissions: ["entity.portfolio.read"], expiresInDays: 30 },
    });
    expect(made).toMatchObject({
      name: "Portfolio site",
      stored: true,
      grant: { permissions: ["entity.portfolio.read"], expiresInDays: 30 },
    });

    const never = await roles(ALICE).create({
      name: "Forever reader",
      grant: { permissions: ["entity.*.read"], expiresInDays: null },
    });
    expect(
      (never.grant as { expiresInDays?: number | null }).expiresInDays
    ).toBeNull();
    const none = await roles(ALICE).create({
      name: "No lifetime",
      grant: { permissions: ["document.read"] },
    });
    expect("expiresInDays" in none.grant).toBe(false);

    const updated = await roles(ALICE).update({
      id: made.id,
      name: "Portfolio site",
      grant: { permissions: ["entity.portfolio.read", "document.read"] },
    });
    expect(updated.grant.permissions).toEqual([
      "entity.portfolio.read",
      "document.read",
    ]);
    expect((await roles(ALICE).list()).map((r) => r.name)).toEqual([
      "Forever reader",
      "No lifetime",
      "Portfolio site",
    ]);
  });

  it("another person neither sees nor changes it", async () => {
    const [mine] = await roles(ALICE).list();
    expect(await roles(BOB).list()).toEqual([]);
    await expect(
      roles(BOB).update({
        id: mine.id,
        name: "hijack",
        grant: { permissions: ["*"] },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(roles(BOB).archive({ id: mine.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("an agent key reads its human's roles but writes none", async () => {
    const agent = roles(ALICE, "agent-of-alice");
    expect((await agent.list()).length).toBeGreaterThan(0);
    const [mine] = await agent.list();
    await expect(
      agent.create({ name: "x", grant: { permissions: ["*"] } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      agent.update({ id: mine.id, name: "x", grant: { permissions: ["*"] } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(agent.archive({ id: mine.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a malformed pattern and stores nothing", async () => {
    const before = (await roles(ALICE).list()).length;
    await expect(
      roles(ALICE).create({
        name: "bad",
        grant: { permissions: ["Entity..read"] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await roles(ALICE).list()).length).toBe(before);
  });

  it("archives a role", async () => {
    const r = await roles(ALICE).create({
      name: "Temp",
      grant: { permissions: ["view.read"] },
    });
    await roles(ALICE).archive({ id: r.id });
    expect((await roles(ALICE).list()).some((x) => x.id === r.id)).toBe(false);
  });
});

describe("a key minted from a role records its lineage", () => {
  it("stamps grants.role_id for the person's own role", async () => {
    const role = await roles(ALICE).create({
      name: "Card site",
      grant: { permissions: ["entity.person.read"] },
    });
    const key = await keys(ALICE).create({
      keyName: "card",
      scope: ["hub-protocol.read"],
      grant: { permissions: ["entity.person.read"], roleId: role.id },
    });
    const { rows } = await h.client!.query<{ role_id: string }>(
      `select role_id from grants where api_key_id = $1`,
      [key.id]
    );
    expect(rows).toEqual([{ role_id: role.id }]);
  });

  it("someone else's role id leaves no usable key", async () => {
    const [aliceRole] = await roles(ALICE).list();
    const before = (
      await h.client!.query<{ id: string }>(`select id from api_keys`)
    ).rows.map((r) => r.id);
    await expect(
      keys(BOB).create({
        keyName: "borrowed",
        scope: ["hub-protocol.read"],
        grant: { permissions: ["entity.read"], roleId: aliceRole.id },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const fresh = (
      await h.client!.query<{ id: string; is_active: boolean }>(
        `select id, is_active from api_keys`
      )
    ).rows.filter((r) => !before.includes(r.id));
    expect(fresh.every((r) => r.is_active === false)).toBe(true);
  });
});
