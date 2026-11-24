/**
 * Two dogfood findings on the grades declared up front (work-model W5), on
 * PGlite through the real doors:
 *
 *  - 09ba3d2d: a `kind: "fact"` OUTCOME names the output it checks
 *    (`outputKey`), so the recommended `outcomes` shape files the grade slot
 *    the deprecated `criteria` alias did — `outcomes` → `mergeOutcomesForStart`
 *    (the MCP and Hub REST start) → `createFocusSession` → the stored row;
 *    one that names no output is said back in `warnings`.
 *  - f3c864cc: a declared grade's age (`owedSince`, which needs-you reads)
 *    starts when its output is MADE, not when it was declared — restamped by
 *    the slot-transition funnel (`oweSlotTransitions`) in the write that made
 *    the output, here the slot door `updateExpectedOutputsLocked`; never
 *    moved back.
 *
 * Stubbed, and why (the W5 harness, `declared-grade-owed-on-delivery`):
 * governance (granted), project and space placement (echo the caller's), the
 * session room and the spawn edge (own connections), realtime emit.
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
    // The space ladder echoes the caller's space too: placement is not what
    // this file tests (`create-session.space-ladder.pglite.test.ts` is).
    resolveSessionWorkspacePlacement: async (
      _db: unknown,
      input: { explicitWorkspaceId?: string | null }
    ) => ({
      workspaceId: input.explicitWorkspaceId ?? null,
      rung: input.explicitWorkspaceId ? "explicit" : null,
    }),
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
  focusSessions,
  lifecycleTransitionOutbox,
  links,
  playbooks,
  proposals,
  sessionEvaluations,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { createFocusSession } from "../create-session.js";
import { isOwedSlot } from "../owed-outputs.js";
import { updateExpectedOutputsLocked } from "../delegate-output.js";
import {
  mergeOutcomesForStart,
  outcomeDeclarationsSchema,
} from "../outcome-declarations.js";

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

beforeAll(async () => {
  // The outbox: a withdrawn grade slot owes its slot transition.
  for (const t of [
    focusSessions,
    proposals,
    links,
    playbooks,
    lifecycleTransitionOutbox,
    // The producer never re-files a grade the person gave: it reads them.
    sessionEvaluations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);
afterAll(async () => h.client?.close());

async function startWithOutcomes(outcomes: unknown[]) {
  const declared = mergeOutcomesForStart({
    outcomes: outcomeDeclarationsSchema.parse(outcomes),
  });
  const res = await createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    projectId: PROJECT,
    goal: `Write the checklist ${randomUUID()}`,
    templateId: null,
    ...declared,
  } as Parameters<typeof createFocusSession>[0]);
  expect(res.status).toBe("created");
  return res as { session: { id: string }; warnings?: string[] };
}

async function criteriaOf(id: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await h.client!.query<{ criteria: unknown }>(
    `select criteria from focus_sessions where id = $1`,
    [id]
  );
  const raw = rows[0]?.criteria;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Array<
    Record<string, unknown>
  >;
}

describe("outcomes: a fact names the output it checks (finding 09ba3d2d)", () => {
  it("the dogfood call files the grade slot, paired by outputKey", async () => {
    const res = await startWithOutcomes([
      { key: "checklist", label: "Checklist", kind: "document" },
      {
        key: "checklist-ok",
        label: "The checklist reads right",
        kind: "fact",
        verify: { kind: "human" },
        outputKey: "checklist",
      },
    ]);
    const id = res.session.id;
    expect(await criteriaOf(id)).toEqual([
      expect.objectContaining({ key: "checklist-ok", outputKey: "checklist" }),
    ]);
    const grade = (await outputsOf(id)).find((o) => o.kind === "criterion");
    expect(grade).toMatchObject({
      criterionKey: "checklist-ok",
      outputKey: "checklist",
      owner: "human",
    });
    expect(res.warnings ?? []).toEqual([]);
  });

  it("one naming no output of the session is said back, never refused", async () => {
    const res = await startWithOutcomes([
      { key: "checklist", label: "Checklist", kind: "document" },
      {
        key: "checklist-ok",
        label: "The checklist reads right",
        kind: "fact",
        verify: { kind: "human" },
        outputKey: "check-list",
      },
    ]);
    expect(res.warnings).toEqual([
      expect.stringContaining(
        'Criterion "checklist-ok": outputKey "check-list" names no output'
      ),
    ]);
  });
});

describe("a declared grade is owed from when its output is made (finding f3c864cc)", () => {
  const DECLARED_AT = "2026-01-01T00:00:00.000Z";

  /** A session whose grade was declared long ago, its output not made. */
  async function declaredLongAgo(): Promise<string> {
    const id = await start([GRADE]);
    const aged = (await outputsOf(id)).map((o) =>
      o.kind === "criterion" ? { ...o, owedSince: DECLARED_AT } : o
    );
    await h.client!.query(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [id, JSON.stringify(aged)]
    );
    return id;
  }

  const gradeOf = async (id: string) =>
    (await outputsOf(id)).find((o) => o.kind === "criterion")!;

  it("the write that makes the output stamps owedSince then", async () => {
    const id = await declaredLongAgo();
    const t0 = new Date().toISOString();
    expect(isOwedSlot(await gradeOf(id), await outputsOf(id))).toBe(false);

    await updateExpectedOutputsLocked(id, (current) =>
      current.map((o) =>
        o.key === "landing-copy" ? { ...o, status: "done" as const } : o
      )
    );

    const grade = await gradeOf(id);
    expect(isOwedSlot(grade, await outputsOf(id))).toBe(true);
    expect(grade.owedSince! >= t0).toBe(true);
  });

  it("never moves back: a later write leaves the stamp alone", async () => {
    const id = await declaredLongAgo();
    await updateExpectedOutputsLocked(id, (current) =>
      current.map((o) =>
        o.key === "landing-copy" ? { ...o, status: "done" as const } : o
      )
    );
    const stamped = (await gradeOf(id)).owedSince;
    await updateExpectedOutputsLocked(id, (current) =>
      current.map((o) =>
        o.key === "landing-copy" ? { ...o, why: "Edited later" } : o
      )
    );
    expect((await gradeOf(id)).owedSince).toBe(stamped);
  });

  it("CONTROL: a write that does not make the output keeps the declared age", async () => {
    const id = await declaredLongAgo();
    await updateExpectedOutputsLocked(id, (current) =>
      current.map((o) =>
        o.key === "landing-copy" ? { ...o, why: "Still drafting" } : o
      )
    );
    expect((await gradeOf(id)).owedSince).toBe(DECLARED_AT);
  });
});
