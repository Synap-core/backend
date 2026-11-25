/**
 * DECISION ARMS (P5) — on PGlite: the REAL `session-unblock-notify` reactor,
 * the REAL arm settle (`decision-arms.ts`) and the REAL dependency reads
 * (`openBlockerIds`, `readDependencyState` → `deriveOpenBlockers`, the
 * `notTaken` record read as `skipped`). Captured, and why: the notification
 * write (its own suite covers the door) and THE close door
 * (`completeFocusSession`: its own suites cover it; here it records the call
 * and lands the row it would land: `cancelled` + `verification_report.notTaken`).
 *
 * Each case names the WRONG rule it rules out.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<Record<string, unknown>>,
  closes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("@synap/events", () => ({
  registerReactor: () => {},
  emitSideEffects: async () => {},
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.created.push(input);
      return "n-1";
    },
  },
}));

vi.mock("../../services/focus-sessions/complete-session.js", () => ({
  completeFocusSession: async (p: Record<string, unknown>) => {
    h.closes.push(p);
    const report =
      p.notTaken && p.terminalStatus === "cancelled"
        ? JSON.stringify({ notTaken: p.notTaken })
        : null;
    await h.client!.query(
      `update focus_sessions set status = $2, verification_report = $3::jsonb where id = $1`,
      [p.sessionId, p.terminalStatus, report]
    );
    return { session: { id: p.sessionId, status: p.terminalStatus } };
  },
}));

import { allSchemaTables, pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import { sessionUnblockNotifyReactor } from "../session-unblock-reactor.js";
import { resolveDecisionArms } from "../../services/focus-sessions/decision-arms.js";

const OWNER = "user-owner";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function decision(
  title: string,
  status: string,
  category: string,
  chosenOption: string | null
): Promise<string> {
  const id = randomUUID();
  const properties = {
    decisionOptions: [
      { label: "Raise", value: "raise" },
      { label: "Bootstrap", value: "bootstrap" },
      { label: "Sell", value: "sell" },
    ],
    ...(chosenOption ? { chosenOption } : {}),
  };
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, status, status_category, properties, system_data)
     values ($1, $2, null, 'decision', $3, $4, $5, $6::jsonb, '{}'::jsonb)`,
    [id, OWNER, title, status, category, JSON.stringify(properties)]
  );
  return id;
}

async function session(
  title: string,
  status = "active",
  report: Record<string, unknown> | null = null
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, verification_report, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, $6::jsonb, now(), now())`,
    [id, OWNER, title, title, status, report ? JSON.stringify(report) : null]
  );
  return id;
}

async function waits(
  fromId: string,
  toType: "session" | "entity",
  toId: string,
  option?: string
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(), 'session', $1, $2, $3, 'blocked_by', $4::jsonb, now())`,
    [fromId, toType, toId, JSON.stringify(option ? { option } : {})]
  );
}

/** The status door's emit for a decision's own move. */
async function accepted(decisionId: string) {
  const ev = {
    subjectType: "entity",
    action: "transition",
    subjectId: decisionId,
    userId: OWNER,
    workspaceId: null,
    data: {
      entityId: decisionId,
      profileSlug: "decision",
      lifecycleProfile: "decision",
      role: null,
      from: "proposed",
      to: "accepted",
      category: "done",
    },
  } as never;
  expect(sessionUnblockNotifyReactor.match!(ev)).toBe(true);
  await sessionUnblockNotifyReactor.handler(ev, {} as never);
}

/** The close door's emit (`focus_session.closed`) for a session. */
async function closed(sessionId: string) {
  const ev = {
    subjectType: "focus_session",
    action: "closed",
    subjectId: sessionId,
    userId: OWNER,
    workspaceId: null,
    data: { sessionId },
  } as never;
  expect(sessionUnblockNotifyReactor.match!(ev)).toBe(true);
  await sessionUnblockNotifyReactor.handler(ev, {} as never);
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
});

beforeEach(() => {
  h.created.length = 0;
  h.closes.length = 0;
});

