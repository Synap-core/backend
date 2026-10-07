/**
 * `projects.setWorkspaceMembership` — link / unlink a `project --uses--> workspace`
 * INDEX edge from the project page, through the REAL procedure on PGlite (real
 * project visibility floor, real endpoint floor, real `links` writes). Only
 * governance, the audit log, the event bus and side effects are stubbed; the
 * governance stub PROPOSES for an agent call and allows a human one, exactly like
 * the gate's two outcomes.
 *
 *   WA — U owns it (the project's home)   WB — U is an editor (linkable)
 *   WZ — U is NOT a member (unreachable)
 *
 * What this CANNOT see: production Postgres constraints, the proposal executor
 * that replays an approved `link/create` (`executors/catch-all.ts`), the MCP/Hub
 * doors' own argument plumbing.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const noop = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: noop,
    EventRepository: class {
      constructor() {
        return noop;
      }
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    h.permCalls.push(args);
    return args.agentUserId ? { proposalId: "proposal-1" } : { allowed: true };
  }),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { projectsRouter } from "./projects.js";

const U = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const WZ = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (agent = false) =>
  projectsRouter.createCaller({
    authenticated: true,
    userId: U,
    workspaceId: null,
    ...(agent ? { agentUserId: AGENT } : {}),
  } as never);

async function newProject(owner = U, home: string | null = WA) {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, settings, metadata) values ($1,$2,$3,'Synap','active','{}'::jsonb,'{}'::jsonb)`,
    [id, owner, home]
  );
  return id;
}
async function usesEdges(id: string): Promise<string[]> {
  const r = await q<{ to_id: string }>(
    `select to_id from links where from_type='project' and from_id=$1 and link_type='uses' order by to_id`,
    [id]
  );
  return r.rows.map((x) => x.to_id);
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // The one production constraint `createLink`'s ON CONFLICT names.
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  for (const u of [U, OTHER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), U]
  );
  for (const [ws, role] of [
    [WA, "owner"],
    [WB, "editor"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
      [ws, role === "owner" ? U : randomUUID()]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), ws, U, role]
    );
  }
  // WZ exists but U is not a member and it is not pod-visible.
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'z',$2,'{}'::jsonb)`,
    [WZ, OTHER]
  );
}, 60_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("projects.setWorkspaceMembership", () => {
  it("a human links a space: a `uses` edge lands, governed as link/create", async () => {
    const p = await newProject();
    const res = await caller().setWorkspaceMembership({
      projectId: p,
      workspaceId: WB,
      member: true,
    });
    expect(res).toMatchObject({ status: "updated" });
    expect(await usesEdges(p)).toEqual([WB]);
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "link",
      action: "create",
      data: {
        fromType: "project",
        fromId: p,
        toType: "workspace",
        toId: WB,
        linkType: "uses",
      },
    });
  });

  it("linking the same space twice leaves ONE edge", async () => {
    const p = await newProject();
    const input = { projectId: p, workspaceId: WB, member: true };
    await caller().setWorkspaceMembership(input);
    await caller().setWorkspaceMembership(input);
    expect(await usesEdges(p)).toEqual([WB]);
  });

  it("unlinking removes exactly that edge and is governed as link/delete", async () => {
    const p = await newProject();
    await caller().setWorkspaceMembership({
      projectId: p,
      workspaceId: WA,
      member: true,
    });
    await caller().setWorkspaceMembership({
      projectId: p,
      workspaceId: WB,
      member: true,
    });
    h.permCalls.length = 0;
    const res = await caller().setWorkspaceMembership({
      projectId: p,
      workspaceId: WB,
      member: false,
    });
    expect(res).toMatchObject({ status: "updated" });
    expect(await usesEdges(p)).toEqual([WA]);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "link",
      action: "delete",
    });
  });

  it("an agent call is PROPOSED; nothing is written", async () => {
    const p = await newProject();
    const res = await caller(true).setWorkspaceMembership({
      projectId: p,
      workspaceId: WB,
      member: true,
    });
    expect(res).toMatchObject({ status: "proposed", proposalId: "proposal-1" });
    expect(await usesEdges(p)).toEqual([]);
  });

  it("a space the caller cannot reach is refused BEFORE the gate (no proposal can be filed)", async () => {
    const p = await newProject();
    expect(
      await code(
        caller(true).setWorkspaceMembership({
          projectId: p,
          workspaceId: WZ,
          member: true,
        })
      )
    ).toBe("FORBIDDEN");
    expect(h.permCalls).toHaveLength(0);
    expect(await usesEdges(p)).toEqual([]);
  });

  it("a project the caller cannot see is NOT_FOUND, and nothing is gated or written", async () => {
    const foreign = await newProject(OTHER, null);
    expect(
      await code(
        caller().setWorkspaceMembership({
          projectId: foreign,
          workspaceId: WB,
          member: true,
        })
      )
    ).toBe("NOT_FOUND");
    expect(h.permCalls).toHaveLength(0);
    expect(await usesEdges(foreign)).toEqual([]);
  });
});
