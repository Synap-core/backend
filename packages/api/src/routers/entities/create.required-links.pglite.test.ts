/**
 * Required links at the entity create door (D3.2: warn, never refuse), driven
 * through the REAL `entities.create` on PGlite. Only the governance gate is
 * recorded (not run): the assertions are on what the door HANDS it (the
 * `requiredLinks` a pending proposal stores for its card) and on its reply.
 *
 * Rows, each ruling out a wrong rule:
 *  - a touch whose kind requires `relates_to` lands, WARNED — rules out a
 *    refusal, and out a check that never reaches the reply;
 *  - the same create filed as a proposal carries the check to the gate AND
 *    the reply — rules out a card with nothing to show;
 *  - a kind with no required link carries nothing — rules out a warning on
 *    every create;
 *  - a touch whose entity_id property syncs to the required relation, and a
 *    record filed into a project whose kind requires `belongs_to_project`,
 *    carry nothing — rules out a door that warns about the edges it writes
 *    itself (an agent told to add an edge that exists adds a duplicate).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gate: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    registerIdentitySignals: async () => undefined,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileResolutionService } from "@synap/database";
import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { entitiesRouter } from "../entities.js";

const USER = randomUUID();
const AGENT = randomUUID();
const ADA = randomUUID(); // a person
const PROJECT = randomUUID(); // a project the user owns
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'a@x.test', 'agent', $2)`,
    [AGENT, USER]
  );
  const { rows } = await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'outreach-touch','Message','kind','system','pod',null,true,'{}'::jsonb),
            (gen_random_uuid(),'person','Person','kind','system','pod',null,true,'{}'::jsonb),
            (gen_random_uuid(),'deliverable','Deliverable','kind','system','pod',null,true,'{}'::jsonb),
            (gen_random_uuid(),'project','Project','kind','system','pod',null,true,'{}'::jsonb)
     returning id, slug`
  );
  const kind = (slug: string) =>
    (rows as Array<{ id: string; slug: string }>).find((r) => r.slug === slug)!
      .id;
  const def = await q(
    `insert into relation_defs (id, slug, display_name, user_id) values (gen_random_uuid(),'relates_to','Relates to',$1) returning id`,
    [USER]
  );
  await q(
    `insert into profile_relations (source_profile_id, target_profile_id, relation_def_id, metadata)
     values ($1,$2,$3,'{"required":true,"requiredBy":"crm"}'::jsonb)`,
    [kind("outreach-touch"), kind("person"), (def.rows[0] as { id: string }).id]
  );
  // The touch's `contact` property syncs to relates_to → person.
  await q(
    `insert into property_defs (id, slug, profile_id, value_type, relation_def_id, target_profile_id)
     values (gen_random_uuid(),'contact',$1,'entity_id',$2,$3)`,
    [kind("outreach-touch"), (def.rows[0] as { id: string }).id, kind("person")]
  );
  // A deliverable must belong to a project (required by template studio).
  const filing = await q(
    `insert into relation_defs (id, slug, display_name, user_id) values (gen_random_uuid(),'belongs_to_project','Belongs to project',$1) returning id`,
    [USER]
  );
  await q(
    `insert into profile_relations (source_profile_id, target_profile_id, relation_def_id, metadata)
     values ($1,$2,$3,'{"required":true,"requiredBy":"studio"}'::jsonb)`,
    [
      kind("deliverable"),
      kind("project"),
      (filing.rows[0] as { id: string }).id,
    ]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, properties)
     values ($1,$2,'person',$3,'Ada','{}'::jsonb)`,
    [ADA, USER, kind("person")]
  );
  await q(`insert into projects (id, user_id, name) values ($1,$2,'Launch')`, [
    PROJECT,
    USER,
  ]);
}, 120_000);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveLifecycle"
  ).mockResolvedValue(null as never);
  h.gate.mockReset().mockResolvedValue({ allowed: true });
});

function create(input: Record<string, unknown>) {
  return entitiesRouter
    .createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never)
    .create(input as never) as Promise<Record<string, unknown>>;
}

const MISSING = {
  status: "missing",
  missing: [
    {
      kind: "outreach-touch",
      type: "relates_to",
      targetKinds: ["person"],
      requiredBy: "crm",
    },
  ],
};

describe("entities.create: a missing required link warns, never refuses", () => {
  it("a person's touch lands, and the reply names the missing link", async () => {
    const res = await create({
      profileSlug: "outreach-touch",
      title: "First message to Ada",
      source: "user",
    });
    expect(res.status).toBe("created");
    expect(res.requiredLinks).toEqual(MISSING);
    expect(h.gate.mock.calls[0]![0].requiredLinks).toEqual(MISSING);
  });

  it("an agent's touch filed for review carries the check to the card and the reply", async () => {
    h.gate.mockResolvedValue({
      proposalId: "proposal-1",
      proposalType: "entity.create",
      reviewUrl: "https://pod.test/open/proposal-1",
    });
    const res = await create({
      profileSlug: "outreach-touch",
      title: "Follow-up to Ada",
      agentUserId: AGENT,
      source: "ai",
    });
    expect(res.status).toBe("proposed");
    expect(h.gate.mock.calls[0]![0].requiredLinks).toEqual(MISSING);
    expect(res.requiredLinks).toEqual(MISSING);
  });

  it("a kind with no required link carries nothing", async () => {
    const res = await create({
      profileSlug: "person",
      title: "Grace Hopper",
      source: "user",
    });
    expect(res.status).toBe("created");
    expect(res).not.toHaveProperty("requiredLinks");
    expect(h.gate.mock.calls[0]![0]).not.toHaveProperty("requiredLinks");
  });

  it("a touch whose contact property syncs to the required relates_to carries nothing", async () => {
    const res = await create({
      profileSlug: "outreach-touch",
      title: "Note to Ada",
      properties: { contact: ADA },
      source: "user",
    });
    expect(res.status).toBe("created");
    expect(res).not.toHaveProperty("requiredLinks");
    expect(h.gate.mock.calls[0]![0]).not.toHaveProperty("requiredLinks");
  });

  it("a deliverable filed into a project carries nothing; one filed nowhere warns", async () => {
    const filed = await create({
      profileSlug: "deliverable",
      title: "Launch deck",
      projectId: PROJECT,
      source: "user",
    });
    expect(filed.status).toBe("created");
    expect(filed).not.toHaveProperty("requiredLinks");

    const loose = await create({
      profileSlug: "deliverable",
      title: "Loose deck",
      source: "user",
    });
    expect(loose.requiredLinks).toEqual({
      status: "missing",
      missing: [
        {
          kind: "deliverable",
          type: "belongs_to_project",
          targetKinds: ["project"],
          requiredBy: "studio",
        },
      ],
    });
  });
});