describe("an accepted decision settles its arms", () => {
  it("the arm CHOSEN is unblocked; the arm NOT taken is skipped through the close door; a plain wait is unblocked (rules out 'accepted frees every arm')", async () => {
    const d = await decision("Raise or bootstrap", "accepted", "done", "raise");
    const raise = await session("Pitch investors", "forming");
    const boot = await session("Cut costs", "forming");
    const plain = await session("Tell the team");
    await waits(raise, "entity", d, "raise");
    await waits(boot, "entity", d, "bootstrap");
    await waits(plain, "entity", d);

    await accepted(d);

    // Exactly the arm not taken is closed — as the system, cancelled, with
    // the skip record the dependency rule reads.
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]).toMatchObject({
      sessionId: boot,
      userId: OWNER,
      terminalStatus: "cancelled",
      actor: { kind: "system", userId: OWNER },
      notTaken: { decisionId: d, option: "bootstrap", chosenOption: "raise" },
    });
    expect(await statusOf(boot)).toBe("cancelled");
    // The arm taken lost its last blocker: the planned step WAKES (P3).
    expect(await statusOf(raise)).toBe("active");

    const told = h.created
      .filter((n) => n.type === "session.unblocked")
      .map((n) => n.sourceId)
      .sort();
    expect(told).toEqual([raise, plain].sort());
  });

  it("a step after a SKIPPED arm is freed by it; after a plain cancel it is not (skipped = delivered for ordering)", async () => {
    const d = await decision("Hire or contract", "accepted", "done", "raise");
    const takenArm = await session("Hire", "forming");
    await waits(takenArm, "entity", d, "raise");
    const skippedArm = await session("Contract out", "forming");
    await waits(skippedArm, "entity", d, "bootstrap");
    const after = await session("Onboard the team", "forming");
    await waits(after, "session", skippedArm);
    // CONTROL: the same wait on a session cancelled with no skip record.
    const cancelled = await session("Old plan", "cancelled");
    const stuck = await session("Depends on the old plan", "forming");
    await waits(stuck, "session", cancelled);

    await accepted(d);
    expect(await statusOf(skippedArm)).toBe("cancelled");
    h.created.length = 0;

    // The close door's own event for the skipped step reaches its dependent.
    await closed(skippedArm);
    await closed(cancelled);

    expect(
      h.created
        .filter((n) => n.type === "session.unblocked")
        .map((n) => n.sourceId)
    ).toEqual([after]);
  });

  it("NO arm for the choice: nothing is skipped, every arm holds, the owner is told once (never a silent green)", async () => {
    const d = await decision("Exit path", "accepted", "done", "sell");
    const raise = await session("Raise a round", "forming");
    const boot = await session("Stay small", "forming");
    await waits(raise, "entity", d, "raise");
    await waits(boot, "entity", d, "bootstrap");

    await accepted(d);

    expect(h.closes).toHaveLength(0);
    expect(await statusOf(raise)).toBe("forming");
    expect(await statusOf(boot)).toBe("forming");
    const unmatched = h.created.filter(
      (n) => n.type === "session.arm_unmatched"
    );
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({
      userId: OWNER,
      groupKey: `session.arm_unmatched:${d}:sell`,
      data: { decisionId: d, chosenOption: "sell", decisionTitle: "Exit path" },
    });
    // Neither arm reads unblocked.
    expect(h.created.filter((n) => n.type === "session.unblocked")).toEqual([]);
  });

  it("a REJECTED or still-open decision skips nothing (rules out 'any answer settles the arms')", async () => {
    const rejected = await decision("Go abroad", "rejected", "lost", "raise");
    const open = await decision("Pick a bank", "proposed", "open", null);
    const a = await session("Open the office", "forming");
    const b = await session("Wire the funds", "forming");
    await waits(a, "entity", rejected, "bootstrap");
    await waits(b, "entity", open, "bootstrap");

    expect(await resolveDecisionArms(rejected)).toEqual({
      skipped: [],
      unmatched: false,
    });
    expect(await resolveDecisionArms(open)).toEqual({
      skipped: [],
      unmatched: false,
    });
    expect(h.closes).toHaveLength(0);
  });

  it("is idempotent: settling again closes nothing twice", async () => {
    const d = await decision("Region", "accepted", "done", "raise");
    const us = await session("US first", "forming");
    await waits(us, "entity", d, "raise");
    const boot = await session("EU first", "forming");
    await waits(boot, "entity", d, "bootstrap");

    expect((await resolveDecisionArms(d)).skipped).toEqual([boot]);
    expect((await resolveDecisionArms(d)).skipped).toEqual([]);
    expect(h.closes).toHaveLength(1);
  });
});
