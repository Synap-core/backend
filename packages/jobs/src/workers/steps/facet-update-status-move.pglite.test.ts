/**
 * An automation moves a ROLE's status (founder decision 2026-11-09: an
 * editable catalog automation moves a lead outreach → engaged on an inbound
 * reply). The `facet_update` output node routes the role's lifecycle value to
 * the ONE automation move door (`moveStatusFromAutomation`), exactly as
 * `entity_update` does for a kind; before, the facet verb's repository refused
 * any status change, so the rule had nothing to call.
 *
 * Real Postgres (PGlite): the real target resolution, the real compare-and-set
 * on `entity_facets`, the real `works_at` hop. Only the governance gate (its
 * own ladder is tested where it lives: here we pin what it is ASKED and that
 * its verdict is obeyed) and the event delivery are replaced.
 *
 * Rows that rule out a wrong rule: a lead at `qualified` (a reply must never
 * pull it back), a person with no lead and no company (every inbound message
 * fires the rule), a humanOnly target (governed like a kind's, never written).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | { exec: (sql: string) => Promise<unknown> },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

const gate = vi.hoisted(() => ({
  fn: null as null | ((o: unknown) => unknown),
}));
const calls = vi.hoisted(() => ({
  gate: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchLifecycleTransition: async () => undefined,
    emitSideEffects: async () => undefined,
  };
});
vi.mock("../../utils/automation-governance.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkAutomationWriteOrPropose: async (o: Record<string, unknown>) => {
      calls.gate.push(o);
      return gate.fn!(o);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildStoredConstraints, declareLifecycle } from "@synap/database";
import { executeOutputStep } from "./output.js";
import type { StepContext } from "../automation-executor-types.js";

const OWNER = randomUUID();
const SPACE = randomUUID();

const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();
const DEAL_KIND = randomUUID();
const LEAD_ROLE = randomUUID();

const AT_OUTREACH = randomUUID(); // a person wearing lead at outreach
const AT_QUALIFIED = randomUUID(); // a person wearing lead at qualified
const EMPLOYEE = randomUUID(); // a person with no lead, works_at COMPANY
const COMPANY = randomUUID(); // a company wearing lead at outreach
const STRANGER = randomUUID(); // a person with no lead and no company
const DEAL = randomUUID(); // a kind with a humanOnly option, for parity

const F_OUTREACH = randomUUID();
const F_QUALIFIED = randomUUID();
const F_COMPANY = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

/** Every schema table, derived from drizzle so a new column never breaks this. */
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
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const ctx = {
  trigger: { payload: {}, subject: null },
  steps: {},
  automation: { id: "a1", state: {} },
} as unknown as StepContext;

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "run-1",
  chainAutomationIds: [] as string[],
};

const run = (outputType: string, config: Record<string, unknown>) =>
  executeOutputStep(
    { outputType, config },
    ctx,
    SPACE,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-1", stepRunId: "sr-1" }
  );

/** The reply rule's node, verbatim the shape the catalog ships. */
const replyMovesLead = (
  entityId: string,
  extra: Record<string, unknown> = {}
) =>
  run("facet_update", {
    entityId,
    facetSlug: "lead",
    viaRelation: "works_at",
    expectedStatus: "outreach",
    status: "engaged",
    ...extra,
  });

async function facet(id: string) {
  const db = (await h.init()) as any;
  const { eq } = await import("drizzle-orm");
  const [f] = await db
    .select()
    .from(schema.entityFacets)
    .where(eq(schema.entityFacets.id, id));
  return f as { status: string | null; properties: Record<string, unknown> };
}

async function lifecycle(profileId: string, slug: string, options: unknown[]) {
  const db = (await h.init()) as any;
  const defId = randomUUID();
  await db.insert(schema.propertyDefs).values({
    id: defId,
    slug,
    valueType: "string",
    profileId,
    constraints: buildStoredConstraints({ enumOptions: options as never }),
  });
  await db
    .insert(schema.profileProperties)
    .values({ profileId, propertyDefId: defId });
  await declareLifecycle(db, { profileId, propertySlug: slug });
}

beforeAll(async () => {
  await h.init();
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => {
      try {
        getTableConfig(t as PgTable);
        return true;
      } catch {
        return false;
      }
    }
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await h.client!.exec(`
    insert into profiles (id, slug, display_name, profile_kind, is_active, workspace_id) values
      ('${PERSON_KIND}', 'person', 'Person', 'kind', true, null),
      ('${COMPANY_KIND}', 'company', 'Company', 'kind', true, null),
      ('${DEAL_KIND}', 'deal', 'Deal', 'kind', true, null),
      ('${LEAD_ROLE}', 'lead', 'Lead', 'role', true, null);
  `);
  // The catalog's lead lifecycle (foundation.yaml), humanOnly ends included.
  await lifecycle(LEAD_ROLE, "leadStage", [
    { key: "new", category: "open" },
    { key: "outreach", category: "open" },
    { key: "engaged", category: "active" },
    { key: "qualified", category: "active" },
    { key: "converted", category: "done", humanOnly: true },
    { key: "disqualified", category: "lost", humanOnly: true },
  ]);
  await lifecycle(DEAL_KIND, "commercialStage", [
    { key: "draft", category: "open" },
    { key: "won", category: "done", humanOnly: true },
  ]);
  await h.client!.exec(`
    insert into entities (id, user_id, workspace_id, type, profile_id, title, status, properties) values
      ('${AT_OUTREACH}', '${OWNER}', null, 'person', '${PERSON_KIND}', 'Ada', null, '{}'),
      ('${AT_QUALIFIED}', '${OWNER}', null, 'person', '${PERSON_KIND}', 'Grace', null, '{}'),
      ('${EMPLOYEE}', '${OWNER}', null, 'person', '${PERSON_KIND}', 'Linus', null, '{}'),
      ('${COMPANY}', '${OWNER}', null, 'company', '${COMPANY_KIND}', 'Acme', null, '{}'),
      ('${STRANGER}', '${OWNER}', null, 'person', '${PERSON_KIND}', 'Nobody', null, '{}'),
      ('${DEAL}', '${OWNER}', '${SPACE}', 'deal', '${DEAL_KIND}', 'Acme deal', 'draft', '{"commercialStage":"draft"}');
    insert into entity_facets (id, entity_id, profile_id, workspace_id, user_id, status, properties) values
      ('${F_OUTREACH}', '${AT_OUTREACH}', '${LEAD_ROLE}', null, '${OWNER}', 'outreach', '{"leadStage":"outreach","icpScore":4}'),
      ('${F_QUALIFIED}', '${AT_QUALIFIED}', '${LEAD_ROLE}', null, '${OWNER}', 'qualified', '{"leadStage":"qualified"}'),
      ('${F_COMPANY}', '${COMPANY}', '${LEAD_ROLE}', null, '${OWNER}', 'outreach', '{"leadStage":"outreach"}');
    insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values
      ('${randomUUID()}', '${OWNER}', null, '${EMPLOYEE}', '${COMPANY}', 'works_at');
  `);
}, 120_000);

