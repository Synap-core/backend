/**
 * Write-time property validation (plan item 6, 2026-10-29). Proposal e368ca9e
 * was an agent's `user_observation` create with `uo_category: "preference"`
 * (not in the enum): `entities.create` filed it, and it failed only AT
 * APPROVAL ("Property validation failed for profile …: … not in enum …").
 * The create door now runs the repository's own checks
 * (`validateEntityCreateProperties`, one copy) before its gate.
 *
 * Driven through the REAL `entities.create` and the REAL validator on
 * PGlite; only the gate is recorded. Rows, each ruling out a wrong rule:
 *  - an agent's create with a bad enum value is refused with the field error
 *    and the gate is never reached (nothing filed) — rules out "validated at
 *    approval only";
 *  - an agent's valid create reaches the gate exactly as before — rules out
 *    a door that refuses good writes;
 *  - a person's bad create is still refused by the repository at
 *    materialization — rules out a refactor that dropped the repo's check.
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
     values (gen_random_uuid(),'user_observation','User observation','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  const profileId = (rows[0] as { id: string }).id;
  const def = await q(
    `insert into property_defs (id, slug, profile_id, workspace_id, value_type, constraints, ui_hints)
     values (gen_random_uuid(),'uo_category',$1,null,'string',$2::jsonb,'{}'::jsonb) returning id`,
    [
      profileId,
      JSON.stringify({ enum: ["working_style", "preferences", "habits"] }),
    ]
  );
  await q(
    `insert into profile_properties (profile_id, property_def_id, required, display_order, is_lifecycle)
     values ($1,$2,true,0,false)`,
    [profileId, (def.rows[0] as { id: string }).id]
  );
}, 120_000);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveLifecycle"
  ).mockResolvedValue(null as never);
  h.gate.mockReset().mockResolvedValue({
    proposalId: "prop-1",
    proposalType: "create",
  });
});

function create(input: Record<string, unknown>) {
  return entitiesRouter
    .createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never)
    .create({ profileSlug: "user_observation", ...input } as never) as Promise<
    Record<string, unknown>
  >;
}

async function proposalCount(): Promise<number> {
  const { rows } = await q(`select count(*)::int as n from proposals`);
  return (rows[0] as { n: number }).n;
}

describe("entities.create: properties are validated at write time", () => {
  it("an agent's bad enum value is refused with the field error; nothing is filed", async () => {
    const before = await proposalCount();
    await expect(
      create({
        title: "Founder working preference",
        properties: { uo_category: "preference" },
        agentUserId: AGENT,
        source: "ai",
      })
    ).rejects.toThrow(
      /Property validation failed for profile .*uo_category.*'preference' not in enum.*preferences/
    );
    expect(h.gate).not.toHaveBeenCalled();
    expect(await proposalCount()).toBe(before);
  });

  it("an agent's valid create reaches the gate exactly as before", async () => {
    const out = await create({
      title: "Founder working preference",
      properties: { uo_category: "preferences" },
      agentUserId: AGENT,
      source: "ai",
    });
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toMatchObject({
      subjectType: "entity",
      action: "create",
      data: { properties: { uo_category: "preferences" } },
    });
    expect(out).toMatchObject({ status: "proposed", proposalId: "prop-1" });
  });

  it("a person's bad create is still refused by the repository", async () => {
    h.gate.mockResolvedValue({ allowed: true });
    await expect(
      create({
        title: "My own note on me",
        properties: { uo_category: "preference" },
      })
    ).rejects.toThrow(/Property validation failed for profile .*not in enum/);
    // The person's write reached the gate (no write-time refusal for them):
    // the refusal came from the repository's materialization.
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
});
