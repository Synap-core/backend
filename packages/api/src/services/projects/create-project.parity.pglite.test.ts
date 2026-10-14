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
import { resolveProjectForPackInstall } from "../resolve-project-for-pack-install.js";
import { ProjectRepository } from "@synap/database";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const U = randomUUID();
const AGENT = randomUUID();
const WA = randomUUID();
/** U is an editor here — a writable home and a linkable used space. */
const WB = randomUUID();
/** U is NOT a member — unreachable as a home or a used space. */
const WZ = randomUUID();
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
    `select name, slug, description, status, phase, target_date, color_slot, icon, settings, metadata, user_id, workspace_id from projects`
  );
  const projects = rows.rows.map((r) => {
    const meta = { ...(r.metadata as Record<string, unknown>) };
    const prov = { ...(meta.provenance as Record<string, unknown>) };
    delete prov.createdAtIso;
    delete prov.door; // the ONE field that legitimately names the door
    return { ...r, metadata: { ...meta, provenance: prov } };
  });
  const links = await q<Record<string, unknown>>(
    `select from_type, to_type, to_id, link_type from links where from_type = 'project' order by to_type, to_id`
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
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'wb',$2,'{}'::jsonb), ($3,'wz',$2,'{}'::jsonb)`,
    [WB, randomUUID(), WZ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), WB, U]
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

describe("resolveProjectForPackInstall — a named install creates through the governed door", () => {
  it("audits and announces the engagement project (RV1 S4)", async () => {
    const res = await resolveProjectForPackInstall({
      userId: U,
      projectName: "Delta engagement",
      packageSlug: "the-arch",
      homeWorkspaceId: WA,
    });
    expect(res).toMatchObject({ created: true, reused: false });
    expect(h.permCalls).toEqual([
      expect.objectContaining({ subjectType: "project", action: "create" }),
    ]);
    expect(h.audits).toEqual([
      expect.objectContaining({ subjectType: "project", action: "create" }),
    ]);
    expect(h.effects).toEqual([
      expect.objectContaining({ subjectType: "project", action: "create" }),
    ]);
  });
});

async function restPatch(
  id: string,
  body: Record<string, unknown>,
  agent = false
) {
  const res = await restApp(agent).request(`/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

async function seedProject(): Promise<string> {
  const created = await trpc().create({ name: "Orion", description: "d" });
  if (created.status !== "created") throw new Error("seed failed");
  clearRecorders();
  return created.projectId as string;
}
function clearRecorders() {
  h.permCalls.length = 0;
  h.audits.length = 0;
  h.effects.length = 0;
}

const PATCH = {
  name: "Orion II",
  description: "renamed",
  phase: "build",
  colorSlot: 4,
  subjectEntityId: SUBJECT,
  settings: { color: "teal" },
  metadata: { origin: "patch" },
};

async function projectRow(id: string) {
  const r = await q<Record<string, unknown>>(
    `select name, description, status, phase, color_slot, settings, metadata from projects where id = $1`,
    [id]
  );
  return r.rows[0];
}