beforeEach(() => {
  calls.gate = [];
  gate.fn = () => ({ granted: true });
});

describe("facet_update moves a role's status through the move door", () => {
  it("a reply moves a lead at outreach to engaged: column and projection, governed as a transition", async () => {
    const out = await replyMovesLead(AT_OUTREACH);
    expect(out).toMatchObject({
      status: "moved",
      facetId: F_OUTREACH,
      from: "outreach",
      to: "engaged",
    });
    const f = await facet(F_OUTREACH);
    expect(f.status).toBe("engaged");
    expect(f.properties).toMatchObject({ leadStage: "engaged", icpScore: 4 });
    expect(calls.gate).toHaveLength(1);
    expect(calls.gate[0]).toMatchObject({
      subjectType: "entity",
      action: "transition",
      lifecycleMove: { intoTerminal: false, humanOnly: false },
      data: {
        entityId: AT_OUTREACH,
        role: "lead",
        facetId: F_OUTREACH,
        property: "leadStage",
        expectedFrom: "outreach",
        to: "engaged",
      },
    });
  });

  it("a lead at qualified is skipped: never pulled back, nothing governed or written", async () => {
    const out = await replyMovesLead(AT_QUALIFIED);
    expect(out).toMatchObject({
      status: "skipped",
      reason: "not_at_expected_status",
      expectedStatus: "outreach",
      actual: "qualified",
    });
    expect((await facet(F_QUALIFIED)).status).toBe("qualified");
    expect(calls.gate).toHaveLength(0);
  });

  it("a person with no lead reaches their company's lead through works_at", async () => {
    const out = await replyMovesLead(EMPLOYEE);
    expect(out).toMatchObject({ status: "moved", facetId: F_COMPANY });
    expect((await facet(F_COMPANY)).status).toBe("engaged");
    expect(calls.gate[0]).toMatchObject({
      data: { entityId: COMPANY, facetId: F_COMPANY },
    });
  });

  it("a person who is no lead (and has no company) is skipped, not a failed run", async () => {
    const out = await replyMovesLead(STRANGER);
    expect(out).toMatchObject({ status: "skipped", reason: "no_role" });
    expect(calls.gate).toHaveLength(0);
  });

  it("without a condition, a missing role still fails loud (the old answer)", async () => {
    await expect(
      run("facet_update", {
        entityId: STRANGER,
        facetSlug: "lead",
        status: "engaged",
      })
    ).rejects.toThrow();
    expect(calls.gate).toHaveLength(0);
  });
});

describe("a humanOnly target is governed exactly like a kind's", () => {
  it("the role move asks the gate what the kind move asks, and a proposal writes nothing", async () => {
    gate.fn = () => ({ proposed: true, proposalId: "p-role" });
    const role = await run("facet_update", {
      facetId: F_COMPANY,
      status: "converted",
    });
    expect(role).toMatchObject({
      status: "proposed",
      proposalId: "p-role",
      facetId: F_COMPANY,
    });
    expect((await facet(F_COMPANY)).status).toBe("engaged");

    gate.fn = () => ({ proposed: true, proposalId: "p-kind" });
    const kind = await run("entity_update", {
      entityId: DEAL,
      properties: { commercialStage: "won" },
    });
    expect(kind).toMatchObject({ status: "proposed", proposalId: "p-kind" });

    const [roleAsk, kindAsk] = calls.gate;
    const shape = (o: Record<string, unknown>) => ({
      subjectType: o.subjectType,
      action: o.action,
      lifecycleMove: o.lifecycleMove,
      ownerId: o.ownerId,
      workspaceId: o.workspaceId,
      automationRunId: o.automationRunId,
    });
    expect(shape(roleAsk)).toEqual(shape(kindAsk));
    expect(roleAsk.lifecycleMove).toEqual({
      intoTerminal: true,
      humanOnly: true,
    });
  });

  it("a denied role move fails the node as a policy block, writing nothing", async () => {
    gate.fn = () => ({ denied: true, reason: "no" });
    await expect(
      run("facet_update", { facetId: F_COMPANY, status: "disqualified" })
    ).rejects.toThrow(/denied by governance/);
    expect((await facet(F_COMPANY)).status).toBe("engaged");
  });
});
