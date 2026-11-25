/**
 * A template reconcile re-declares a playbook's activators through the REAL
 * `playbooks.update` door (PGlite): a schedule it declares with no zone keeps
 * the zone stored on the installed activator (a folded schedule's UTC), so a
 * reconcile never moves when it fires. Only a declaration naming a zone
 * changes it; a new schedule names none (its owner's zone at compile).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
// The rule compile is the activator suites'; here only what the door stores.
vi.mock(
  "../services/playbooks/playbook-activators.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    convergePlaybookActivatorsSafely: vi.fn(async () => undefined),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { playbooksRouter } from "./playbooks.js";

const OWNER = randomUUID();
const CRM = randomUUID();
const PB = randomUUID();

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "version"
          ? " default 1"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const caller = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: CRM,
    workspaceRole: "owner",
  } as never);

const FOLDED = {
  on: "schedule",
  cron: "0 8 * * *",
  timezone: "UTC",
  mode: "run",
};

async function activators(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await q(
    `select subject_profile from playbooks where id = $1`,
    [PB]
  );
  return ((rows[0] as { subject_profile: { activators?: unknown[] } })
    .subject_profile.activators ?? []) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [CRM, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), CRM, OWNER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from playbooks;`);
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, subject_profile, metadata, version)
     values ($1,$2,$3,'CRM Hygiene','Keep the pipeline healthy','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent',$4::jsonb,'{}'::jsonb,1)`,
    [PB, CRM, OWNER, JSON.stringify({ activators: [FOLDED] })]
  );
});

const redeclare = (activator: Record<string, unknown>) =>
  caller().update({
    id: PB,
    subjectProfile: { activators: [activator] },
  } as never);

describe("playbooks.update — a re-declared schedule keeps its stored zone", () => {
  it("a zone-less re-declaration (the catalog's) keeps the folded UTC", async () => {
    await redeclare({ on: "schedule", cron: "0 8 * * *", mode: "run" });
    expect(await activators()).toEqual([FOLDED]);
  });

  it("a declaration naming a zone changes it", async () => {
    await redeclare({
      on: "schedule",
      cron: "0 8 * * *",
      timezone: "Europe/Paris",
      mode: "run",
    });
    expect((await activators())[0]!.timezone).toBe("Europe/Paris");
  });

  it("a new schedule names no zone: it compiles in its owner's", async () => {
    await redeclare({ on: "schedule", cron: "0 9 * * *", mode: "run" });
    expect((await activators())[0]).not.toHaveProperty("timezone");
  });
});
