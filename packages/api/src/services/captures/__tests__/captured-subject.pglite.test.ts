/**
 * W2 door 4 (founder decision 2 A): relay's capture into a WORK session names
 * what that session is ABOUT — the person's anchor, else the ONE entity filed
 * whose kind declares a lifecycle. Never a run, never over an existing subject.
 *
 * Real on PGlite: `nameCapturedSubject`, `capturedSubjectOf` (entities +
 * `ProfileResolutionService.getEffectiveLifecycles`), `projectSessionKind`.
 * Stubbed AT the door: `updateFocusSession` (its own suites own the floor and
 * the write) records the call and writes the subject it was given.
 *
 * The wiring (that `capture.execute` calls it for a PROVIDED session, with
 * what it filed) is asserted against the source, because driving
 * `capture.execute` end to end needs Postgres (`capture.session-parity.test.ts`
 * does the same). That check sees the call and its guard, not its runtime.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});
vi.mock("../../focus-sessions/update-session.js", () => ({
  updateFocusSession: async (p: Record<string, unknown>) => {
    h.updates.push(p);
    await h.client!.query(
      `update focus_sessions set subject_entity_id = $2 where id = $1`,
      [p.sessionId, p.subjectEntityId]
    );
    return { status: "updated" };
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  entities,
  profiles,
  propertyDefs,
  profileProperties,
} from "@synap/database";
import { nameCapturedSubject } from "../captured-subject.js";
import { stripComments } from "../../../../../../scripts/strip-comments.mjs";

const USER = "11111111-1111-4111-8111-111111111111";
const TASK_KIND = "d0000000-0000-4000-8000-000000000001";
const NOTE_KIND = "d0000000-0000-4000-8000-000000000002";
const STATUS_DEF = "d0000000-0000-4000-8000-000000000003";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const entity = async (profileId: string) => {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, profile_id, type, title, properties, created_at, updated_at)
     values ($1, $2, $3, 'x', 'Thing', '{}'::jsonb, now(), now())`,
    [id, USER, profileId]
  );
  return id;
};
async function session(
  opts: {
    origin?: string;
    metadata?: Record<string, unknown>;
    subject?: string | null;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, subject_entity_id, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Capture work', 'active', $3, $4, '[]'::jsonb, '{}', $5::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      opts.origin ?? "human",
      opts.subject ?? null,
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
  return id;
}
const subjectOf = async (sessionId: string) =>
  (
    await q<{ subject_entity_id: string | null }>(
      `select subject_entity_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.subject_entity_id;

describe("nameCapturedSubject (W2 door 4)", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      entities,
      profiles,
      propertyDefs,
      profileProperties,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, created_at, updated_at)
       values ($1, 'task', 'Task', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now()),
              ($2, 'note', 'Note', 'kind', 'system', 'pod', null, true, '{}'::jsonb, now(), now())`,
      [TASK_KIND, NOTE_KIND]
    );
    await q(
      `insert into property_defs (id, slug, value_type, constraints, created_at, updated_at)
       values ($1, 'status', 'enum', $2::jsonb, now(), now())`,
      [
        STATUS_DEF,
        JSON.stringify({
          enumOptions: [
            { key: "todo", label: "To do", category: "open" },
            { key: "done", label: "Done", category: "done" },
          ],
        }),
      ]
    );
    // Only the task kind DECLARES a lifecycle.
    await q(
      `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
      [TASK_KIND, STATUS_DEF]
    );
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.updates.length = 0;
  });

  it("one task filed (with a note) ⇒ the work session's subject is the task", async () => {
    const sid = await session();
    const task = await entity(TASK_KIND);
    const note = await entity(NOTE_KIND);
    const r = await nameCapturedSubject({
      sessionId: sid,
      userId: USER,
      entityIds: [note, task],
    });
    expect(r).toEqual({ status: "named", subjectEntityId: task });
    expect(h.updates).toEqual([
      { sessionId: sid, userId: USER, subjectEntityId: task },
    ]);
    expect(await subjectOf(sid)).toBe(task);
  });

  it("the person's anchor wins over what was filed", async () => {
    const sid = await session();
    const anchor = await entity(NOTE_KIND);
    const task = await entity(TASK_KIND);
    const r = await nameCapturedSubject({
      sessionId: sid,
      userId: USER,
      anchorEntityId: anchor,
      entityIds: [task],
    });
    expect(r).toEqual({ status: "named", subjectEntityId: anchor });
    expect(await subjectOf(sid)).toBe(anchor);
  });

  it("two tasks filed ⇒ no subject, nothing written", async () => {
    const sid = await session();
    const r = await nameCapturedSubject({
      sessionId: sid,
      userId: USER,
      entityIds: [await entity(TASK_KIND), await entity(TASK_KIND)],
    });
    expect(r).toEqual({ status: "skipped", reason: "no_subject" });
    expect(h.updates).toEqual([]);
    expect(await subjectOf(sid)).toBeNull();
  });

  it("a session that already has a subject is never overwritten", async () => {
    const existing = await entity(TASK_KIND);
    const sid = await session({ subject: existing });
    const r = await nameCapturedSubject({
      sessionId: sid,
      userId: USER,
      entityIds: [await entity(TASK_KIND)],
    });
    expect(r).toEqual({ status: "skipped", reason: "has_subject" });
    expect(h.updates).toEqual([]);
    expect(await subjectOf(sid)).toBe(existing);
  });

  it("a RUN (a playbook run, an intake run) is never named here", async () => {
    for (const sid of [
      await session({ origin: "playbook" }),
      await session({ metadata: { intake: { door: "capture" } } }),
    ]) {
      const r = await nameCapturedSubject({
        sessionId: sid,
        userId: USER,
        entityIds: [await entity(TASK_KIND)],
      });
      expect(r).toEqual({ status: "skipped", reason: "not_work" });
    }
    expect(h.updates).toEqual([]);
  });

  it("another person's session is not found", async () => {
    const sid = await session();
    const r = await nameCapturedSubject({
      sessionId: sid,
      userId: "99999999-9999-4999-8999-999999999999",
      entityIds: [await entity(TASK_KIND)],
    });
    expect(r).toEqual({ status: "skipped", reason: "not_found" });
  });
});

describe("capture.execute names the subject of the work session it filed into", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = stripComments(
    readFileSync(join(HERE, "../../../routers/capture.ts"), "utf8"),
    "ts"
  ) as string;

  it("calls nameCapturedSubject for a PROVIDED session, with what it filed, after the produced links", () => {
    const produced = src.indexOf('linkType: "produced" as LinkType');
    expect(produced).toBeGreaterThan(0);
    const call = src.search(
      /if \(runSession\.status === "provided" && created\.length > 0\) \{\s*try \{\s*const named = await nameCapturedSubject\(\{\s*sessionId: runSession\.sessionId,[\s\S]{0,200}?anchorEntityId: input\.anchorEntityId \?\? null,\s*entityIds: created\.map\(\(c\) => c\.entityId\),/
    );
    expect(call).toBeGreaterThan(produced);
  });
});
