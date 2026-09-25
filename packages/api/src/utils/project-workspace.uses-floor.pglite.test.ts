/**
 * USES FLOOR — `listWorkspacesUsedByProjects` / `hydrateUsedWorkspaces` must
 * only surface a used workspace's id/name/domain to a viewer who can see that
 * workspace (member, owner, or pod-visible). `project --uses--> workspace` is
 * an INDEX, not an ACL (see `project-workspace.ts` header) — this floor is
 * about what the workspace's OWN name/domain render as on the project page,
 * not about granting or revoking the edge itself.
 *
 * The defect this pins: both readers were unfloored — any project viewer saw
 * every used workspace's name + domain, including ones they are not a member
 * of. Driven through the REAL functions on PGlite, with the real
 * `userVisibleWhere` predicate compiled and executed as SQL.
 *
 * What this CANNOT see: production Postgres (PGlite tables are generated from
 * the Drizzle definitions without FKs/NOT NULL/enums), and the `uses` WRITE
 * path (`linkProjectToWorkspace`), which has its own DB-free suite in
 * `project-workspace.test.ts`.
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
import {
  listWorkspacesUsedByProjects,
  hydrateUsedWorkspaces,
} from "./project-workspace.js";

const VIEWER = "viewer-1";
const OTHER = "other-1";

const WS_SEEN = randomUUID(); // viewer is a member
const WS_HIDDEN = randomUUID(); // owned by OTHER, viewer not a member
const PROJECT_ID = randomUUID(); // viewer's own project, uses both workspaces

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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, domain, owner_id) values ($1,'Seen WS','builder',$3),($2,'Hidden WS','crm',$4)`,
    [WS_SEEN, WS_HIDDEN, VIEWER, OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS_SEEN, VIEWER]
  );
  await q(
    `insert into projects (id, name, user_id, workspace_id) values ($1,'My project',$2,$3)`,
    [PROJECT_ID, VIEWER, WS_SEEN]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values
      ($1,'project',$2,'workspace',$3,'uses'),
      ($4,'project',$2,'workspace',$5,'uses')`,
    [randomUUID(), PROJECT_ID, WS_SEEN, randomUUID(), WS_HIDDEN]
  );
});

describe("listWorkspacesUsedByProjects — floored to what the viewer can see", () => {
  it("VIEWER (member of WS_SEEN, not WS_HIDDEN) sees only the seen workspace id", async () => {
    const db = (await import("@synap/database")).db;
    const map = await listWorkspacesUsedByProjects(
      db as never,
      [PROJECT_ID],
      VIEWER
    );
    expect(map.get(PROJECT_ID)).toEqual([WS_SEEN]);
  });

  it("OTHER (owner of WS_HIDDEN, not a member of WS_SEEN) sees only the hidden workspace id", async () => {
    const db = (await import("@synap/database")).db;
    const map = await listWorkspacesUsedByProjects(
      db as never,
      [PROJECT_ID],
      OTHER
    );
    expect(map.get(PROJECT_ID)).toEqual([WS_HIDDEN]);
  });
});

describe("hydrateUsedWorkspaces — name/domain floored to what the viewer can see", () => {
  it("VIEWER resolves WS_SEEN's name+domain; WS_HIDDEN resolves to nothing (omitted, not renamed)", async () => {
    const db = (await import("@synap/database")).db;
    const refs = await hydrateUsedWorkspaces(
      db as never,
      [WS_SEEN, WS_HIDDEN],
      VIEWER
    );
    expect(refs).toEqual([{ id: WS_SEEN, name: "Seen WS", domain: "builder" }]);
  });

  it("OTHER resolves WS_HIDDEN's (their own) name+domain; WS_SEEN is omitted", async () => {
    const db = (await import("@synap/database")).db;
    const refs = await hydrateUsedWorkspaces(
      db as never,
      [WS_SEEN, WS_HIDDEN],
      OTHER
    );
    expect(refs).toEqual([{ id: WS_HIDDEN, name: "Hidden WS", domain: "crm" }]);
  });
});
