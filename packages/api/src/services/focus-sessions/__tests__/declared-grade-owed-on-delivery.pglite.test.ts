/**
 * W5 (work model, plan 8daa514b): a grade the person gives can be DECLARED UP
 * FRONT — a criterion with `check.kind: "human"` that names the output it
 * checks (`outputKey`) gets its grade slot at the start — and it is owed only
 * once that output is delivered, so it neither counts in needs-you nor parks
 * the run from minute one.
 *
 * Real: `createFocusSession` → `fileDeclaredGradeSlots` → the slot door
 * (`updateExpectedOutputsLocked`) on PGlite; the owed rule in TypeScript
 * (`isOwedSlot`) and in SQL (`owedSlotWhere`) over the stored row.
 *
 * Stubbed, and why (the W1 harness, `create-session.criterion-output-key`):
 * governance (granted), project placement (echoes the caller's), the session
 * room and the spawn edge (own connections), realtime emit.
 *
 * The output's delivery is written straight to the row: `done` has one door
 * (`satisfy-expected-output.ts`), and what is under test is what the owed rule
 * reads once it is there, not that door.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        playbooks: actual.playbooks as never,
      },
    }),
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});

vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});

vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  and,
  db,
  eq,
  focusSessions,
  links,
  playbooks,
  proposals,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { createFocusSession } from "../create-session.js";
import { isOwedSlot, owedSlotWhere } from "../owed-outputs.js";

const USER = "user-1";
const AGENT = "agent-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "status"
        ? " default 'active'"
        : c.name === "started_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const GRADE = {
  key: "copy-reads-well",
  statement: "The landing copy reads well",
  check: { kind: "human" },
  outputKey: "landing-copy",
};

async function start(criteria: unknown[]): Promise<string> {
  const res = await createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    projectId: PROJECT,
    goal: `Write the landing copy ${randomUUID()}`,
    templateId: null,
    criteria,
    expectedOutputs: [
      { kind: "document", label: "Landing copy", key: "landing-copy" },
    ],
  } as Parameters<typeof createFocusSession>[0]);
  expect(res.status).toBe("created");
  return (res as { session: { id: string } }).session.id;
}

async function outputsOf(id: string): Promise<ExpectedOutput[]> {
  const { rows } = await h.client!.query<{ expected_outputs: unknown }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  );
  const raw = rows[0]?.expected_outputs;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as ExpectedOutput[];
}

/** The SQL half: does the row match `owedSlotWhere()`? */
async function sqlOwes(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, id), owedSlotWhere()));
  return rows.length === 1;
}

beforeAll(async () => {
  for (const t of [focusSessions, proposals, links, playbooks]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);
afterAll(async () => h.client?.close());

describe("a grade declared up front is owed once its output is delivered (W5)", () => {
  it("is filed at the start, not owed while the output is pending, owed once it is done", async () => {
    const id = await start([GRADE]);
    const outputs = await outputsOf(id);
    const grade = outputs.find((o) => o.kind === "criterion");
    // Non-vacuous: the grade slot exists, names its output, is the person's.
    expect(grade).toMatchObject({
      criterionKey: "copy-reads-well",
      outputKey: "landing-copy",
      owner: "human",
      label: "Check: The landing copy reads well",
    });
    expect(outputs.find((o) => o.key === "landing-copy")?.status).not.toBe(
      "done"
    );

    // Before delivery: owed by nobody yet, in TypeScript and in SQL.
    expect(isOwedSlot(grade!, outputs)).toBe(false);
    expect(await sqlOwes(id)).toBe(false);

    // The output is delivered.
    const delivered = outputs.map((o) =>
      o.key === "landing-copy" ? { ...o, status: "done" as const } : o
    );
    await h.client!.query(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [id, JSON.stringify(delivered)]
    );

    // Now it is the person's move, in both halves.
    expect(isOwedSlot(grade!, delivered)).toBe(true);
    expect(await sqlOwes(id)).toBe(true);
  });

  it("CONTROL: a human criterion that names no output files no grade slot", async () => {
    const id = await start([{ ...GRADE, outputKey: undefined }]);
    const outputs = await outputsOf(id);
    expect(outputs.some((o) => o.kind === "criterion")).toBe(false);
    // The output slot itself is there (the read is not empty by accident).
    expect(outputs.some((o) => o.key === "landing-copy")).toBe(true);
  });

  it("CONTROL: a machine-checked criterion naming an output files no grade slot", async () => {
    const id = await start([
      { ...GRADE, check: { kind: "evidence", evidenceKey: "copy" } },
    ]);
    const outputs = await outputsOf(id);
    expect(outputs.some((o) => o.kind === "criterion")).toBe(false);
  });
});
