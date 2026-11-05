/**
 * BIND ON FACTS through the real doors, on PGlite (founder decisions d01–d03,
 * 2026-11-05): `createFocusSession { bindOnFacts }` binds the playbook a FACT
 * names, and `updateFocusSession` re-runs the facts ONCE when a subject first
 * arrives. Every bind goes through the real follow door (`followPlaybook`):
 * `playbookId`, a `playbook_runs` row, `metadata.boundBy`.
 *
 * Real: `createFocusSession`, `updateFocusSession`, `followPlaybook`,
 * `bindOnFacts`, the facts ladder. Stubbed: governance (granted), the session
 * room, realtime, block guidance, project placement, the spawn edge, and the
 * TEXT matcher (it returns one candidate, so a reply can be seen dropping it
 * when a fact binds).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    parents: new Map<string, string>(),
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
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    recordSessionSpawn: async (p: {
      childSessionId: string;
      parentSessionId: string;
    }) => {
      h.parents.set(p.childSessionId, p.parentSessionId);
      return { linked: true, suspendedIntentRecorded: false };
    },
    getParentSessionId: async (id: string) => h.parents.get(id) ?? null,
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../ensure-session-channel.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));
vi.mock("../match-session-template.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  matchSessionTemplate: async () => ({
    candidates: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        name: "Words matched",
        score: 1,
        reason: "You mentioned “bug”",
        scope: "session",
        templateKind: "Work template",
      },
    ],
    optOut: "pass templateId: null",
  }),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { updateFocusSession } from "../update-session.js";
import { BINDING_LINE_MAX } from "../resolve-binding-rung.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "11111111-1111-4111-8111-111111111111";
const ISSUE_PROFILE = randomUUID();
const NOTE_PROFILE = randomUUID();
const FIX = randomUUID(); // active, runs on an issue
const DRAFT_FOR_TASK = randomUUID(); // draft, runs on a task
const TASK_PROFILE = randomUUID();
const OTHER = randomUUID(); // active, no subject

async function insertPlaybook(
  id: string,
  name: string,
  status: string,
  subjectProfile: unknown
) {
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, version, status, scope, created_at, updated_at)
     values ($1, null, $2, $3, $3, 'external-agent', '[]'::jsonb,
             $4::jsonb, '[]'::jsonb, '[]'::jsonb, $5::jsonb, 1, $6, 'session', now(), now())`,
    [
      id,
      USER,
      name,
      JSON.stringify([
        { key: `${name.toLowerCase().replace(/\W+/g, "-")}-done`, statement: `${name} done`, check: { kind: "human" } },
      ]),
      subjectProfile === null ? null : JSON.stringify(subjectProfile),
      status,
    ]
  );
}

async function entityOf(profileId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, created_at, updated_at)
     values ($1, $2, null, $3, 'x', 'A thing', '{}'::jsonb, now(), now())`,
    [id, USER, profileId]
  );
  return id;
}

type Row = {
  playbook_id: string | null;
  metadata: Record<string, unknown>;
};
const rowOf = async (id: string): Promise<Row> =>
  (
    await q<Row>(
      `select playbook_id, metadata from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;
const runsOf = async (id: string) =>
  (
    await q<{ playbook_id: string }>(
      `select playbook_id from playbook_runs where session_id = $1`,
      [id]
    )
  ).rows;

const start = async (extra: Record<string, unknown> = {}) => {
  const res = await createFocusSession({
    userId: USER,
    goal: `Fix the bug ${randomUUID()}`,
    matchTemplate: true,
    bindOnFacts: true,
    forceCreate: true,
    ...extra,
  });
  if (res.status !== "created") throw new Error(res.status);
  return res;
};

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table the generator cannot express is not read by these doors.
      }
    }
  }
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  for (const [id, slug] of [
    [ISSUE_PROFILE, "issue"],
    [NOTE_PROFILE, "note"],
    [TASK_PROFILE, "task"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, scope, created_at, updated_at) values ($1, $2, $2, 'system', now(), now())`,
      [id, slug]
    );
  }
  await insertPlaybook(FIX, "Fix a bug", "active", { profileSlug: "issue" });
  await insertPlaybook(DRAFT_FOR_TASK, "Do a task", "draft", {
    profileSlug: "task",
  });
  await insertPlaybook(OTHER, "Something else", "active", null);
}, 120_000);

describe("at start: a fact binds through the follow door", () => {
  it("the subject's kind binds its one active playbook, recorded on boundBy, said in ONE line", async () => {
    const res = await start({ subjectEntityId: await entityOf(ISSUE_PROFILE) });
    const row = await rowOf(res.session.id);
    expect(row.playbook_id).toBe(FIX);
    expect(row.metadata.boundBy).toMatchObject({
      rung: "subject",
      playbookId: FIX,
      phase: "start",
    });
    expect(row.metadata.followedVia).toBe("attach");
    expect(await runsOf(res.session.id)).toEqual([{ playbook_id: FIX }]);
    expect(res.session.playbookId).toBe(FIX);
    expect(res.binding).toContain(FIX);
    expect(res.binding!.length).toBeLessThanOrEqual(BINDING_LINE_MAX);
    // The words were never going to bind; the ranked block is dropped.
    expect(res.playbooks).toBeUndefined();
  });

  it("a DRAFT playbook for the subject's kind binds nothing: the start is as before", async () => {
    const res = await start({ subjectEntityId: await entityOf(TASK_PROFILE) });
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
    expect(res.binding).toBeUndefined();
    expect(await runsOf(res.session.id)).toEqual([]);
    // The text suggestions ride as before.
    expect(res.playbooks?.candidates).toHaveLength(1);
  });

  it("a door that does not ask (a person's start) binds nothing", async () => {
    const res = await start({
      subjectEntityId: await entityOf(ISSUE_PROFILE),
      bindOnFacts: undefined,
    });
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
    expect(res.binding).toBeUndefined();
  });

  it("templateId: null skips the suggestions, not the facts", async () => {
    const res = await start({
      subjectEntityId: await entityOf(ISSUE_PROFILE),
      templateId: null,
    });
    expect((await rowOf(res.session.id)).playbook_id).toBe(FIX);
    expect(res.playbooks).toBeUndefined();
  });

  it("an explicit templateId wins and is recorded as rung explicit", async () => {
    const res = await start({
      subjectEntityId: await entityOf(ISSUE_PROFILE),
      templateId: OTHER,
    });
    const row = await rowOf(res.session.id);
    expect(row.playbook_id).toBe(OTHER);
    expect(row.metadata.boundBy).toMatchObject({
      rung: "explicit",
      playbookId: OTHER,
    });
    expect(res.binding).toBeUndefined();
  });

  it("a lane inherits the playbook its parent follows", async () => {
    const parent = await start({ templateId: OTHER });
    const child = await start({ parentSessionId: parent.session.id });
    const row = await rowOf(child.session.id);
    expect(row.playbook_id).toBe(OTHER);
    expect(row.metadata.boundBy).toMatchObject({ rung: "parent" });
  });
});

describe("later: the first subject re-runs the facts, once", () => {
  it("binds when a subject first arrives on an unbound session", async () => {
    const res = await start();
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
    const up = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: await entityOf(ISSUE_PROFILE),
    });
    if (up.status !== "updated") throw new Error(up.status);
    expect(up.session.playbookId).toBe(FIX);
    expect(up.binding).toContain(FIX);
    expect((await rowOf(res.session.id)).metadata.boundBy).toMatchObject({
      rung: "subject",
      phase: "update",
    });
  });

  it("runs ONCE: a later subject does not re-run it", async () => {
    const res = await start();
    // First arrival: a note, which no playbook runs on.
    const first = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: await entityOf(NOTE_PROFILE),
    });
    if (first.status !== "updated") throw new Error(first.status);
    expect(first.binding).toBeUndefined();
    expect((await rowOf(res.session.id)).metadata.bindRecheckedAt).toBeTruthy();
    await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: null,
    });
    const again = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: await entityOf(ISSUE_PROFILE),
    });
    if (again.status !== "updated") throw new Error(again.status);
    expect(again.binding).toBeUndefined();
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
  });

  it("a released playbook is never re-bound by the server", async () => {
    // Bound by the caller (not by the start), so this row does not lean on
    // the start wiring the cases above prove.
    const res = await start();
    await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      followPlaybookId: FIX,
    });
    expect((await rowOf(res.session.id)).playbook_id).toBe(FIX);
    await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      followPlaybookId: null,
    });
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
    const back = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: await entityOf(ISSUE_PROFILE),
    });
    if (back.status !== "updated") throw new Error(back.status);
    expect(back.binding).toBeUndefined();
    expect((await rowOf(res.session.id)).playbook_id).toBeNull();
  });

  it("the caller's own follow in the same patch wins over the facts", async () => {
    const res = await start();
    const up = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      subjectEntityId: await entityOf(ISSUE_PROFILE),
      followPlaybookId: OTHER,
    });
    if (up.status !== "updated") throw new Error(up.status);
    expect(up.session.playbookId).toBe(OTHER);
    expect(up.binding).toBeUndefined();
    expect((await rowOf(res.session.id)).metadata.boundBy).toBeUndefined();
  });
});
