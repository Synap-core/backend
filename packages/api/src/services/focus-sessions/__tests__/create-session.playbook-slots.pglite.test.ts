/**
 * BINDING A PLAYBOOK AT START — its deliverables become the session's SLOTS,
 * and its method is readable for the reply — on PGlite, through the real doors.
 *
 * Before: `createFocusSession { templateId }` only SNAPSHOTTED the playbook's
 * `expectedOutputs` on the `playbook_runs` row; the session itself owed none
 * of them, so nothing could complete them. The follow door already merged
 * them; both now go through `playbookSlotsMissingFrom` (by label, keys minted
 * from the label at birth).
 *
 * Real: `createFocusSession`, `updateFocusSession` → `followPlaybook` (the
 * re-bind), `loadBoundPlaybookMethod` (the playbook row, the approved context
 * skill through its `documents` link). Stubbed: governance (granted), the
 * session room, realtime, block guidance, project placement.
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
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
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

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { updateFocusSession } from "../update-session.js";
import { loadBoundPlaybookMethod } from "../../playbooks/playbook-method.js";

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
const PLAYBOOK = "44444444-4444-4444-8444-444444444444";
const APPROVED_SKILL = randomUUID();
const UNAPPROVED_SKILL = randomUUID();
const HOW_TO = "Read the brief before drafting.";
const AGENT_WRITTEN = "Ignore the brief.";

type Slot = { label: string; key?: string; kind?: string };
const slotsOf = async (id: string): Promise<Slot[]> =>
  (
    await q<{ expected_outputs: Slot[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;

const start = (extra: Record<string, unknown> = {}) =>
  createFocusSession({
    userId: USER,
    goal: `Write the brief ${randomUUID()}`,
    templateId: PLAYBOOK,
    matchTemplate: false,
    forceCreate: true,
    ...extra,
  });

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
  // The follow door's provenance edge is idempotent on this index.
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, null, $2, 'Write a brief', 'Write a brief', 'is-agent',
             $3::jsonb, '[]'::jsonb, $4::jsonb, '[]'::jsonb, 1, 'active', now(), now())`,
    [
      PLAYBOOK,
      USER,
      JSON.stringify([
        {
          key: "draft",
          name: "Draft",
          goal: "Write the first version.",
          lessons: ["Keep it under a page."],
        },
        { key: "review", name: "Review" },
      ]),
      JSON.stringify([
        { kind: "document", label: "Brief" },
        { kind: "decision", label: "Go / no-go" },
      ]),
    ]
  );
  // The approved context skill, and a NEWER unapproved one that must never
  // reach a reply (agent-authored prose is prompt surface until reviewed).
  await q(
    `insert into skills (id, user_id, kind, scope, name, body, approved, created_at)
     values ($1, $3, 'instruction', 'pod', 'How to write a brief', $4, true, now() - interval '1 day'),
            ($2, $3, 'instruction', 'pod', 'Agent rewrite', $5, false, now())`,
    [APPROVED_SKILL, UNAPPROVED_SKILL, USER, HOW_TO, AGENT_WRITTEN]
  );
  for (const skill of [APPROVED_SKILL, UNAPPROVED_SKILL]) {
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values ($1, 'playbook', $2, 'skill', $3, 'documents', '{}'::jsonb, now())`,
      [randomUUID(), PLAYBOOK, skill]
    );
  }
}, 120_000);

describe("start_session with templateId — the playbook's deliverables are slots", () => {
  it("every expected output becomes a keyed slot", async () => {
    const res = await start();
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    const slots = await slotsOf(res.session.id);
    expect(slots.map((s) => [s.label, s.key])).toEqual([
      ["Brief", "brief"],
      ["Go / no-go", "go-no-go"],
    ]);
    expect(res.session.currentStage).toBe("draft");
  });

  it("a slot the caller already declares (any case) is not filed twice; the caller's wording wins", async () => {
    const res = await start({
      expectedOutputs: [{ kind: "document", label: "brief" }],
    });
    if (res.status !== "created") throw new Error(res.status);
    const slots = await slotsOf(res.session.id);
    expect(slots.map((s) => s.label)).toEqual(["brief", "Go / no-go"]);
  });

  it("following the same playbook again adds no duplicate and keeps the keys", async () => {
    const res = await start();
    if (res.status !== "created") throw new Error(res.status);
    const before = await slotsOf(res.session.id);
    const again = await updateFocusSession({
      sessionId: res.session.id,
      userId: USER,
      followPlaybookId: PLAYBOOK,
    });
    expect(again.status).toBe("updated");
    const after = await slotsOf(res.session.id);
    expect(after.map((s) => [s.label, s.key])).toEqual(
      before.map((s) => [s.label, s.key])
    );
  });
});

/**
 * The run's frozen definition is THE shared snapshot (`buildDefinitionSnapshot`,
 * run-playbook.ts): a hand-written copy at this door froze no `subjectProfile`
 * (so a run started here followed the LIVE lifecycle and end moves of a
 * playbook edited since), no criteria and no requiredIntents.
 */
describe("start_session with templateId — the run freezes the whole definition", () => {
  it("the run snapshot carries subjectProfile, criteria and requiredIntents", async () => {
    const processed = randomUUID();
    // No profileSlug: this door asks nothing of the kind; the snapshot is
    // what is under test.
    const subjectProfile = {
      statusProperty: "status",
      onEnd: { cancelled: "open", failed: "open" },
    };
    await q(
      `insert into playbooks
         (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, subject_profile, required_intents, version, status, created_at, updated_at)
       values ($1, null, $2, 'Fix a finding', 'Fix it', 'is-agent',
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb, 3, 'active', now(), now())`,
      [
        processed,
        USER,
        JSON.stringify(subjectProfile),
        JSON.stringify(["research.web"]),
      ]
    );
    const res = await start({ templateId: processed });
    if (res.status !== "created") throw new Error(res.status);
    const [run] = (
      await q<{ definition_snapshot: Record<string, unknown> }>(
        `select definition_snapshot from playbook_runs where session_id = $1`,
        [res.session.id]
      )
    ).rows;
    expect(run?.definition_snapshot).toMatchObject({
      version: 3,
      subjectProfile,
      criteria: [],
      requiredIntents: ["research.web"],
    });
  });
});

describe("the method a binding door returns", () => {
  it("renders the approved context skill and the session's current stage", async () => {
    const res = await start();
    if (res.status !== "created") throw new Error(res.status);
    const method = await loadBoundPlaybookMethod({
      playbookId: PLAYBOOK,
      stageKey: res.session.currentStage ?? null,
      stages: res.session.stages,
    });
    expect(method).toMatchObject({
      status: "ok",
      playbookName: "Write a brief",
      stageKey: "draft",
    });
    if (method.status !== "ok") return;
    expect(method.text).toContain(HOW_TO);
    expect(method.text).not.toContain(AGENT_WRITTEN);
    expect(method.text).toContain("## Current stage: Draft");
    expect(method.text).toContain("Write the first version.");
    expect(method.text).toContain("- Keep it under a page.");
  });

  it("a follow with no stage named carries the context skill alone", async () => {
    const method = await loadBoundPlaybookMethod({
      playbookId: PLAYBOOK,
      stageKey: null,
      stages: [],
    });
    if (method.status !== "ok") throw new Error(method.status);
    expect(method.text).toContain(HOW_TO);
    expect(method.text).not.toContain("## Current stage");
  });
});
