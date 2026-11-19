/**
 * The W3 backfill (`backfill-session-spaces.ts`): a session with no space,
 * filed in a project with a home space, moves there through THE move (room
 * and artifacts with it), as its owner, stamped `project_home`; a refusal is
 * reported with its reason; a receipt, a session with no project, a project
 * with no home stay; the `'null'` template strings clear. Dry run writes
 * nothing.
 *
 * Real: `backfillSessionSpaces`, `checkSessionWorkspaceMove` (the write floor
 * and the room-seat check) and `applySessionWorkspaceMove`, on PGlite with
 * every @synap/database table. Cannot see: production FKs and enums.
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { backfillSessionSpaces } from "../backfill-session-spaces.js";

const OWNER = randomUUID();
const OUTSIDER = randomUUID(); // a person seated in one room, not in BUILDER
const BUILDER = randomUUID();
const P_BUILDER = randomUUID(); // homed in BUILDER
const P_NO_HOME = randomUUID();

const S = {
  move: randomUUID(),
  seatRefused: randomUUID(),
  receipt: randomUUID(),
  noHome: randomUUID(),
  noProject: randomUUID(),
  placed: randomUUID(), // already in BUILDER
  nullTemplate: randomUUID(),
};
const ROOM = { move: randomUUID(), seatRefused: randomUUID() };

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "started_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const space = async (id: string) =>
  (
    await q<{ workspace_id: string | null; metadata: Record<string, unknown> }>(
      `select workspace_id, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1,'o@x.test','Owner','human'),($2,'x@x.test','Outsider','human')`,
    [OWNER, OUTSIDER]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1,'Builder',$2)`, [
    BUILDER,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), BUILDER, OWNER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name) values ($1,$3,$4,'Synap'),($2,$3,null,'Loose')`,
    [P_BUILDER, P_NO_HOME, OWNER, BUILDER]
  );
  const session = (
    id: string,
    ws: string | null,
    project: string | null,
    extra: { room?: string; metadata?: object; templateId?: string } = {}
  ) =>
    q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, channel_id, template_id, goal, status, expected_outputs, metadata)
       values ($1,$2,$3,$4,$5,$6,'Work','active','[]'::jsonb,$7::jsonb)`,
      [
        id,
        OWNER,
        ws,
        project,
        extra.room ?? null,
        extra.templateId ?? null,
        JSON.stringify(extra.metadata ?? {}),
      ]
    );
  await session(S.move, null, P_BUILDER, { room: ROOM.move });
  await session(S.seatRefused, null, P_BUILDER, { room: ROOM.seatRefused });
  await session(S.receipt, null, P_BUILDER, {
    metadata: { kind: "agent-proposal-package", autoOpened: true },
  });
  await session(S.noHome, null, P_NO_HOME);
  await session(S.noProject, null, null);
  await session(S.placed, BUILDER, P_BUILDER);
  await session(S.nullTemplate, BUILDER, null, { templateId: "null" });

  for (const [room, sessionId] of [
    [ROOM.move, S.move],
    [ROOM.seatRefused, S.seatRefused],
  ] as const) {
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id)
       values ($1,$2,null,'group','pod','active','Room','focus_session',$3)`,
      [room, OWNER, sessionId]
    );
  }
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind) values ($1,$2,$3,'human')`,
    [randomUUID(), ROOM.seatRefused, OUTSIDER]
  );
  await q(
    `insert into artifacts (id, session_id, workspace_id, user_id, kind, title) values ($1,$2,null,$3,'document','Out')`,
    [randomUUID(), S.move, OWNER]
  );
}, 120_000);

describe("backfillSessionSpaces", () => {
  it("DRY RUN: reports what would move and each refusal, writes nothing", async () => {
    const r = await backfillSessionSpaces({ apply: false });
    expect(r.candidates).toBe(3); // move, seatRefused, receipt
    expect(r.moved).toEqual([{ sessionId: S.move, workspaceId: BUILDER }]);
    expect(r.refused.map((x) => x.sessionId)).toEqual([S.seatRefused]);
    expect(r.refused[0]!.reason).toMatch(/not a member of that space/);
    expect(r.receiptsKept).toBe(1);
    expect(r.nullTemplateIds).toBe(1);
    expect((await space(S.move)).workspace_id).toBeNull();
    expect(
      (
        await q(`select template_id from focus_sessions where id = $1`, [
          S.nullTemplate,
        ])
      ).rows[0]
    ).toEqual({ template_id: "null" });
  });

  it("APPLY: moves the session with its room and artifacts, stamped project_home", async () => {
    const r = await backfillSessionSpaces({ apply: true });
    expect(r.moved).toEqual([{ sessionId: S.move, workspaceId: BUILDER }]);
    const moved = await space(S.move);
    expect(moved.workspace_id).toBe(BUILDER);
    expect(moved.metadata.workspacePlacement).toEqual({ rung: "project_home" });
    expect(
      (
        await q(`select workspace_id, scope from channels where id = $1`, [
          ROOM.move,
        ])
      ).rows[0]
    ).toEqual({ workspace_id: BUILDER, scope: "workspace" });
    expect(
      (
        await q(`select workspace_id from artifacts where session_id = $1`, [
          S.move,
        ])
      ).rows[0]
    ).toEqual({ workspace_id: BUILDER });
    expect(r.nullTemplateIds).toBe(1);
    expect(
      (
        await q(`select template_id from focus_sessions where id = $1`, [
          S.nullTemplate,
        ])
      ).rows[0]
    ).toEqual({ template_id: null });
  });

  it("leaves the refused, the receipt, the homeless and the unfiled where they were", async () => {
    for (const id of [S.seatRefused, S.receipt, S.noHome, S.noProject]) {
      expect((await space(id)).workspace_id, id).toBeNull();
    }
    expect((await space(S.placed)).workspace_id).toBe(BUILDER);
  });

  it("is idempotent: a second run finds nothing more to move", async () => {
    const r = await backfillSessionSpaces({ apply: true });
    expect(r.moved).toEqual([]);
    expect(r.nullTemplateIds).toBe(0);
  });
});
