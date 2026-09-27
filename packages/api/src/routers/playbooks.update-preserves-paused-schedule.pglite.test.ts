/**
 * An ADOPTION / metadata merge through `playbooks.update` must never change a
 * backing schedule automation's paused/active state (FX-B1, RV2 S1 + W7) —
 * through the REAL procedure and the REAL `materializePlaybookCronAutomation`
 * on PGlite. Only governance, audit and side effects are stubbed.
 *
 * Shape: the live CRM Hygiene playbook — active, daily 08:00 (`0 8 * * *`),
 * `is-agent` executor, backing automation the user PAUSED directly.
 *
 * Pinned:
 *  - a metadata-only update (what the boot template reconcile writes on
 *    ADOPT) leaves the paused automation paused with no nextRunAt;
 *  - a cron-only change refreshes the trigger, still paused;
 *  - a text edit on an active+enabled playbook with NO backing row creates none;
 *  - disable → re-enable (a real schedule change) DOES arm it again;
 *  - an active backing row stays active across an adoption.
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { playbooksRouter } from "./playbooks.js";

const OWNER = randomUUID();
const CRM = randomUUID();
const PB = randomUUID();
const AUTO = randomUUID();
const HYGIENE_SCHEDULE = { cron: "0 8 * * *", enabled: true };

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

async function automation() {
  const { rows } = await q(
    `select status, next_run_at, trigger_config from automations where id = $1`,
    [AUTO]
  );
  return rows[0] as {
    status: string;
    next_run_at: Date | null;
    trigger_config: { expression?: string };
  };
}
async function automationCount(): Promise<number> {
  const { rows } = await q(`select count(*)::int as n from automations`);
  return (rows[0] as { n: number }).n;
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
  await h.client!.exec(`delete from automations; delete from playbooks;`);
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, next_run_at, metadata)
     values ($1,$2,$3,'CRM Hygiene (schedule)','cron','{"expression":"0 8 * * *"}'::jsonb,'{}'::jsonb,'paused',null,'{}'::jsonb)`,
    [AUTO, CRM, OWNER]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, schedule, flow_automation_id, metadata, version)
     values ($1,$2,$3,'CRM Hygiene','Keep the pipeline healthy','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent',$4::jsonb,$5,'{}'::jsonb,1)`,
    [PB, CRM, OWNER, JSON.stringify(HYGIENE_SCHEDULE), AUTO]
  );
});

describe("playbooks.update never re-arms a paused schedule on adoption", () => {
  it("metadata-only update (boot ADOPT) keeps the paused automation paused", async () => {
    await caller().update({
      id: PB,
      metadata: {
        marketSource: { packageSlug: "crm", packageVersion: "0.13.0" },
      },
    } as never);
    const a = await automation();
    expect(a.status).toBe("paused");
    expect(a.next_run_at).toBeNull();
  });

  it("a cron-only change refreshes the trigger but stays paused", async () => {
    await caller().update({
      id: PB,
      schedule: { cron: "0 9 * * *", enabled: true },
    } as never);
    const a = await automation();
    expect(a.status).toBe("paused");
    expect(a.trigger_config.expression).toBe("0 9 * * *");
  });

  it("a text edit on a playbook with no backing row creates none", async () => {
    await q(`update playbooks set flow_automation_id = null where id = $1`, [
      PB,
    ]);
    await q(`delete from automations`);
    await caller().update({ id: PB, description: "tidy" } as never);
    expect(await automationCount()).toBe(0);
  });

  it("an active backing row stays active across an adoption", async () => {
    await q(
      `update automations set status = 'active', next_run_at = now() where id = $1`,
      [AUTO]
    );
    await caller().update({ id: PB, metadata: { adopted: true } } as never);
    expect((await automation()).status).toBe("active");
  });

  it("a real schedule change (disable → re-enable) arms it", async () => {
    await caller().update({
      id: PB,
      schedule: { ...HYGIENE_SCHEDULE, enabled: false },
    } as never);
    expect((await automation()).status).toBe("paused");
    await caller().update({ id: PB, schedule: HYGIENE_SCHEDULE } as never);
    const { rows } = await q(
      `select status, next_run_at from automations where status = 'active'`
    );
    expect(rows).toHaveLength(1);
    expect(
      (rows[0] as { next_run_at: Date | null }).next_run_at
    ).not.toBeNull();
  });
});
