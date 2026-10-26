/**
 * A status move is a WRITE (security review F1, PR #103): reading a shared
 * pod-wide row never lets a reader move its owner's status. On PGlite through
 * the REAL `moveStatus` door (target resolution, the write floor, the status
 * write) and the REAL session-stage writer `writeStageSubjectStatus`, which
 * accepts its subject on READ visibility. Governance is stubbed to "granted",
 * so only the write floor stands between a reader and the row.
 *
 * Users: OWNER (author, owner of X), MEMBER (editor in X).
 * Rows (OWNER's `decision` kind, lifecycle `decisionStatus`):
 *   HOMED — pod-wide, filed for X: MEMBER READS it (the home share);
 *   IN_X  — stored in X: MEMBER writes it (the workspace floor).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dispatchLifecycleTransition: vi.fn(async () => undefined),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
// The session's process definition (a stage that sets the subject's status)
// and the subject kind — reads of playbook tables, not under test.
vi.mock("@synap/jobs/utils/session-process.js", () => ({
  loadSessionProcess: vi.fn(async () => ({
    stages: [{ key: "decided", name: "Decided", subjectStatus: "decided" }],
    profileSlug: "decision",
    statusProperty: "decisionStatus",
    humanOnlyStatuses: [],
  })),
}));
vi.mock("../playbooks/playbook-activators.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSubjectProfile: vi.fn(async () => ({ profileKind: "kind" })),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entities } from "@synap/database/schema";
import {
  and,
  eq,
  buildStoredConstraints,
  declareLifecycle,
} from "@synap/database";
import { moveStatus } from "./move-status.js";
import { writeStageSubjectStatus } from "../focus-sessions/stage-subject-status.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";

const OWNER = "floor-owner";
const MEMBER = "floor-member";
const X = randomUUID();
const HOMED = randomUUID();
const IN_X = randomUUID();

const MIGRATION_0319 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../database/migrations/0319_lifecycle_columns.sql"
  ),
  "utf8"
);

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
async function statusOf(id: string): Promise<string | null> {
  const { rows } = await q(`select status from entities where id = $1`, [id]);
  return (rows[0] as { status: string | null }).status;
}
const move = (userId: string, entityId: string, to: string) =>
  moveStatus({
    entityId,
    to,
    actor: { kind: "human", userId },
    workspaceId: X,
  });

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(MIGRATION_0319);

  for (const u of [OWNER, MEMBER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@x.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), MEMBER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'X',$2,'team','{}'::jsonb)`,
    [X, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$2,$5,'editor')`,
    [randomUUID(), X, OWNER, randomUUID(), MEMBER]
  );

  const db = h.db as never as {
    insert: (t: unknown) => {
      values: (v: unknown) => { returning: () => Promise<any[]> };
    };
  };
  const [profile] = await db
    .insert(schema.profiles)
    .values({
      slug: "decision",
      displayName: "Decision",
      profileKind: "kind",
      scope: "system",
      entityScope: "pod",
      isActive: true,
    })
    .returning();
  const [def] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "decisionStatus",
      valueType: "string",
      profileId: profile.id,
      constraints: buildStoredConstraints({
        enumOptions: [
          { key: "open", category: "open" },
          { key: "decided", category: "done" },
          { key: "dropped", category: "lost" },
        ],
      }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: profile.id, propertyDefId: def.id })
    .returning();
  await declareLifecycle(h.db as never, {
    profileId: profile.id,
    propertySlug: "decisionStatus",
  });
  for (const [id, ws, home] of [
    [HOMED, null, X],
    [IN_X, X, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, profile_id, type, title, status, status_category, properties, system_data, version)
       values ($1,$2,$3,$4,$5,'decision','A decision','open','open','{"decisionStatus":"open"}'::jsonb,'{}'::jsonb,1)`,
      [id, OWNER, ws, home, profile.id]
    );
  }
}, 120_000);

describe("a status move needs the WRITE floor, not the read floor", () => {
  it("precondition: the home-space member can READ the owner's homed decision", async () => {
    const db = h.db as never as {
      select: (s: unknown) => {
        from: (t: unknown) => { where: (w: unknown) => Promise<unknown[]> };
      };
    };
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(eq(entities.id, HOMED), entityReadVisibleWhere(MEMBER)));
    expect(rows).toHaveLength(1);
  });

  it("the member cannot move it through moveStatus", async () => {
    expect(await move(MEMBER, HOMED, "decided")).toMatchObject({
      status: "refused",
      code: "NOT_FOUND",
    });
    expect(await statusOf(HOMED)).toBe("open");
  });

  it("the member cannot move it through a session stage either", async () => {
    const out = await writeStageSubjectStatus({
      session: {
        id: randomUUID(),
        playbookId: null,
        subjectEntityId: HOMED,
        workspaceId: X,
      },
      toStage: "decided",
      userId: MEMBER,
    });
    expect(out.status).toBe("failed");
    expect(await statusOf(HOMED)).toBe("open");
  });

  it("the owner still moves it, and a member still moves a row stored in the space", async () => {
    expect((await move(OWNER, HOMED, "decided")).status).toBe("moved");
    expect(await statusOf(HOMED)).toBe("decided");
    const out = await writeStageSubjectStatus({
      session: {
        id: randomUUID(),
        playbookId: null,
        subjectEntityId: IN_X,
        workspaceId: X,
      },
      toStage: "decided",
      userId: MEMBER,
    });
    expect(out).toMatchObject({ status: "written", via: "status_door" });
    expect(await statusOf(IN_X)).toBe("decided");
  });
});