describe("updateProjectGoverned — tRPC and Hub REST are one door (RV1 S5)", () => {
  it("a human update leaves the SAME row, audit, side effects and gate payload through both doors", async () => {
    const p1 = await seedProject();
    await trpc().update({ id: p1, ...PATCH });
    const a = {
      row: await projectRow(p1),
      audits: h.audits.map((x) => ({ ...x, subjectId: "<id>" })),
      effects: h.effects.map((x) => ({ ...x, subjectId: "<id>" })),
      gate: h.permCalls.map((x) => ({
        ...x,
        data: { ...(x.data as object), id: "<id>" },
      })),
    };

    await reset();
    const p2 = await seedProject();
    const viaRest = await restPatch(p2, PATCH);
    expect(viaRest.status).toBe(200);
    expect(viaRest.body.id).toBe(p2); // wire shape kept: the updated row
    const b = {
      row: await projectRow(p2),
      audits: h.audits.map((x) => ({ ...x, subjectId: "<id>" })),
      effects: h.effects.map((x) => ({ ...x, subjectId: "<id>" })),
      gate: h.permCalls.map((x) => ({
        ...x,
        data: { ...(x.data as object), id: "<id>" },
      })),
    };

    // Non-vacuity on each axis.
    expect(a.row).toMatchObject({ name: "Orion II", color_slot: 4 });
    expect(a.audits).toEqual([
      expect.objectContaining({ subjectType: "project", action: "update" }),
    ]);
    expect(a.effects).toEqual([
      expect.objectContaining({ subjectType: "project", action: "update" }),
    ]);
    expect(a.gate[0]!.data).toMatchObject({
      colorSlot: 4,
      subjectEntityId: SUBJECT,
    });
    expect(b).toEqual(a);
  });

  it("REST maps errors by code: unknown id 404, a server fault 500 (never a blanket 404)", async () => {
    const missing = await restPatch(randomUUID(), { name: "x" });
    expect(missing.status).toBe(404);

    const p = await seedProject();
    const spy = vi
      .spyOn(ProjectRepository.prototype, "update")
      .mockRejectedValueOnce(new Error("connection reset"));
    try {
      const fault = await restPatch(p, { name: "y" });
      expect(fault.status).toBe(500);
      expect(fault.body.error).toBe("connection reset");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createProjectGoverned — the place's look and parts (projects as places)", () => {
  const PLACE = {
    name: "Lyra",
    colorSlot: 5,
    icon: "👩‍🚀",
    homeWorkspaceId: WB,
    usedWorkspaceIds: [WA, WB],
  };

  it("lands colour, icon, home and used spaces IDENTICALLY through both doors", async () => {
    const viaTrpc = await trpc().create(PLACE);
    expect(viaTrpc).toMatchObject({
      status: "created",
      project: { colorSlot: 5, icon: "👩‍🚀", workspaceId: WB },
      usedWorkspaces: [
        { workspaceId: WA, status: "linked" },
        { workspaceId: WB, status: "linked" },
      ],
    });
    const a = await snapshot();

    await reset();
    const viaRest = await restCreate(PLACE);
    expect(viaRest.status).toBe(201);
    expect(viaRest.body).toMatchObject({
      colorSlot: 5,
      icon: "👩‍🚀",
      workspaceId: WB,
      usedWorkspaces: [
        { workspaceId: WA, status: "linked" },
        { workspaceId: WB, status: "linked" },
      ],
    });
    const b = await snapshot();

    // Non-vacuity: the row carries the look, and the home + each used space
    // is ONE `uses` edge (the home stamp and the used link dedupe on WB).
    expect(a.projects).toEqual([
      expect.objectContaining({ color_slot: 5, icon: "👩‍🚀", workspace_id: WB }),
    ]);
    expect(a.links.map((l) => [l.to_type, l.to_id, l.link_type])).toEqual(
      [
        ["workspace", WA, "uses"],
        ["workspace", WB, "uses"],
      ].sort((x, y) => x[1]!.localeCompare(y[1]!))
    );
    // Governance saw the whole place on the create, then each link on its
    // own door (the same rules as projects.setWorkspaceMembership).
    expect(a.gate[0]).toMatchObject({
      subjectType: "project",
      action: "create",
      workspaceId: WB,
      data: expect.objectContaining({
        colorSlot: 5,
        icon: "👩‍🚀",
        homeWorkspaceId: WB,
        usedWorkspaceIds: [WA, WB],
      }),
    });
    expect(
      a.gate.slice(1).map((g) => [g.subjectType, g.action, g.workspaceId])
    ).toEqual([
      ["link", "create", undefined],
      ["link", "create", undefined],
    ]);
    // The new project's id is the one per-run value in the link gates.
    const sameIds = (x: typeof a) => ({
      ...x,
      gate: x.gate.map((g) => ({
        ...g,
        data: { ...(g.data as object), fromId: "<project>" },
      })),
    });
    expect(sameIds(b)).toEqual(sameIds(a));
  });

  it("a name you already have says so on every door (existing + its name) and writes nothing", async () => {
    const first = await trpc().create({ name: "Orion" });
    expect(first).toMatchObject({ status: "created" });
    const before = await snapshot();
    const id = (first as { projectId: string }).projectId;
    const hit = {
      status: "deduped",
      existing: true,
      projectId: id,
      reusedProjectId: id,
      name: "Orion",
    };

    // Human, both doors — the place's parts and look are NOT applied to it.
    const again = { name: "orion", colorSlot: 2, usedWorkspaceIds: [WB] };
    expect(await trpc().create(again)).toEqual(hit);
    const viaRest = await restCreate(again);
    expect(viaRest.status).toBe(200);
    expect(viaRest.body).toEqual(hit);
    // Agent (the guardrail's own exact-name reuse, before any evidence).
    expect(await trpc(true).create({ name: "ORION" })).toEqual(hit);
    expect((await restCreate({ name: "ORION" }, true)).body).toEqual(hit);

    const after = await snapshot();
    expect(after.projects).toEqual(before.projects);
    expect(after.links).toEqual(before.links);
  });

  it("an unreachable used space or home is refused BEFORE anything is written", async () => {
    await expect(
      trpc().create({ name: "Vega", usedWorkspaceIds: [WA, WZ] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      trpc().create({ name: "Vega", homeWorkspaceId: WZ })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viaRest = await restCreate({ name: "Vega", usedWorkspaceIds: [WZ] });
    expect(viaRest.status).toBe(403);
    const after = await snapshot();
    expect(after.projects).toEqual([]);
    expect(after.links).toEqual([]);
    expect(after.gate).toEqual([]);
  });

  it("a malformed icon is refused on both doors and by the service itself", async () => {
    for (const icon of ["ab", "🚀🚀", "glyph:Rocket"]) {
      await expect(
        trpc().create({ name: "Deneb", icon })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await restCreate({ name: "Deneb", icon })).status).toBe(400);
    }
    // The service guard holds for a caller with no schema (a replay).
    const { createProjectGoverned } = await import("./create-project.js");
    await expect(
      createProjectGoverned({
        userId: U,
        door: "trpc",
        name: "Deneb",
        icon: "ab",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await snapshot()).projects).toEqual([]);
  });

  it("an agent's create carries the place in its proposal and links nothing", async () => {
    const evidence = Array.from({ length: 5 }, () => randomUUID());
    for (const id of evidence) {
      await q(
        `insert into entities (id, user_id, workspace_id, title) values ($1,$2,$3,'e')`,
        [id, U, WA]
      );
    }
    const res = await trpc(true).create({
      ...PLACE,
      name: "Altair",
      evidenceEntityIds: evidence,
    });
    expect(res).toMatchObject({ status: "proposed" });
    const after = await snapshot();
    expect(after.projects).toEqual([]);
    expect(after.links).toEqual([]);
    expect(after.gate).toHaveLength(1);
    expect(after.gate[0]!.data).toMatchObject({
      colorSlot: 5,
      icon: "👩‍🚀",
      homeWorkspaceId: WB,
      usedWorkspaceIds: [WA, WB],
    });
  });

  it("projects.update sets and clears the icon on both doors; a bad one is a 400", async () => {
    const p = await seedProject();
    await trpc().update({ id: p, icon: "glyph:rocket" });
    expect(
      (
        await q<{ icon: string | null }>(
          `select icon from projects where id = $1`,
          [p]
        )
      ).rows[0]!.icon
    ).toBe("glyph:rocket");
    expect((await restPatch(p, { icon: null })).status).toBe(200);
    expect(
      (
        await q<{ icon: string | null }>(
          `select icon from projects where id = $1`,
          [p]
        )
      ).rows[0]!.icon
    ).toBeNull();
    expect((await restPatch(p, { icon: "nope" })).status).toBe(400);
  });
});
