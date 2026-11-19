/**
 * W5 review (items 1, 3, 8, 11, 13): declared grades through the REAL doors,
 * on PGlite.
 *
 *   1. An AGENT claims the output a declared grade checks (the claim door,
 *      `updateFocusSession` `completeOutput`). An output a required criterion
 *      checks never reaches `done` by evidence, so the CLAIM is what makes the
 *      grade owed, in TypeScript and in SQL, and the same write hands it to
 *      the needs-you push (`notifySessionNeedsYou` → `newlyOwedSlots`).
 *   2. A judge criterion that names an output and failed its checks is
 *      escalated (`escalateFailingCriteria`): its slot carries no `outputKey`,
 *      so the escalation is owed at once, never hidden behind the output.
 *   3. End to end from the answer door (`answerExpectedOutput`) through the
 *      unblock reactor with the real doors: the person's answer to an act
 *      that names a criterion they grade brings up that grade card, and no
 *      verdict is written for them.
 *
 * Stubbed, and why: the governance gate (granted; grants are not under test),
 * the side-effect fan-out (`emitSideEffects` needs pg-boss: the payload is
 * captured and handed to the reactor by hand, the one hop not run), the push
 * itself (`notifySessionNeedsYou`: its arguments are recorded), the event
 * history row, the escalation's notification, the draft acceptance and the
 * hold re-check (their own tables).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  emitted: [] as Array<Record<string, unknown>>,
  notified: [] as Array<Record<string, unknown>>,
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
      schema: { focusSessions: actual.focusSessions as never },
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
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (p: Record<string, unknown>) => {
      h.emitted.push(p);
    },
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../notify-needs-you.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notifySessionNeedsYou: async (p: Record<string, unknown>) => {
      h.notified.push(p);
    },
  };
});
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { create: async () => "n-1" },
}));
vi.mock("../accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async () => undefined,
}));
vi.mock("../../lifecycle/wait-hold-check.js", () => ({
  sendWaitHoldCheck: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  and,
  db,
  eq,
  focusSessions,
  lifecycleTransitionOutbox,
  links,
  proposals,
  sessionEvaluations,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { updateFocusSession } from "../update-session.js";
import { answerExpectedOutput } from "../answer-slot.js";
import { isOwedSlot, owedSlotWhere } from "../owed-outputs.js";
import { newlyOwedSlots } from "../notify-needs-you.js";
import {
  escalateFailingCriteria,
  fileDeclaredGradeSlots,
} from "../evaluations/record.js";
import { sessionUnblockNotifyReactor } from "../../../notifications/session-unblock-reactor.js";

const USER = "user-1";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "attempt"
        ? " default 1"
        : c.name === "evidence"
          ? " default '{}'::jsonb"
          : c.name === "created_at"
            ? " default now()"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seed(criteria: unknown[], slots: unknown[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, criteria, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Write the landing copy', 'active', $3::jsonb, $4::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, USER, JSON.stringify(slots), JSON.stringify(criteria)]
  );
  return id;
}

async function stored(id: string): Promise<ExpectedOutput[]> {
  const { rows } = await q<{ expected_outputs: unknown }>(
    `select expected_outputs from focus_sessions where id = $1`,
    [id]
  );
  const raw = rows[0]!.expected_outputs;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as ExpectedOutput[];
}

async function sqlOwes(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, id), owedSlotWhere()));
  return rows.length === 1;
}

const gradeOf = (slots: ExpectedOutput[]) =>
  slots.find((o) => o.kind === "criterion");

const COPY = { kind: "document", label: "Landing copy", key: "landing-copy" };
const GRADED_BY_PERSON = {
  key: "copy-reads-well",
  statement: "The landing copy reads well",
  check: { kind: "human" },
  outputKey: "landing-copy",
};

beforeAll(async () => {
  for (const t of [
    focusSessions,
    lifecycleTransitionOutbox,
    sessionEvaluations,
    proposals,
    links,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);
afterAll(async () => h.client?.close());
beforeEach(() => {
  h.emitted.length = 0;
  h.notified.length = 0;
});

describe("declared grades through the real doors (W5 review)", () => {
  it("1. an agent's CLAIM on the output makes its grade owed, and the claim write pushes it", async () => {
    const id = await seed([GRADED_BY_PERSON], [COPY]);
    await fileDeclaredGradeSlots(id);
    const before = await stored(id);
    expect(gradeOf(before)).toMatchObject({ outputKey: "landing-copy" });
    expect(isOwedSlot(gradeOf(before)!, before)).toBe(false);
    expect(await sqlOwes(id)).toBe(false);

    const r = await updateFocusSession({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      completeOutput: "landing-copy",
    });
    expect(r.status).toBe("updated");

    const after = await stored(id);
    const copy = after.find((o) => o.key === "landing-copy")!;
    // A claim, not a delivery: the required criterion still checks it.
    expect(copy).toMatchObject({ claimedDone: true });
    expect(copy.status).not.toBe("done");
    expect(isOwedSlot(gradeOf(after)!, after)).toBe(true);
    expect(await sqlOwes(id)).toBe(true);

    // The claim write hands the newly owed grade to the push.
    const slotsNotice = h.notified.find(
      (n) => (n.reason as { kind?: string } | undefined)?.kind === "slots"
    );
    expect(slotsNotice).toBeDefined();
    const reason = slotsNotice!.reason as {
      before: ExpectedOutput[];
      after: ExpectedOutput[];
    };
    expect(
      newlyOwedSlots(reason.before, reason.after).map((o) => o.criterionKey)
    ).toEqual(["copy-reads-well"]);
  });

  it("2. a judge criterion's escalation is owed at once, never hidden behind its output", async () => {
    const judged = {
      key: "copy-is-clear",
      statement: "The landing copy is clear",
      check: { kind: "judge" },
      outputKey: "landing-copy",
    };
    const id = await seed([judged], [COPY]);
    for (const attempt of [1, 2]) {
      await db.insert(sessionEvaluations).values({
        sessionId: id,
        userId: USER,
        criterionKey: "copy-is-clear",
        attempt,
        verdict: "fail",
        evaluatorKind: "judge",
      });
    }
    expect(
      await escalateFailingCriteria({ sessionId: id, userId: USER })
    ).toEqual(["copy-is-clear"]);
    const slots = await stored(id);
    const escalated = gradeOf(slots)!;
    expect(escalated).toMatchObject({ criterionKey: "copy-is-clear" });
    expect(escalated).not.toHaveProperty("outputKey");
    // The output is still in the making, and the escalation is owed anyway.
    expect(slots.find((o) => o.key === "landing-copy")?.claimedDone).not.toBe(
      true
    );
    expect(isOwedSlot(escalated, slots)).toBe(true);
    expect(await sqlOwes(id)).toBe(true);
    // The declared-grade reconcile leaves the escalation alone.
    await fileDeclaredGradeSlots(id);
    expect(gradeOf(await stored(id))).toEqual(escalated);
  });

  it("3. answer → reactor, real doors: an act naming a criterion the person grades brings up its card, and writes no verdict", async () => {
    const id = await seed(
      [GRADED_BY_PERSON],
      [
        COPY,
        {
          kind: "action",
          label: "Upload the brand guide",
          key: "brand-guide",
          owner: "human",
          blockedReason: "physical",
          ask: { mode: "act", steps: ["Upload it to the drive"] },
          unblocksTarget: { criterion: "copy-reads-well" },
        },
      ]
    );
    // No grade card yet (filed by no door so far).
    expect(gradeOf(await stored(id))).toBeUndefined();

    const answered = await answerExpectedOutput({
      sessionId: id,
      userId: USER,
      expectedLabel: "Upload the brand guide",
      text: "Done",
      messageId: null,
    });
    expect(answered.status).toBe("answered");
    const payload = h.emitted.find((p) => p.action === "slot_answered");
    expect((payload!.data as Record<string, unknown>).unblocksTarget).toEqual({
      criterion: "copy-reads-well",
    });

    // The one hop not run for real: the fan-out hands it to the reactor.
    expect(sessionUnblockNotifyReactor.match!(payload as never)).toBe(true);
    await sessionUnblockNotifyReactor.handler(payload as never, {} as never);

    const after = await stored(id);
    expect(gradeOf(after)).toMatchObject({
      criterionKey: "copy-reads-well",
      outputKey: "landing-copy",
      owner: "human",
    });
    // Nothing was decided for the person: no evaluation row, and the output
    // the grade checks is neither attested nor done.
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from session_evaluations where session_id = $1`,
      [id]
    );
    expect(rows[0]!.n).toBe(0);
    const copy = after.find((o) => o.key === "landing-copy")!;
    expect(copy.status).not.toBe("done");
    expect(copy).not.toHaveProperty("attestedBy");
  });
});
