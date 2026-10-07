/**
 * W1f — `apiKeys.create` mints a key WITH a grant, and the lifetime is
 * 90 days by default, any custom number of days, or never.
 *
 * Through the REAL procedure on PGlite (every @synap/database table). Stubbed:
 * the db handle and the governance gate (a human minting their own key is
 * granted; the gate ladder is pinned elsewhere).
 *
 * Pinned: the grant row lands and bounds the key; a malformed pattern mints
 * NOTHING; if the grant cannot be attached the key is REVOKED (it must never
 * survive as a full-access legacy key); expiry default / custom / never.
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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    // The key repository appends a spine event through postgres.js `sql`
    // (not the PGlite handle); the event is not under test here.
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
import { GrantRepository } from "@synap/database";
import { apiKeysRouter } from "./api-keys.js";

const HUMAN = "human-mint";
const DAY = 86_400_000;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "usage_count"
        ? " default 0"
        : c.name === "created_at"
          ? " default now()"
          : c.name === "is_active"
            ? " default true"
            : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const caller = () =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN,
  } as never);

const keyRow = async (id: string) =>
  (
    await h.client!.query<{ expires_at: string | null; is_active: boolean }>(
      `select expires_at, is_active from api_keys where id = $1`,
      [id]
    )
  ).rows[0];

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

describe("apiKeys.create with a grant (W1f)", () => {
  it("attaches the grant to the minted key", async () => {
    const res = await caller().create({
      keyName: "Portfolio site",
      scope: ["hub-protocol.read"],
      grant: {
        permissions: ["entity.portfolio.read", "document.read"],
        label: "Portfolio site",
      },
    });
    expect(res.status).toBe("created");
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      res.id
    );
    expect(grant).toMatchObject({
      permissions: ["entity.portfolio.read", "document.read"],
    });
  });

  it("refuses a malformed pattern and mints nothing", async () => {
    const before = (
      await h.client!.query(`select count(*)::int n from api_keys`)
    ).rows[0];
    await expect(
      caller().create({
        keyName: "bad",
        scope: ["hub-protocol.read"],
        grant: { permissions: ["Entity..read"] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (await h.client!.query(`select count(*)::int n from api_keys`)).rows[0]
    ).toEqual(before);
  });

  it("revokes the key when the grant cannot be attached", async () => {
    const spy = vi
      .spyOn(GrantRepository.prototype, "attach")
      .mockRejectedValueOnce(new Error("db down"));
    const ids = (
      await h.client!.query<{ id: string }>(`select id from api_keys`)
    ).rows.map((r) => r.id);
    await expect(
      caller().create({
        keyName: "will fail",
        scope: ["hub-protocol.read"],
        grant: { permissions: ["entity.read"] },
      })
    ).rejects.toThrow("db down");
    spy.mockRestore();
    const fresh = (
      await h.client!.query<{ id: string; is_active: boolean }>(
        `select id, is_active from api_keys`
      )
    ).rows.filter((r) => !ids.includes(r.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].is_active).toBe(false);
  });
});

describe("key lifetime — 90 days by default, custom, or never", () => {
  it("defaults to 90 days", async () => {
    const res = await caller().create({
      keyName: "d",
      scope: ["hub-protocol.read"],
    });
    const exp = new Date((await keyRow(res.id)).expires_at!).getTime();
    expect(Math.abs(exp - (Date.now() + 90 * DAY))).toBeLessThan(60_000);
  });

  it("honours a custom number of days", async () => {
    const res = await caller().create({
      keyName: "c",
      scope: ["hub-protocol.read"],
      expiresInDays: 7,
    });
    const exp = new Date((await keyRow(res.id)).expires_at!).getTime();
    expect(Math.abs(exp - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
  });

  it("null means never", async () => {
    const res = await caller().create({
      keyName: "n",
      scope: ["hub-protocol.read"],
      expiresInDays: null,
    });
    expect((await keyRow(res.id)).expires_at).toBeNull();
  });
});

describe("apiKeys.list shows each key's grant (/my-connections)", () => {
  it("returns the active grant, and null for an ungranted key", async () => {
    const granted = await caller().create({
      keyName: "Card site",
      scope: ["hub-protocol.read"],
      grant: { permissions: ["entity.person.read"], label: "Card site" },
    });
    const plain = await caller().create({
      keyName: "plain",
      scope: ["hub-protocol.read"],
    });
    const keys = await caller().list();
    expect(keys.find((k) => k.id === granted.id)?.grant).toMatchObject({
      permissions: ["entity.person.read"],
      label: "Card site",
    });
    expect(keys.find((k) => k.id === plain.id)?.grant).toBeNull();
  });
});

describe("apiKeys.createForWorkspace with a grant (W1f)", () => {
  const WS = randomUUID();
  const wsCaller = () =>
    apiKeysRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: HUMAN,
      workspaceId: WS,
    } as never);

  beforeAll(async () => {
    await h.client!.query(
      `insert into workspaces (id, name, owner_id, settings) values ($1, 'w', $2, '{}'::jsonb)`,
      [WS, HUMAN]
    );
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), WS, HUMAN]
    );
  });

  it("pins the grant to the key's workspace and defaults to 90 days", async () => {
    const res = await wsCaller().createForWorkspace({
      name: "ws site",
      scopes: ["hub-protocol.read"],
      grant: { permissions: ["entity.read"] },
    });
    expect(res.status).toBe("created");
    const grant = await new GrantRepository(h.db as never).resolveForKey(
      res.id
    );
    expect(grant).toMatchObject({
      permissions: ["entity.read"],
      workspaceIds: [WS],
    });
    const exp = new Date((await keyRow(res.id)).expires_at!).getTime();
    expect(Math.abs(exp - (Date.now() + 90 * DAY))).toBeLessThan(60_000);
  });

  it("listForWorkspace shows each key's grant (the workspace keys page)", async () => {
    const granted = await wsCaller().createForWorkspace({
      name: "ws granted",
      scopes: ["hub-protocol.read"],
      grant: { permissions: ["entity.person.create"] },
    });
    const plain = await wsCaller().createForWorkspace({
      name: "ws plain",
      scopes: ["hub-protocol.read"],
    });
    const keys = await wsCaller().listForWorkspace();
    expect(keys.find((k) => k.id === granted.id)?.grant).toMatchObject({
      permissions: ["entity.person.create"],
      workspaceIds: [WS],
    });
    expect(keys.find((k) => k.id === plain.id)?.grant).toBeNull();
  });
});
