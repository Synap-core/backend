/**
 * The ONE duplicate door at the entity create door (FB1020 B2, founder-approved
 * 2026-10-21), driven through the REAL `entities.create` on PGlite. Only the
 * governance gate is recorded (not run): the assertions are on what the door
 * HANDS it — `possibleDuplicate` (the POSSIBLE_DUPLICATE floor, tested in
 * `@synap/governance-policy`) and the `duplicateCheck` it persists.
 *
 * Rows, each ruling out a wrong rule:
 *  - an agent's same-name create is FILED (gate called, floored), never refused
 *    — rules out the old CONFLICT + `forceCreate` escape;
 *  - an agent's create with no twin is not floored — rules out "every agent
 *    create is a proposal";
 *  - an agent's create that matches its OWN PENDING create is floored, the
 *    candidate is the proposal — rules out a records-only check;
 *  - a person's same-name create lands WARNED — rules out blocking people (B2e);
 *  - an approval replay refuses a twin RECORD with candidates, `keep_both`
 *    lands it — the reviewer owns the twin (B2b);
 *  - an agent cannot pass the reviewer's flag — rules out a renamed forceCreate;
 *  - the same agent's identical retry is the retry class, not floored.
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
import { entitiesRouter } from "../entities.js";

const USER = randomUUID();
const AGENT = randomUUID();
const ADA = randomUUID();
const RETRY = randomUUID();
const PENDING = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
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
  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'a@x.test', 'agent', $2)`,
    [AGENT, USER]
  );
  const { rows } = await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'person','Person','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  const personId = (rows[0] as { id: string }).id;
  // A record the person already has.
  await q(
    `insert into entities (id, user_id, type, profile_id, title, properties, workspace_id, created_at)
     values ($1,$2,'person',$3,'Ada Lovelace','{}'::jsonb,null, now() - interval '1 day')`,
    [ADA, USER, personId]
  );
  // A record the SAME agent created a moment ago (the retry class).
  await q(
    `insert into entities (id, user_id, agent_user_id, type, profile_id, title, properties, workspace_id)
     values ($1,$2,$3,'person',$4,'Bo Retry','{"city":"Paris"}'::jsonb,null)`,
    [RETRY, USER, AGENT, personId]
  );
  // A create the agent filed earlier, still waiting for review.
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, status, created_by, agent_user_id, subject_user_id, data)
     values ($1,'entity',$2,'create','pending',$3,$3,$4,$5::jsonb)`,
    [
      PENDING,
      randomUUID(),
      AGENT,
      USER,
      JSON.stringify({
        requestId: randomUUID(),
        targetType: "entity",
        changeType: "create",
        data: { id: randomUUID(), profileSlug: "person", title: "Pat Pending" },
      }),
    ]
  );
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
    .create({ profileSlug: "person", ...input } as never) as Promise<
    Record<string, unknown>
  >;
}

/** What the door handed the gate on its one call. */
function gateArgs(): {
  possibleDuplicate?: boolean;
  duplicateCheck?: {
    status: string;
    candidates: Array<{ ref: string; id: string; why: string }>;
  };
} {
  expect(h.gate).toHaveBeenCalledTimes(1);
  return h.gate.mock.calls[0]![0];
}

describe("entities.create: the one duplicate door", () => {
  it("an agent's same-name create is FILED for review, floored, with the twin as a door", async () => {
    await create({ title: "Ada Lovelace", agentUserId: AGENT, source: "ai" });
    const args = gateArgs();
    expect(args.possibleDuplicate).toBe(true);
    expect(args.duplicateCheck).toMatchObject({
      status: "possible",
      subject: "entity",
      candidates: expect.arrayContaining([
        {
          ref: "record",
          id: ADA,
          kind: "person",
          title: "Ada Lovelace",
          why: "same_name",
        },
      ]),
    });
  });

  it("an agent's create with no twin is not floored, and says it looked", async () => {
    await create({ title: "Zed Nobody", agentUserId: AGENT, source: "ai" });
    const args = gateArgs();
    expect(args.possibleDuplicate).toBe(false);
    expect(args.duplicateCheck).toMatchObject({
      status: "clear",
      candidates: [],
    });
  });

  it("an agent's create matching its OWN pending create is floored, the twin is the proposal", async () => {
    await create({ title: "pat  pending", agentUserId: AGENT, source: "ai" });
    const args = gateArgs();
    expect(args.possibleDuplicate).toBe(true);
    expect(args.duplicateCheck?.candidates).toEqual([
      expect.objectContaining({
        ref: "proposal",
        id: PENDING,
        why: "same_name",
      }),
    ]);
  });

  it("a person's same-name create lands, WARNED — never blocked, never floored", async () => {
    const res = await create({ title: "Ada Lovelace", source: "user" });
    expect(gateArgs().possibleDuplicate).toBe(false);
    expect(res.status).toBe("created");
    expect(res.id).not.toBe(ADA);
    expect(res.duplicateCheck).toMatchObject({
      status: "possible",
      candidates: expect.arrayContaining([
        expect.objectContaining({ id: ADA }),
      ]),
    });
  });

  it("an approval replay refuses a twin record so the reviewer picks a verb", async () => {
    await expect(
      create({
        title: "Ada Lovelace",
        source: "system",
        approvalDuplicate: "ask_reviewer",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      cause: {
        code: "ENTITY_WEAK_DEDUP",
        candidates: expect.arrayContaining([
          expect.objectContaining({ id: ADA, type: "person" }),
        ]),
      },
    });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("the reviewer's keep both lands the twin", async () => {
    const res = await create({
      title: "Ada Lovelace",
      source: "system",
      approvalDuplicate: "keep_both",
    });
    expect(res.status).toBe("created");
    expect(res.id).not.toBe(ADA);
  });

  it("an agent cannot pass the reviewer's flag: its twin is still floored", async () => {
    await create({
      title: "Ada Lovelace",
      agentUserId: AGENT,
      source: "ai",
      approvalDuplicate: "keep_both",
    });
    expect(gateArgs().possibleDuplicate).toBe(true);
  });

  it("the same agent's identical retry is the retry class, not floored", async () => {
    await create({
      title: "Bo Retry",
      agentUserId: AGENT,
      source: "ai",
      properties: { city: "Paris" },
    });
    const args = gateArgs();
    expect(args.duplicateCheck?.status).toBe("possible");
    expect(args.possibleDuplicate).toBe(false);
  });

  it("the same agent re-filing the name with OTHER content is floored", async () => {
    await create({
      title: "Bo Retry",
      agentUserId: AGENT,
      source: "ai",
      properties: { city: "Lyon" },
    });
    expect(gateArgs().possibleDuplicate).toBe(true);
  });
});
