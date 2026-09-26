/**
 * D6 — governed "change project home workspace", through the REAL
 * `projects.update` procedure on PGlite (real visibility floor, real write
 * check, real ProjectRepository write, real `uses` edge). Only governance, the
 * audit log, the event bus and side effects are stubbed; the governance stub
 * PROPOSES for an agent call and allows a human one, exactly like the gate's
 * two outcomes.
 *
 *   WA — U's current home (owner)      WB — U is an editor (writable target)
 *   WV — U is only a viewer            WX — archived, U owner
 *
 * What this CANNOT see: production Postgres constraints, the MCP/Hub doors'
 * own argument plumbing (the MCP handler forwards to this procedure; the Hub
 * PATCH shares `resolveProjectHomeChange`).
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
const AGENT = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const WV = randomUUID();
const WX = randomUUID();

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

async function newProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, settings, metadata) values ($1,$2,$3,'Ethical Fashion','active','{}'::jsonb,'{}'::jsonb)`,
    [id, U, WA]
  );
  return id;
}
async function homeOf(id: string): Promise<string | null> {
  const r = await q<{ workspace_id: string | null }>(
    `select workspace_id from projects where id = $1`,
    [id]
  );
  return r.rows[0]!.workspace_id;
}
async function usesEdges(id: string): Promise<string[]> {
  const r = await q<{ to_id: string }>(
    `select to_id from links where from_type='project' and from_id=$1 and link_type='uses'`,
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
  await q(`insert into users (id, email) values ($1, $2)`, [
    U,
    `${U}@example.test`,
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), U]
  );
  for (const [ws, role, archived] of [
    [WA, "owner", false],
    [WB, "editor", false],
    [WV, "viewer", false],
    [WX, "owner", true],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings, archived_at) values ($1,'w',$2,'{}'::jsonb,$3)`,
      [ws, role === "owner" ? U : randomUUID(), archived ? new Date() : null]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), ws, U, role]
    );
  }
}, 60_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("projects.update homeWorkspaceId (D6)", () => {
  it("a human moves the home to a writable workspace: row moves, new home stamped as `uses`", async () => {
    const p = await newProject();
    const res = await caller().update({ id: p, homeWorkspaceId: WB });
    expect(res).toMatchObject({ status: "updated" });
    expect(await homeOf(p)).toBe(WB);
    expect(await usesEdges(p)).toEqual([WB]);
    // Governed on the project's CURRENT workspace, with the move in the patch.
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      workspaceId: WA,
      subjectType: "project",
      action: "update",
      data: { id: p, homeWorkspaceId: WB },
    });
  });

  it("an agent call is PROPOSED with the move in the patch; nothing moves yet", async () => {
    const p = await newProject();
    const res = await caller(true).update({ id: p, homeWorkspaceId: WB });
    expect(res).toMatchObject({ status: "proposed", proposalId: "proposal-1" });
    expect(h.permCalls[0]?.data).toMatchObject({ homeWorkspaceId: WB });
    expect(await homeOf(p)).toBe(WA);
    expect(await usesEdges(p)).toEqual([]);
  });

  it("a target the caller can only VIEW is refused before the gate (no proposal filed)", async () => {
    const p = await newProject();
    expect(
      await code(caller(true).update({ id: p, homeWorkspaceId: WV }))
    ).toBe("FORBIDDEN");
    expect(h.permCalls).toHaveLength(0);
    expect(await homeOf(p)).toBe(WA);
  });

  it("an archived or unknown target is NOT_FOUND", async () => {
    const p = await newProject();
    expect(await code(caller().update({ id: p, homeWorkspaceId: WX }))).toBe(
      "NOT_FOUND"
    );
    expect(
      await code(caller().update({ id: p, homeWorkspaceId: randomUUID() }))
    ).toBe("NOT_FOUND");
    expect(await homeOf(p)).toBe(WA);
  });

  it("the same home is a no-op field (never in the gated patch)", async () => {
    const p = await newProject();
    await caller().update({ id: p, homeWorkspaceId: WA, name: "Renamed" });
    expect(h.permCalls[0]?.data).not.toHaveProperty("homeWorkspaceId");
    expect(await homeOf(p)).toBe(WA);
  });
});
