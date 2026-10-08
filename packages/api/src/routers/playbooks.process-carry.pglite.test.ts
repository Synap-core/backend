/**
 * The process keys ride inside `subject_profile` (statusProperty, activators,
 * humanOnlyStatuses), and a `subjectProfile` patch REPLACES that jsonb. Through
 * the REAL `playbooks.update` on PGlite — the door the Hub PATCH (hub
 * `playbooks.update` → `regularPlaybooksRouter.update`) and every editor reach —
 * a patch that restates only `{ profileSlug, filter }` must keep the stored
 * process; only an explicit value changes it.
 *
 * Also pinned here, at the router: archive and a status change re-run the
 * activator pass (only an ACTIVE playbook declares — the applier's own suite
 * covers what the pass then does).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  converged: [] as string[],
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
vi.mock("../services/playbooks/playbook-activators.js", () => ({
  convergePlaybookActivatorsSafely: async (i: { playbookId: string }) => {
    h.converged.push(i.playbookId);
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { playbooksRouter } from "./playbooks.js";

const OWNER = randomUUID();
const WS = randomUUID();
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
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const PROCESS = {
  profileSlug: "post",
  statusProperty: "post-status",
  activators: [{ on: "enters_status", status: "Briefed", mode: "propose" }],
  humanOnlyStatuses: ["Idea"],
};

async function stored(): Promise<Record<string, unknown>> {
  const { rows } = await q(
    `select subject_profile from playbooks where id = $1`,
    [PB]
  );
  return (rows[0] as { subject_profile: Record<string, unknown> })
    .subject_profile;
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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  // The subject kinds the patches bind (the update refuses an unknown slug).
  for (const slug of ["post", "newsletter"]) {
    await q(
      `insert into profiles (id, slug, display_name, scope, is_active) values ($1,$2,$2,'system',true)`,
      [randomUUID(), slug]
    );
  }
}, 120_000);

beforeEach(async () => {
  h.converged = [];
  await h.client!.exec(`delete from playbooks;`);
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, subject_profile, metadata, version)
     values ($1,$2,$3,'Produce Content','Make {post}','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent',$4::jsonb,'{}'::jsonb,1)`,
    [PB, WS, OWNER, JSON.stringify(PROCESS)]
  );
});

describe("a subjectProfile patch keeps the stored process", () => {
  it("restating only { profileSlug, filter } keeps statusProperty, activators and humanOnlyStatuses", async () => {
    await caller().update({
      id: PB,
      subjectProfile: {
        profileSlug: "post",
        filter: { "post-status": "Idea" },
      },
    });
    expect(await stored()).toEqual({
      ...PROCESS,
      filter: { "post-status": "Idea" },
    });
  });

  it("an EXPLICIT value changes a key (activators: [] clears them)", async () => {
    await caller().update({
      id: PB,
      subjectProfile: { profileSlug: "post", activators: [] },
    });
    const sp = await stored();
    expect(sp.activators).toEqual([]);
    expect(sp.statusProperty).toBe("post-status");
  });

  it("binding a DIFFERENT kind carries nothing over", async () => {
    await caller().update({
      id: PB,
      subjectProfile: { profileSlug: "newsletter" },
    });
    expect(await stored()).toEqual({ profileSlug: "newsletter" });
  });
});

describe("what starts it follows the playbook's status", () => {
  it("a status change re-runs the activator pass; a text edit does not", async () => {
    await caller().update({ id: PB, description: "words only" });
    expect(h.converged).toEqual([]);
    await caller().update({ id: PB, status: "draft" });
    expect(h.converged).toEqual([PB]);
  });

  it("archive re-runs the activator pass", async () => {
    await caller().archive({ id: PB });
    expect(h.converged).toEqual([PB]);
  });
});
