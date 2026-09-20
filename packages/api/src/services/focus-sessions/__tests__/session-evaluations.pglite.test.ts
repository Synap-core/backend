/**
 * Session evaluations — the ONE write door, the evaluation ladder, the retry
 * bound + escalation, the check-gate resume, and what close does with both.
 *
 * Reachability, not shape: rows are read back from PGlite. `session_evaluations`
 * is created by the REAL migration file (0267), so the CHECK constraints and
 * defaults under test are the shipped ones.
 *
 * Real: `recordSessionEvaluation`, `evaluateSession`, `resumeCheckGateIfMet`,
 * `completeFocusSession`, the owed-slot doors (`updateExpectedOutputsLocked`,
 * `attestExpectedOutput`). Stubbed, and why: `checkPermissionOrPropose` (grants),
 * `executeCapability` + the IS judge (no sandbox / no IS in unit tests), the
 * close event's `emitSideEffects` / `logEvent` (captured, to assert the payload),
 * `expireSessionEphemerals` (own proposal sweep, not under test).
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  capability: null as unknown,
  emitted: [] as Array<Record<string, unknown>>,
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
        sessionEvaluations: actual.sessionEvaluations as never,
      },
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

vi.mock("../../capabilities/execute-capability.js", () => ({
  executeCapability: async () => h.capability,
}));

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (e: Record<string, unknown>) => {
      h.emitted.push(e);
    },
  };
});
// The tRPC mutation middleware's split-brain check reads a table this harness
// does not create; not under test.
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
// The list door's lineage + participants projections open their own
// connection; stubbed so `focusSessions.list` can be driven for `verdict`.
vi.mock("../parent-lineage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    attachParentSessionIds: async (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => ({ ...r, parentSessionId: null })),
  };
});
vi.mock("../participants.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    attachSessionParticipants: async (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => ({ ...r, participants: [] })),
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  playbookRuns,
  proposals,
} from "@synap/database";
import {
  recordSessionEvaluation,
  attachSessionVerdicts,
  MAX_NON_HUMAN_ATTEMPTS,
} from "../evaluations/record.js";
import { evaluateSession } from "../evaluations/evaluate.js";
import { completeFocusSession } from "../complete-session.js";
import { FOCUS_SESSION_CLOSE_ACTION } from "../close-event.js";
import { updateFocusSession } from "../update-session.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import {
  signalFromOwedSlot,
  type OwedSlotSignalInput,
} from "../../signals/needs-you-union.js";
import { projectContinuationPacket } from "../continuation-packet.js";

const USER = "user-1";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const CRITERIA = [
  {
    key: "typecheck",
    statement: "Typecheck passes",
    check: { kind: "evidence", evidenceKey: "tsc" },
  },
  {
    key: "lint",
    statement: "Lint is clean",
    required: false,
    check: { kind: "evidence", evidenceKey: "lint" },
  },
  {
    key: "smoke",
    statement: "Smoke check passes",
    check: { kind: "capability", capability: "smoke.run" },
  },
  { key: "signoff", statement: "Owner signs off", check: { kind: "human" } },
];

async function seed(
  opts: {
    criteria?: unknown[];
    status?: string;
    metadata?: Record<string, unknown>;
    report?: Record<string, unknown> | null;
    agentIds?: string[];
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, criteria, verification_report, created_at, updated_at, started_at)
     values ($1, $2, 'Ship the thing', $3, '[]'::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      opts.status ?? "active",
      opts.agentIds ?? [],
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.criteria ?? CRITERIA),
      opts.report === undefined ? null : JSON.stringify(opts.report),
    ]
  );
  return id;
}

const rowsFor = (sessionId: string) =>
  q<{
    criterion_key: string;
    verdict: string;
    evaluator_kind: string;
    attempt: number;
  }>(
    `select criterion_key, verdict, evaluator_kind, attempt from session_evaluations where session_id = $1 order by created_at`,
    [sessionId]
  ).then((r) => r.rows);

const sessionRow = (id: string) =>
  q<{
    status: string;
    metadata: Record<string, unknown>;
    expected_outputs: Array<Record<string, unknown>>;
    verification_report: Record<string, unknown> | null;
  }>(
    `select status, metadata, expected_outputs, verification_report from focus_sessions where id = $1`,
    [id]
  ).then((r) => r.rows[0]!);

describe("session evaluations", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, playbooks, playbookRuns, proposals]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../../database/migrations/0267_session_criteria_and_evaluations.sql"
        ),
        "utf8"
      )
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.capability = null;
    h.emitted.length = 0;
  });

  it("evidence: a posted result records a row; an absent one records NOTHING", async () => {
    const id = await seed();
    const out = await evaluateSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      evidence: { tsc: { passed: true, detail: "0 errors" } },
      kinds: ["evidence"],
    });
    expect(out.status).toBe("evaluated");
    const rows = await rowsFor(id);
    expect(rows).toEqual([
      {
        criterion_key: "typecheck",
        verdict: "pass",
        evaluator_kind: "evidence",
        attempt: 1,
      },
    ]);
    if (out.status !== "evaluated") return;
    expect(out.results.find((r) => r.key === "lint")).toMatchObject({
      status: "skipped",
    });
  });

  it("capability: an execution ERROR is unmeasured, never fail", async () => {
    const id = await seed();
    h.capability = { kind: "error", message: "sandbox crashed" };
    await evaluateSession({
      sessionId: id,
      userId: USER,
      kinds: ["capability"],
    });
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      criterion_key: "smoke",
      verdict: "unmeasured",
    });
  });

  it("capability: a run's boolean `passed` is the verdict", async () => {
    const id = await seed();
    h.capability = {
      kind: "run",
      skillId: "s",
      result: { passed: false },
      ackState: "acked",
    };
    await evaluateSession({
      sessionId: id,
      userId: USER,
      kinds: ["capability"],
    });
    expect((await rowsFor(id))[0]).toMatchObject({ verdict: "fail" });
  });

  it("retry bound: a 3rd non-human attempt is refused, and the 2nd failure of a REQUIRED criterion files a human-owned slot", async () => {
    const id = await seed();
    for (let i = 0; i < MAX_NON_HUMAN_ATTEMPTS; i++) {
      const r = await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
      expect(r.status).toBe("recorded");
      if (r.status === "recorded")
        expect(r.escalated).toBe(i === MAX_NON_HUMAN_ATTEMPTS - 1);
    }
    const third = await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      criterionKey: "typecheck",
      verdict: "pass",
      evaluatorKind: "evidence",
    });
    expect(third.status).toBe("attempts_exhausted");
    expect(await rowsFor(id)).toHaveLength(2);

    const slots = (await sessionRow(id)).expected_outputs;
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: "criterion",
      owner: "human",
      blockedReason: "decision",
      status: "pending",
    });
    expect(typeof slots[0]!.owedSince).toBe("string");
    // The SENTENCE the founder reads in the needs-you tray names the criterion
    // by its STATEMENT. `typecheck` is the machine key and must not appear —
    // a slug in a human sentence is the defect this pins.
    expect(slots[0]!.why).toBe(
      `Checked ${MAX_NON_HUMAN_ATTEMPTS} times and still not passing — mark "Typecheck passes" pass or fail.`
    );
    expect(slots[0]!.why).not.toContain("typecheck");
    // `why` is capped at 500 by every slot door; a long statement is clipped,
    // never smuggled past the ceiling.
    expect(String(slots[0]!.why).length).toBeLessThanOrEqual(500);
  });

  it("the escalation slot carries its criterion KEY, out through the doors a UI calls", async () => {
    // WHY A KEY AND NOT THE LABEL: the slot's label is prose
    // (`Check: <statement>`, clipped at 120), so a surface that wanted to open
    // the scorecard on the right criterion could only match that string back —
    // forking this file's label format into every UI and breaking the moment a
    // statement is reworded. Driven through a REAL escalation and read off the
    // tRPC door, never a hand-built slot: the point is that the value ARRIVES.
    const id = await seed();
    for (let i = 0; i < MAX_NON_HUMAN_ATTEMPTS; i++) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
    }

    const caller = focusSessionsRouter.createCaller({
      authenticated: true,
      userId: USER,
    } as never);
    const owed = await caller.owed({ limit: 50 });
    const slot = owed.find((o) => o.sessionId === id);
    expect(slot).toBeDefined();
    expect(slot!.kind).toBe("criterion");
    expect(slot!.criterionKey).toBe("typecheck");

    // …and onward onto the needs-you signal, beside `slotKind` — the two
    // travel together: one says this row takes the GRADE verb, the other says
    // which criterion it grades.
    const signal = signalFromOwedSlot(slot as unknown as OwedSlotSignalInput);
    expect(signal.slotKind).toBe("criterion");
    expect(signal.criterionKey).toBe("typecheck");

    // …and through the continuation packet's owed slots, the third door.
    const packet = await projectContinuationPacket(
      {
        id,
        goal: "Ship the thing",
        status: "active",
        workspaceId: null,
        projectId: null,
        expectedOutputs: (await sessionRow(id)).expected_outputs,
      } as never,
      { userId: USER }
    );
    const packetSlot = packet.userMustDecide.owedSlots;
    expect(packetSlot.status).toBe("ok");
    if (packetSlot.status !== "ok") return;
    expect(packetSlot.items[0]!.criterionKey).toBe("typecheck");
  });

  it("an ORDINARY owed slot carries no criterion key — absence is not an error", async () => {
    // Back-compat is the same shape as "never applied": a slot filed before
    // this field existed, and every non-criterion slot, carries nothing. A
    // consumer must read that as "no criterion to highlight".
    const id = await seed();
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [
        id,
        JSON.stringify([
          {
            kind: "doc",
            label: "The dossier",
            owner: "human",
            status: "pending",
            owedSince: new Date().toISOString(),
          },
        ]),
      ]
    );
    const caller = focusSessionsRouter.createCaller({
      authenticated: true,
      userId: USER,
    } as never);
    const owed = await caller.owed({ limit: 50 });
    const slot = owed.find((o) => o.sessionId === id)!;
    expect(slot).toBeDefined();
    expect("criterionKey" in slot).toBe(false);
    expect("criterionKey" in signalFromOwedSlot(slot as never)).toBe(false);
  });

  it("a very long criterion statement is CLIPPED so the sentence still fits `why`", async () => {
    const statement = "x".repeat(900);
    const id = await seed({
      criteria: [
        {
          key: "long",
          statement,
          check: { kind: "evidence", evidenceKey: "tsc" },
        },
      ],
    });
    for (let i = 0; i < MAX_NON_HUMAN_ATTEMPTS; i++) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        criterionKey: "long",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
    }
    const slot = (await sessionRow(id)).expected_outputs[0]!;
    expect(String(slot.why).length).toBeLessThanOrEqual(500);
    expect(slot.why).toContain("…");
    // It is still the STATEMENT that was clipped, not the instruction.
    expect(slot.why).toContain("pass or fail.");
  });

  it("an OPTIONAL criterion failing twice files no slot", async () => {
    const id = await seed();
    for (let i = 0; i < 2; i++) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        criterionKey: "lint",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
    }
    expect((await sessionRow(id)).expected_outputs).toHaveLength(0);
  });

  it("a human grade is final: it discharges the escalation slot and later non-human rows are refused", async () => {
    const id = await seed();
    for (let i = 0; i < 2; i++) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
    }
    const human = await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      criterionKey: "typecheck",
      verdict: "pass",
      evaluatorKind: "human",
    });
    expect(human.status).toBe("recorded");
    const slot = (await sessionRow(id)).expected_outputs[0]!;
    expect(slot).toMatchObject({ status: "done", attestedBy: USER });

    const judge = await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      criterionKey: "signoff",
      verdict: "pass",
      evaluatorKind: "human",
      agentUserId: AGENT,
    });
    expect(judge.status).toBe("refused");
  });

  it("a judge verdict from the agent that worked the session is refused", async () => {
    const judgeCriteria = [
      { key: "docs", statement: "Docs updated", check: { kind: "judge" } },
    ];
    const id = await seed({
      criteria: judgeCriteria,
      agentIds: ["worker-agent"],
      metadata: { modelId: "worker-model" },
    });
    for (const evaluatorId of ["worker-agent", "worker-model", AGENT]) {
      const r = await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        criterionKey: "docs",
        verdict: "pass",
        evaluatorKind: "judge",
        evaluatorId,
      });
      expect(r.status).toBe("refused");
    }
    const ok = await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      criterionKey: "docs",
      verdict: "pass",
      evaluatorKind: "judge",
      evaluatorId: "other-model",
    });
    expect(ok.status).toBe("recorded");
  });

  it("check gate: a passing evaluation resumes a check-paused session and clears the record", async () => {
    const staged = [{ ...CRITERIA[0], stageKey: "build" }];
    const id = await seed({
      criteria: staged,
      status: "paused",
      metadata: {
        checkGate: {
          stageKey: "ship",
          fromStage: "build",
          failing: ["typecheck"],
        },
        keep: 1,
      },
    });
    const out = await evaluateSession({
      sessionId: id,
      userId: USER,
      evidence: { tsc: { passed: true } },
    });
    expect(out.status === "evaluated" && out.resumed).toBe(true);
    const row = await sessionRow(id);
    expect(row.status).toBe("active");
    expect(row.metadata).toEqual({ keep: 1 });
  });

  it("a session paused WITHOUT a check-gate record is never resumed by an evaluation", async () => {
    const id = await seed({ criteria: [CRITERIA[0]], status: "paused" });
    await evaluateSession({
      sessionId: id,
      userId: USER,
      evidence: { tsc: { passed: true } },
    });
    expect((await sessionRow(id)).status).toBe("paused");
  });

  it("close MERGES the report (CLI codeQuality survives a summary close) and the event carries the verdict", async () => {
    const id = await seed({ report: { codeQuality: { lint: 0 } } });
    await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      criterionKey: "typecheck",
      verdict: "pass",
      evaluatorKind: "evidence",
    });
    const result = await completeFocusSession({
      sessionId: id,
      userId: USER,
      summary: "Done",
    });
    expect((await sessionRow(id)).verification_report).toEqual({
      codeQuality: { lint: 0 },
      summary: "Done",
    });
    // 3 required criteria (typecheck passed; smoke + signoff unmeasured).
    expect(result!.verdict).toMatchObject({
      total: 4,
      passed: 1,
      requiredUnmet: 2,
      state: "incomplete",
    });
    expect(
      result!.warnings.some((w) => w.includes("2 required criteria not met"))
    ).toBe(true);
    const closed = h.emitted.find(
      (e) => e.action === FOCUS_SESSION_CLOSE_ACTION
    );
    expect(closed).toBeDefined();
    expect((closed?.data as Record<string, unknown>).verdict).toEqual(
      result!.verdict
    );
  });

  it("close with an explicit null report still CLEARS it", async () => {
    const id = await seed({ report: { codeQuality: { lint: 0 } } });
    await completeFocusSession({
      sessionId: id,
      userId: USER,
      verificationReport: null,
    });
    expect((await sessionRow(id)).verification_report).toBeNull();
  });

  describe("title provenance (metadata.titleSource) — merged, never replacing metadata", () => {
    const trpc = () =>
      focusSessionsRouter.createCaller({
        authenticated: true,
        userId: USER,
      } as never);

    it('a human rename (tRPC) stamps "human" and keeps sibling metadata', async () => {
      const id = await seed({
        metadata: { keep: 1, titleSource: "generated" },
      });
      await trpc().update({ id, title: "My name for it" });
      expect((await sessionRow(id)).metadata).toEqual({
        keep: 1,
        titleSource: "human",
      });
    });

    it('clearing the title hands it back to the titler ("derived")', async () => {
      const id = await seed({ metadata: { titleSource: "human" } });
      await trpc().update({ id, title: null });
      expect((await sessionRow(id)).metadata).toEqual({
        titleSource: "derived",
      });
    });

    it('an agent rename (update-session) stamps "agent"', async () => {
      const id = await seed({ metadata: { keep: 2 } });
      const r = await updateFocusSession({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        title: "Agent name",
      });
      expect(r.status).toBe("updated");
      expect((await sessionRow(id)).metadata).toEqual({
        keep: 2,
        titleSource: "agent",
      });
    });
  });

  describe("list rows carry the verdict", () => {
    it("batched: verdict on rows WITH criteria, absent on rows without", async () => {
      const graded = await seed();
      const bare = await seed({ criteria: [] });
      await recordSessionEvaluation({
        sessionId: graded,
        userId: USER,
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
      const rows = await attachSessionVerdicts([
        { id: graded, userId: USER, criteria: CRITERIA },
        { id: bare, userId: USER, criteria: [] },
      ]);
      expect(rows[0]!.verdict).toMatchObject({
        total: 4,
        failed: 1,
        state: "failing",
      });
      expect("verdict" in rows[1]!).toBe(false);
    });

    it("focusSessions.list returns the verdict on the row (the door, not just the helper)", async () => {
      const id = await seed();
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        criterionKey: "typecheck",
        verdict: "pass",
        evaluatorKind: "evidence",
      });
      const caller = focusSessionsRouter.createCaller({
        authenticated: true,
        userId: USER,
      } as never);
      const out = (await caller.list({})) as unknown;
      const items = (
        Array.isArray(out)
          ? out
          : ((out as { items?: unknown[]; sessions?: unknown[] }).items ??
            (out as { sessions?: unknown[] }).sessions ??
            [])
      ) as Array<{ id: string; verdict?: { passed: number } }>;
      const row = items.find((r) => r.id === id);
      expect(row?.verdict?.passed).toBe(1);
    });

    it("focusSessions.close returns the verdict AND the warnings (the door, not just the service)", async () => {
      const id = await seed();
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        criterionKey: "typecheck",
        verdict: "fail",
        evaluatorKind: "evidence",
      });
      const caller = focusSessionsRouter.createCaller({
        authenticated: true,
        userId: USER,
      } as never);
      const out = (await caller.close({ id })) as unknown as {
        status: string;
        verdict?: { requiredUnmet: number; state: string };
        warnings?: string[];
      };
      expect(out.status).toBe("closed");
      // The close's own grade — the browser had to re-derive this from the
      // PRE-close scorecard because this door returned the bare row.
      expect(out.verdict).toMatchObject({ state: "failing" });
      expect(out.verdict!.requiredUnmet).toBeGreaterThan(0);
      expect(out.warnings?.some((w) => w.includes("not met"))).toBe(true);
    });
  });
});
