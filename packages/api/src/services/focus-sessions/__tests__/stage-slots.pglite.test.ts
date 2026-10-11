/**
 * Stage-level `expectedOutputs` become the session's slots when the run ENTERS
 * the stage — at birth (first stage) and on every advance — so the output is
 * owed, produced, and its `relationToSubject` edge is owed on satisfy exactly
 * like a playbook-level slot.
 *
 * Real: `instantiateSessionRow` (the run birth funnel), `advanceSessionStage`
 * (the one advance door), `loadSessionProcess` and the slot merge, on PGlite.
 * Stubbed: the gate (none), the subject-status write, event fan-out, links and
 * recall — none of them touch the slots.
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
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../playbooks/stage-gate.js", () => ({
  applyStageGateOnAdvance: async () => null,
}));
vi.mock("../stage-subject-status.js", () => ({
  writeStageSubjectStatus: async () => undefined,
}));
vi.mock("../../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLinks: vi.fn(async () => []),
}));
vi.mock("../session-recall.js", () => ({
  enqueueSessionRecall: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { instantiateSessionRow } from "../../playbooks/playbook-lifecycle.js";
import { advanceSessionStage } from "../advance-stage.js";
import { slotsOwedSubjectEdge } from "../subject-edge.js";

const USER = randomUUID();
const WS = randomUUID();
const SUBJECT = randomUUID();
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const COMPOSITION = {
  kind: "content-composition",
  label: "Composition",
  relationToSubject: "made_for",
};

async function insertPlaybook(
  stages: unknown[],
  expectedOutputs: unknown[] = [{ kind: "post", label: "Post" }]
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
     values ($1,$2,$3,$4,'Produce it','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,$5::jsonb,$6::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
    [
      id,
      WS,
      USER,
      `Produce ${id.slice(0, 6)}`,
      JSON.stringify(expectedOutputs),
      JSON.stringify(stages),
    ]
  );
  return id;
}

async function slots(sessionId: string): Promise<ExpectedOutput[]> {
  const { rows } = await q(
    `select expected_outputs from focus_sessions where id = $1`,
    [sessionId]
  );
  return (rows[0] as { expected_outputs: ExpectedOutput[] }).expected_outputs;
}

async function born(playbookId: string) {
  const s = await instantiateSessionRow({
    playbookId,
    workspaceId: WS,
    userId: USER,
    subjectId: SUBJECT,
  } as never);
  return s!;
}

const advance = (
  s: { id: string; playbookId: string | null },
  from: string | null,
  to: string
) =>
  advanceSessionStage({
    session: {
      id: s.id,
      currentStage: from,
      workspaceId: WS,
      projectId: null,
      channelId: null,
      playbookId: s.playbookId,
      subjectEntityId: SUBJECT,
    },
    toStage: to,
    userId: USER,
    stageWrite: "door",
  });

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from focus_sessions; delete from playbooks;`);
});

describe("entering a stage owes that stage's outputs", () => {
  it("an advance into Draft adds its slot (with its relationToSubject); re-entry adds nothing twice", async () => {
    const pb = await insertPlaybook([
      { key: "brief", name: "Brief", category: "planned" },
      {
        key: "draft",
        name: "Draft",
        category: "started",
        expectedOutputs: [COMPOSITION],
      },
      { key: "review", name: "Review", category: "started" },
    ]);
    const s = await born(pb);
    expect((await slots(s.id)).map((o) => o.label)).toEqual(["Post"]);

    const r = await advance(s, "brief", "draft");
    expect(r.stageSlots).toEqual({ added: ["Composition"] });
    const after = await slots(s.id);
    expect(after.map((o) => o.label)).toEqual(["Post", "Composition"]);
    const comp = after[1]!;
    expect(comp).toMatchObject(COMPOSITION);
    expect(comp.status ?? "pending").not.toBe("done");
    expect(typeof (comp as { key?: unknown }).key).toBe("string");

    // Leave and come back: the slot stays owed once, never duplicated.
    await advance(s, "draft", "review");
    await advance(s, "review", "draft");
    expect((await slots(s.id)).map((o) => o.label)).toEqual([
      "Post",
      "Composition",
    ]);

    // Once produced, the slot is owed its output → subject edge, like any
    // playbook-level slot (the edge writer reads the stored slots).
    const done = (await slots(s.id)).map((o) =>
      o.label === "Composition" ? { ...o, status: "done" as const } : o
    );
    expect(slotsOwedSubjectEdge(done)).toEqual([1]);
  });

  it("a run is BORN into its first stage, so it owes that stage's outputs from birth", async () => {
    const pb = await insertPlaybook([
      {
        key: "draft",
        name: "Draft",
        category: "started",
        expectedOutputs: [COMPOSITION],
      },
      { key: "review", name: "Review", category: "started" },
    ]);
    const s = await born(pb);
    const birth = await slots(s.id);
    expect(birth.map((o) => o.label)).toEqual(["Post", "Composition"]);
    expect(birth[1]).toMatchObject(COMPOSITION);
  });

  it("a stage output the playbook already declares (same label) is not owed twice", async () => {
    const pb = await insertPlaybook(
      [
        { key: "brief", name: "Brief", category: "planned" },
        {
          key: "draft",
          name: "Draft",
          category: "started",
          expectedOutputs: [{ kind: "post", label: " post " }],
        },
      ],
      [{ kind: "post", label: "Post" }]
    );
    const s = await born(pb);
    const r = await advance(s, "brief", "draft");
    expect(r.stageSlots).toBeUndefined();
    expect((await slots(s.id)).map((o) => o.label)).toEqual(["Post"]);
  });
});
