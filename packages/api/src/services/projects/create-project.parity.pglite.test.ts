/**
 * W5c — ONE governed project create, TWO doors: tRPC `projects.create` and Hub
 * REST `POST /projects` (CLI `synap project new`, Raycast `create-project`)
 * both go through `createProjectGoverned`.
 *
 * The defect this exists for: the REST door re-implemented the guardrails and
 * stopped at the insert — no subject binding, no audit row, no `project.create`
 * side effects — so a project made from the CLI existed but nothing that
 * listens for creates ever heard of it.
 *
 * Driven through the REAL procedures on PGlite (real ProjectRepository insert,
 * real slug, real `targets` link). Only governance, the audit log and the side
 * effect bus are stubbed — as RECORDERS, so the test can compare what each door
 * emitted. The governance stub proposes for an agent and allows a human, the
 * gate's two outcomes.
 *
 * What this CANNOT see: production Postgres constraints; the MCP door (it
 * forwards to the tRPC procedure with `door: "mcp"`).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  effects: [] as Array<Record<string, unknown>>,
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
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    h.permCalls.push(args);
    return args.agentUserId ? { proposalId: "proposal-1" } : { allowed: true };
  }),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn((a: Record<string, unknown>) => {
    h.audits.push(a);
  }),
}));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn(async (a: Record<string, unknown>) => {
    h.effects.push(a);
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { projectsRouter } from "../../routers/projects.js";
import { registerProjectsRoutes } from "../../routers/hub-protocol/rest/projects.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const U = randomUUID();
const AGENT = randomUUID();
const WA = randomUUID();
const SUBJECT = randomUUID();

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

const trpc = (agent = false) =>
  projectsRouter.createCaller({
    authenticated: true,
    userId: U,
    workspaceId: WA,
    ...(agent ? { agentUserId: AGENT } : {}),
  } as never);

function restApp(agent = false): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", U);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agent) c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerProjectsRoutes(app);
  return app;
}
async function restCreate(body: Record<string, unknown>, agent = false) {
  const res = await restApp(agent).request("/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const PAYLOAD = {
  name: "Atlas launch",
  description: "Ship the atlas",
  phase: "discovery",
  targetDate: "2026-12-15T00:00:00.000Z",
  subjectEntityId: SUBJECT,
  settings: { color: "ochre" },
  metadata: { origin: "parity" },
};

/** Everything a create leaves behind, with per-row noise normalised away. */
async function snapshot() {
  const rows = await q<Record<string, unknown>>(
    `select name, slug, description, status, phase, target_date, settings, metadata, user_id, workspace_id from projects`
  );
  const projects = rows.rows.map((r) => {
    const meta = { ...(r.metadata as Record<string, unknown>) };
    const prov = { ...(meta.provenance as Record<string, unknown>) };
    delete prov.createdAtIso;
    delete prov.door; // the ONE field that legitimately names the door
    return { ...r, metadata: { ...meta, provenance: prov } };
  });
  const links = await q<Record<string, unknown>>(
    `select from_type, to_type, to_id, link_type from links where from_type = 'project'`
  );
  const norm = (a: Record<string, unknown>) => ({ ...a, subjectId: "<id>" });
  return {
    projects,
    links: links.rows,
    audits: h.audits.map(norm),
    effects: h.effects.map(norm),
    gate: h.permCalls.map((p) => ({ ...p })),
  };
}

async function reset() {
  await q(`delete from projects`);
  await q(`delete from links`);
  h.permCalls.length = 0;
  h.audits.length = 0;
  h.effects.length = 0;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
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
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [WA, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WA, U]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title) values ($1,$2,$3,'Atlas Co')`,
    [SUBJECT, U, WA]
  );
}, 60_000);

beforeEach(reset);

describe("createProjectGoverned — tRPC and Hub REST are one door", () => {
  it("a human create leaves IDENTICAL rows, subject link, audit and side effects through both doors", async () => {
    const viaTrpc = await trpc().create({
      ...PAYLOAD,
      targetDate: new Date(PAYLOAD.targetDate),
    });
    expect(viaTrpc).toMatchObject({ status: "created", subjectBound: true });
    const a = await snapshot();

    await reset();
    const viaRest = await restCreate({ ...PAYLOAD, workspaceId: WA });
    expect(viaRest.status).toBe(201);
    // Wire shape kept: the created row (callers read `id`) + subjectBound.
    expect(typeof viaRest.body.id).toBe("string");
    expect(viaRest.body.subjectBound).toBe(true);
    const b = await snapshot();

    // Non-vacuity: there IS something to compare on each axis.
    expect(a.projects).toHaveLength(1);
    expect(a.links).toEqual([
      expect.objectContaining({ to_id: SUBJECT, to_type: "entity" }),
    ]);
    expect(a.audits).toEqual([
      expect.objectContaining({ subjectType: "project", action: "create" }),
    ]);
    expect(a.effects).toEqual([
      expect.objectContaining({ subjectType: "project", action: "create" }),
    ]);

    expect(b).toEqual(a);
  });

  it("an agent create files the SAME proposal payload through both doors, and writes nothing", async () => {
    const evidence = Array.from({ length: 5 }, () => randomUUID());
    for (const id of evidence) {
      await q(
        `insert into entities (id, user_id, workspace_id, title) values ($1,$2,$3,'e')`,
        [id, U, WA]
      );
    }
    const body = { ...PAYLOAD, name: "Borealis", evidenceEntityIds: evidence };

    const viaTrpc = await trpc(true).create({
      ...body,
      targetDate: new Date(body.targetDate),
    });
    expect(viaTrpc).toMatchObject({
      status: "proposed",
      proposalId: "proposal-1",
    });
    const a = await snapshot();

    await reset();
    const viaRest = await restCreate({ ...body, workspaceId: WA }, true);
    expect(viaRest.status).toBe(202);
    const b = await snapshot();

    expect(a.gate).toHaveLength(1);
    expect(a.projects).toEqual([]);
    expect(a.effects).toEqual([]);
    // JSON-normalise: the Date in the payload is the one non-plain value.
    expect(JSON.parse(JSON.stringify(b))).toEqual(
      JSON.parse(JSON.stringify(a))
    );
  });

  it("an agent with no evidence is refused BEFORE governance on both doors", async () => {
    await expect(trpc(true).create({ name: "Cygnus" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const viaRest = await restCreate({ name: "Cygnus" }, true);
    expect(viaRest.status).toBe(400);
    expect(h.permCalls).toEqual([]);
  });
});
