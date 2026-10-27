/**
 * Keys plan W2 — `apiKeys.create` takes `uses` (where the key is used) and
 * DERIVES its scopes server-side; a space it is made for confines it (D-3).
 *
 * Through the REAL procedure on PGlite (every @synap/database table). Stubbed:
 * the db handle and the governance gate (a human minting their own key is
 * granted; the call is recorded, to read what an approval would replay).
 *
 * Pinned (each rules out a rule):
 *  - a write grant opens each use's write door; a read-only grant never does
 *    (rules out "uses → both scopes always");
 *  - the scope the gate records is the DERIVED one (rules out an approval
 *    replaying a client scope);
 *  - `uses` and a legacy `scope` are exclusive, one is required;
 *  - D-3: `workspaceId` pins the grant to that space, and a grant naming
 *    another space is refused (rules out "workspaceId is ignored").
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

vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async () => true),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { apiKeysRouter } from "./api-keys.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

const HUMAN = "human-mint";

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

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

const scopeOf = async (id: string) =>
  (
    await h.client!.query<{ scope: string[]; description: string | null }>(
      `select scope, description from api_keys where id = $1`,
      [id]
    )
  ).rows[0];

const grantOf = async (id: string) =>
  (
    await h.client!.query<{
      permissions: string[];
      workspace_ids: string[] | null;
    }>(`select permissions, workspace_ids from grants where api_key_id = $1`, [
      id,
    ])
  ).rows;

describe("apiKeys.create derives scopes from uses", () => {
  it("a write grant on the Hub API gets hub-protocol.read and .write", async () => {
    const res = await caller().create({
      keyName: "Dev loop poster",
      uses: ["hub"],
      templateId: "dev-loop-poster",
      note: "1Password › CI",
      grant: { permissions: ["event.create"] },
    });
    expect(res.status).toBe("created");
    expect(res).toMatchObject({
      scope: ["hub-protocol.read", "hub-protocol.write"],
    });
    expect(await scopeOf(res.id)).toEqual({
      scope: ["hub-protocol.read", "hub-protocol.write"],
      description: "1Password › CI",
    });
  });

  it("a read-only grant never gets a write door", async () => {
    const res = await caller().create({
      keyName: "Read-only",
      uses: ["hub", "mcp"],
      grant: { permissions: ["entity.*.read", "document.read"] },
    });
    expect((await scopeOf(res.id)).scope).toEqual([
      "hub-protocol.read",
      "mcp.read",
    ]);
  });

  it("the gate records the DERIVED scope, so an approval mints what was reviewed", async () => {
    const gate = vi.mocked(checkPermissionOrPropose);
    gate.mockClear();
    await caller().create({
      keyName: "poster",
      uses: ["hub"],
      grant: { permissions: ["event.create"] },
    });
    const data = (gate.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      scope: ["hub-protocol.read", "hub-protocol.write"],
      uses: ["hub"],
    });
  });

  it("needs exactly one of uses or a legacy scope", async () => {
    await expect(
      caller().create({
        keyName: "none",
        grant: { permissions: ["entity.read"] },
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().create({
        keyName: "both",
        uses: ["hub"],
        scope: ["hub-protocol.read"],
        grant: { permissions: ["entity.read"] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().create({
        keyName: "bogus use",
        uses: ["sftp"],
        grant: { permissions: ["entity.read"] },
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a legacy scope is still minted as sent", async () => {
    const res = await caller().create({
      keyName: "legacy",
      scope: ["mcp.read"],
      grant: { permissions: ["entity.read"] },
    });
    expect((await scopeOf(res.id)).scope).toEqual(["mcp.read"]);
  });
});

describe("D-3 — a key made for a space is confined to it", () => {
  const W = randomUUID();

  it("pins the grant to workspaceId when the grant names no space", async () => {
    const res = await caller().create({
      keyName: "space key",
      uses: ["hub"],
      workspaceId: W,
      grant: { permissions: ["entity.*.read"] },
    });
    expect(await grantOf(res.id)).toEqual([
      { permissions: ["entity.*.read"], workspace_ids: [W] },
    ]);
  });

  it("refuses a grant that names another space, and mints nothing", async () => {
    const before = (
      await h.client!.query<{ n: number }>(
        `select count(*)::int n from api_keys`
      )
    ).rows[0]!.n;
    await expect(
      caller().create({
        keyName: "elsewhere",
        uses: ["hub"],
        workspaceId: W,
        grant: { permissions: ["entity.*.read"], workspaceIds: [randomUUID()] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      (
        await h.client!.query<{ n: number }>(
          `select count(*)::int n from api_keys`
        )
      ).rows[0]!.n
    ).toBe(before);
  });
});
