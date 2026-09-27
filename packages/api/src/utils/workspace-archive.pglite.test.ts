/**
 * R8a — the DB halves of the governed workspace operations, on PGlite with the
 * REAL SQL compiled and executed:
 *
 *   1. `setWorkspaceArchived` (archive) pauses ONLY this workspace's ACTIVE
 *      automations, stamps them, and leaves pod-wide / other-workspace / draft
 *      rows untouched; (restore) clears `archived_at`, re-enables NOTHING, and
 *      lists exactly the automations the archive paused.
 *   2. `WorkspaceRepository.delete` removes every `links` edge naming the
 *      workspace (either end) in the same transaction — and nothing else.
 *   3. `archivedUsesTargetRemovable` — true only for an ARCHIVED target and a
 *      project the caller OWNS.
 *
 * What this CANNOT see: production Postgres constraints (PGlite tables are
 * generated from the Drizzle definitions without FKs/NOT NULL/enums).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { WorkspaceRepository } from "@synap/database";
import { setWorkspaceArchived } from "./workspace-archive.js";
import { archivedUsesTargetRemovable } from "./project-workspace.js";

const OWNER = "owner-1";
const STRANGER = "stranger-1";

const WS = randomUUID();
const WS_OTHER = randomUUID();
const WS_DELETE = randomUUID();
const WS_KEEP = randomUUID();
const PROJECT = randomUUID();

const A_ACTIVE_1 = randomUUID();
const A_ACTIVE_2 = randomUUID();
const A_DRAFT = randomUUID();
const A_PAUSED_BEFORE = randomUUID();
const A_OTHER_WS = randomUUID();
const A_POD_WIDE = randomUUID();

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

const db = async () => (await import("@synap/database")).db as never;

const statusOf = async (id: string) =>
  (
    await q<{ status: string; metadata: Record<string, unknown> | null }>(
      `select status, metadata from automations where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id) values
      ($1,'Archive me',$6),($2,'Other',$6),($3,'Delete me',$6),($4,'Keep',$6),($5,'Unused',$6)`,
    [WS, WS_OTHER, WS_DELETE, WS_KEEP, randomUUID(), OWNER]
  );
  const auto = (id: string, ws: string | null, status: string) =>
    q(
      `insert into automations (id, workspace_id, created_by, name, trigger_type, status, metadata)
       values ($1,$2,$3,$4,'cron',$5,'{"tags":["t"]}'::jsonb)`,
      [id, ws, OWNER, `auto-${id.slice(0, 4)}`, status]
    );
  await auto(A_ACTIVE_1, WS, "active");
  await auto(A_ACTIVE_2, WS, "active");
  await auto(A_DRAFT, WS, "draft");
  await auto(A_PAUSED_BEFORE, WS, "paused");
  await auto(A_OTHER_WS, WS_OTHER, "active");
  await auto(A_POD_WIDE, null, "active");

  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'P',$2,$3)`,
    [PROJECT, OWNER, WS_KEEP]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values
      ($1,'project',$5,'workspace',$6,'uses'),
      ($2,'workspace',$6,'workspace',$7,'sources_from'),
      ($3,'project',$5,'workspace',$7,'uses'),
      ($4,'project',$5,'playbook',$6,'uses')`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      PROJECT,
      WS_DELETE,
      WS_KEEP,
    ]
  );
});

describe("setWorkspaceArchived — archive pauses the workspace's automations", () => {
  it("pauses exactly this workspace's ACTIVE automations and names them", async () => {
    const res = await setWorkspaceArchived(await db(), {
      workspaceId: WS,
      archive: true,
    });
    expect(res.archivedAt).toBeInstanceOf(Date);
    expect(res.pausedAutomations.map((a) => a.id).sort()).toEqual(
      [A_ACTIVE_1, A_ACTIVE_2].sort()
    );

    const ws = await q<{ archived_at: unknown }>(
      `select archived_at from workspaces where id = $1`,
      [WS]
    );
    expect(ws.rows[0]!.archived_at).not.toBeNull();

    for (const id of [A_ACTIVE_1, A_ACTIVE_2]) {
      const row = await statusOf(id);
      expect(row.status).toBe("paused");
      // stamped, and the existing metadata is kept (jsonb merge, not replace)
      expect(row.metadata).toMatchObject({
        tags: ["t"],
        pausedByWorkspaceArchive: { workspaceId: WS },
      });
    }
    // untouched: draft, already-paused, another workspace, pod-wide
    expect((await statusOf(A_DRAFT)).status).toBe("draft");
    expect((await statusOf(A_PAUSED_BEFORE)).metadata).not.toHaveProperty(
      "pausedByWorkspaceArchive"
    );
    expect((await statusOf(A_OTHER_WS)).status).toBe("active");
    expect((await statusOf(A_POD_WIDE)).status).toBe("active");
  });

  it("restore re-enables NOTHING and lists only what the archive paused", async () => {
    const res = await setWorkspaceArchived(await db(), {
      workspaceId: WS,
      archive: false,
    });
    expect(res.archivedAt).toBeNull();
    expect(res.pausedAutomations).toEqual([]);
    expect(res.pausedByArchive.map((a) => a.id).sort()).toEqual(
      [A_ACTIVE_1, A_ACTIVE_2].sort()
    );
    const ws = await q<{ archived_at: unknown }>(
      `select archived_at from workspaces where id = $1`,
      [WS]
    );
    expect(ws.rows[0]!.archived_at).toBeNull();
    expect((await statusOf(A_ACTIVE_1)).status).toBe("paused");
    expect((await statusOf(A_ACTIVE_2)).status).toBe("paused");
  });
});

describe("WorkspaceRepository.delete — leftover links", () => {
  it("removes every edge naming the workspace, in either direction, and nothing else", async () => {
    const eventRepo = { append: vi.fn(async () => undefined) };
    const repo = new WorkspaceRepository(await db(), eventRepo as never);
    await repo.delete(WS_DELETE, OWNER);

    const rows = (
      await q<{ from_id: string; to_id: string; link_type: string }>(
        `select from_id, to_id, link_type from links order by link_type, to_id`
      )
    ).rows;
    // The project's `uses` edge to the kept workspace, and an edge whose
    // `from`/`to` merely share the id STRING under another type, survive.
    expect(rows).toEqual(
      expect.arrayContaining([
        { from_id: PROJECT, to_id: WS_KEEP, link_type: "uses" },
        { from_id: PROJECT, to_id: WS_DELETE, link_type: "uses" },
      ])
    );
    expect(rows).toHaveLength(2);
    const remaining = (
      await q<{ to_type: string; to_id: string }>(
        `select to_type, to_id from links where to_id = $1`,
        [WS_DELETE]
      )
    ).rows;
    // the only survivor naming WS_DELETE is the playbook-typed endpoint
    expect(remaining).toEqual([{ to_type: "playbook", to_id: WS_DELETE }]);
    expect(eventRepo.append).toHaveBeenCalledTimes(1);
  });

  it("a missing workspace throws and rolls the link delete back", async () => {
    const ghost = randomUUID();
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'project',$2,'workspace',$3,'uses')`,
      [randomUUID(), PROJECT, ghost]
    );
    const repo = new WorkspaceRepository(await db(), {
      append: vi.fn(),
    } as never);
    await expect(repo.delete(ghost, OWNER)).rejects.toThrow(
      "Workspace not found"
    );
    const still = await q(`select id from links where to_id = $1`, [ghost]);
    expect(still.rows).toHaveLength(1);
  });
});

describe("archivedUsesTargetRemovable", () => {
  it("true only for an archived target AND a project the caller owns", async () => {
    // WS_KEEP is live → false
    expect(
      await archivedUsesTargetRemovable(await db(), {
        projectId: PROJECT,
        workspaceId: WS_KEEP,
        userId: OWNER,
      })
    ).toBe(false);
    await q(`update workspaces set archived_at = now() where id = $1`, [
      WS_KEEP,
    ]);
    expect(
      await archivedUsesTargetRemovable(await db(), {
        projectId: PROJECT,
        workspaceId: WS_KEEP,
        userId: OWNER,
      })
    ).toBe(true);
    // archived, but not the project's owner → false
    expect(
      await archivedUsesTargetRemovable(await db(), {
        projectId: PROJECT,
        workspaceId: WS_KEEP,
        userId: STRANGER,
      })
    ).toBe(false);
    // a deleted workspace row → false (no row, nothing to relax)
    expect(
      await archivedUsesTargetRemovable(await db(), {
        projectId: PROJECT,
        workspaceId: randomUUID(),
        userId: OWNER,
      })
    ).toBe(false);
    // malformed id never reaches a uuid comparison
    expect(
      await archivedUsesTargetRemovable(await db(), {
        projectId: "nope",
        workspaceId: WS_KEEP,
        userId: OWNER,
      })
    ).toBe(false);
  });
});
