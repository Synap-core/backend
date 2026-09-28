/**
 * `workspaces.stats` — per-space size + activity (decisions 3B + 2C).
 *
 * Driven through the REAL procedure and the REAL access layer on PGlite
 * (nothing mocked but the db handle), so each assertion pins a VALUE that
 * arrives, not a shape:
 *   - entityCount counts live entities IN the space; a soft-deleted one is
 *     not counted and its (later) updated_at is not "activity";
 *   - lastActivityAt = the latest updated_at among exactly those entities;
 *   - a space with no entity reads a MEASURED 0 with no activity;
 *   - an ARCHIVED space's counts reach its owner and a pod admin — with
 *     pausedRuleCount = rules still paused BY the archive — and never a plain
 *     member of it (counts open narrowly, not archived reads in general);
 *   - a non-member gets no row for a private space (the floor);
 *   - the Hub `GET /workspaces` reads the same derivation (no second copy).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  drizzleDb: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  h.drizzleDb = d;
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const OWNER = randomUUID();
const MEMBER = randomUUID();
const POD_ADMIN = randomUUID();
const STRANGER = randomUUID();
const WS_LIVE = randomUUID();
const WS_EMPTY = randomUUID();
const WS_ARCH = randomUUID();
const POD_ADMIN_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  workspacesRouter.createCaller({
    db: h.drizzleDb,
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

type Row = {
  workspaceId: string;
  archived: boolean;
  entityCount: number;
  lastActivityAt: string | null;
  pausedRuleCount: number | null;
};
const rowFor = (rows: Row[], id: string) =>
  rows.find((r) => r.workspaceId === id);

const T1 = "2026-09-20T10:00:00.000Z";
const T2 = "2026-09-25T12:00:00.000Z"; // latest LIVE change in WS_LIVE
const T_DELETED = "2026-09-27T09:00:00.000Z"; // later, but soft-deleted
const T_ARCH = "2026-08-01T08:00:00.000Z";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id, settings, archived_at, system_slug) values
      ($1,'Live',$5,'{}'::jsonb,null,null),
      ($2,'Empty',$5,'{}'::jsonb,null,null),
      ($3,'Old',$5,'{}'::jsonb,now(),null),
      ($4,'Pod admin',$5,'{}'::jsonb,null,'pod-admin')`,
    [WS_LIVE, WS_EMPTY, WS_ARCH, POD_ADMIN_WS, OWNER]
  );
  const members: Array<[string, string, string]> = [
    [WS_LIVE, OWNER, "owner"],
    [WS_EMPTY, OWNER, "owner"],
    [WS_ARCH, OWNER, "owner"],
    [WS_ARCH, MEMBER, "editor"],
    [WS_ARCH, POD_ADMIN, "viewer"],
    [POD_ADMIN_WS, POD_ADMIN, "admin"],
  ];
  for (const [ws, user, role] of members) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), ws, user, role]
    );
  }
  const ents: Array<[string, string, string | null]> = [
    [WS_LIVE, T1, null],
    [WS_LIVE, T2, null],
    [WS_LIVE, T1, null],
    [WS_LIVE, T_DELETED, T_DELETED],
    [WS_ARCH, T_ARCH, null],
    [WS_ARCH, T_ARCH, null],
  ];
  for (const [ws, updatedAt, deletedAt] of ents) {
    await q(
      `insert into entities (id, workspace_id, user_id, title, updated_at, deleted_at)
       values ($1,$2,$3,'x',$4,$5)`,
      [randomUUID(), ws, OWNER, updatedAt, deletedAt]
    );
  }
  // WS_ARCH rules: 2 paused BY the archive, 1 paused by hand (not the
  // archive's), 1 active — a restore leaves exactly the first two paused.
  const autos: Array<[string, string]> = [
    ["paused", `{"pausedByWorkspaceArchive":{"workspaceId":"${WS_ARCH}"}}`],
    ["paused", `{"pausedByWorkspaceArchive":{"workspaceId":"${WS_ARCH}"}}`],
    ["paused", "{}"],
    ["active", "{}"],
  ];
  for (const [status, metadata] of autos) {
    await q(
      `insert into automations (id, workspace_id, created_by, name, trigger_type, status, metadata)
       values ($1,$2,$3,'r','cron',$4,$5::jsonb)`,
      [randomUUID(), WS_ARCH, OWNER, status, metadata]
    );
  }
});

describe("workspaces.stats", () => {
  it("counts live entities in the space and dates its last change", async () => {
    const rows = (await caller(OWNER).stats()) as Row[];
    expect(rowFor(rows, WS_LIVE)).toEqual({
      workspaceId: WS_LIVE,
      archived: false,
      entityCount: 3,
      lastActivityAt: T2,
      pausedRuleCount: null,
    });
  });

  it("a space with no entity reads a measured zero, no activity", async () => {
    const rows = (await caller(OWNER).stats()) as Row[];
    expect(rowFor(rows, WS_EMPTY)).toMatchObject({
      entityCount: 0,
      lastActivityAt: null,
    });
  });

  it("an archived space's counts reach its owner, with the rules a restore leaves paused", async () => {
    const rows = (await caller(OWNER).stats()) as Row[];
    expect(rowFor(rows, WS_ARCH)).toEqual({
      workspaceId: WS_ARCH,
      archived: true,
      entityCount: 2,
      lastActivityAt: T_ARCH,
      pausedRuleCount: 2,
    });
  });

  it("a pod admin sees an archived space's counts too", async () => {
    const rows = (await caller(POD_ADMIN).stats()) as Row[];
    expect(rowFor(rows, WS_ARCH)).toMatchObject({
      archived: true,
      entityCount: 2,
      pausedRuleCount: 2,
    });
  });

  it("a plain member of an archived space gets NO row for it", async () => {
    const rows = (await caller(MEMBER).stats()) as Row[];
    expect(rowFor(rows, WS_ARCH)).toBeUndefined();
  });

  it("a non-member gets no row for a private space (the floor)", async () => {
    const rows = (await caller(STRANGER).stats()) as Row[];
    expect(rowFor(rows, WS_LIVE)).toBeUndefined();
    expect(rowFor(rows, WS_ARCH)).toBeUndefined();
    expect(rows).toEqual([]);
  });
});

describe("one derivation", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const HUB = readFileSync(
    join(HERE, "hub-protocol/rest/workspaces.ts"),
    "utf8"
  );

  it("the Hub GET /workspaces count reads the shared stats query, not a copy", () => {
    // Self-check: the scan can still see the list route it is about.
    expect(HUB).toMatch(/app\.get\("\/workspaces",/);
    expect(HUB).toMatch(/readWorkspaceEntityStats\(/);
    expect(HUB).not.toMatch(/\.groupBy\(entities\.workspaceId\)/);
  });
});
