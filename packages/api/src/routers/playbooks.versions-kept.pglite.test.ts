/**
 * Every version a playbook takes is KEPT (`playbook_versions`, 0416; spec
 * 7111934d slice 1) — through the REAL `playbooks.create` / `playbooks.update`
 * procedures on PGlite (every table from the Drizzle schema). Only governance,
 * audit and side effects are stubbed.
 *
 * Pinned (the lead's requirement (c), behavioural half of the tripwire
 * `__tripwires__/playbook-version-history.test.ts`):
 *  - a create keeps version 1;
 *  - an edit that changes the definition bumps the version AND keeps it, with
 *    the earlier one still readable as it was;
 *  - an edit that does not change the definition keeps nothing new;
 *  - a step that `uses` a playbook is pinned at the door to its current
 *    version, may pin an older KEPT one, and is refused at one never kept.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
const WS = randomUUID();

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

async function kept(
  playbookId: string
): Promise<Array<{ version: number; definition: Record<string, unknown> }>> {
  const { rows } = await q(
    `select version, definition from playbook_versions where playbook_id = $1 order by version`,
    [playbookId]
  );
  return rows as Array<{
    version: number;
    definition: Record<string, unknown>;
  }>;
}

const stage = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  category: "started" as const,
  ...extra,
});

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Studio',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
}, 120_000);

async function create(name: string, stages: unknown[]): Promise<string> {
  const out = (await caller().create({
    name,
    goalTemplate: `Do ${name}`,
    stages,
  } as never)) as { playbook?: { id: string } };
  expect(out.playbook?.id, `create ${name}`).toBeDefined();
  return out.playbook!.id;
}

describe("playbooks.create / update keep every version", () => {
  it("create keeps v1; a definition edit keeps v2 and v1 stays as it was; a non-definition edit keeps nothing", async () => {
    const id = await create("Transcribe a take", [stage("listen")]);
    expect((await kept(id)).map((r) => r.version)).toEqual([1]);

    await caller().update({
      id,
      stages: [stage("listen"), stage("write")],
    } as never);
    const afterStages = await kept(id);
    expect(afterStages.map((r) => r.version)).toEqual([1, 2]);
    expect(
      (afterStages[0]!.definition.stages as Array<{ key: string }>).map(
        (s) => s.key
      )
    ).toEqual(["listen"]);
    expect(
      (afterStages[1]!.definition.stages as Array<{ key: string }>).map(
        (s) => s.key
      )
    ).toEqual(["listen", "write"]);

    // runner is a definition field (0416): a new version, kept.
    await caller().update({
      id,
      runner: { engine: "claude-code" },
    } as never);
    const afterRunner = await kept(id);
    expect(afterRunner.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(afterRunner[2]!.definition.runner).toEqual({
      engine: "claude-code",
    });

    // metadata is not: no new version.
    await caller().update({ id, metadata: { note: "x" } } as never);
    expect((await kept(id)).map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("a step that uses a playbook is pinned at the door, may pin a kept version, never an unkept one", async () => {
    const used = await create("Render a cut", [stage("render")]);
    await caller().update({
      id: used,
      stages: [stage("render"), stage("export")],
    } as never); // now v2; v1 kept

    const parent = await create("Edit a video", [
      stage("cut"),
      stage("render", { uses: { playbookId: used } }),
    ]);
    const { rows } = await q(`select stages from playbooks where id = $1`, [
      parent,
    ]);
    const stored = (rows[0] as { stages: Array<{ uses?: unknown }> }).stages;
    expect(stored[1]!.uses).toEqual({ playbookId: used, version: 2 });

    await caller().update({
      id: parent,
      stages: [
        stage("cut"),
        stage("render", { uses: { playbookId: used, version: 1 } }),
      ],
    } as never);

    await expect(
      caller().update({
        id: parent,
        stages: [
          stage("cut"),
          stage("render", { uses: { playbookId: used, version: 7 } }),
        ],
      } as never)
    ).rejects.toThrow(/current version is 2/);

    // A playbook kept no earlier version (pre-0416): its v1 is refused.
    await q(`update playbooks set version = 5 where id = $1`, [used]);
    await q(
      `insert into playbook_versions (playbook_id, version, definition) values ($1, 5, '{}'::jsonb)`,
      [used]
    );
    await q(
      `delete from playbook_versions where playbook_id = $1 and version = 2`,
      [used]
    );
    await expect(
      caller().update({
        id: parent,
        stages: [
          stage("cut"),
          stage("render", { uses: { playbookId: used, version: 2 } }),
        ],
      } as never)
    ).rejects.toThrow(/does not keep. Pin one of: 1, 5/);
  });
});
