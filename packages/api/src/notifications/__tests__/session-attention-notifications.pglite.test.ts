/**
 * The two session-attention notifications, driven through the REAL doors.
 *
 * Reachability, not shape. Nothing here hand-builds a notification input: the
 * escalation is produced by calling `recordSessionEvaluation` until the
 * automatic attempts are exhausted, and the close notification by calling
 * `completeFocusSession` and then handing the emitted `focus_session.closed`
 * payload to the reactor's own handler. The rows are read back out of PGlite.
 * That is the seam the defect lived in: both events fired and NOTHING was
 * written, and every hand-built assertion downstream of the producer would have
 * passed anyway.
 *
 * Real: `recordSessionEvaluation`, `completeFocusSession`,
 * `NotificationService.create` (the one write door, with its real preference
 * lookup, dedupe gate and channel resolution), the criteria-unmet reactor's
 * handler, the `notifications` + `notification_preferences` tables.
 * Stubbed, and why: the socket bridge and Expo (no transport in a unit test —
 * both are captured so the CHANNEL decisions can be asserted), `logEvent` /
 * `expireSessionEphemerals` / the list-door projections (same reasons as
 * `session-evaluations.pglite.test.ts`, whose harness this mirrors).
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
  emitted: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
  sockets: [] as Array<Record<string, unknown>>,
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
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (e: Record<string, unknown>) => {
      h.emitted.push(e);
    },
  };
});

vi.mock("../expo-push.js", () => ({
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (e: Record<string, unknown>) => {
    h.sockets.push(e);
  },
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
vi.mock("../../lib/event-helpers.js", () => ({
  logEvent: async () => undefined,
}));
vi.mock("../../services/proposals/expire-lapsed-proposals.js", () => ({
  expireSessionEphemerals: async () => 0,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  playbookRuns,
  proposals,
  notifications,
  notificationPreferences,
  users,
} from "@synap/database";
import {
  recordSessionEvaluation,
  criterionEscalationGroupKey,
  CRITERION_ESCALATED_NOTIFICATION_TYPE,
} from "../../services/focus-sessions/evaluations/record.js";
import { completeFocusSession } from "../../services/focus-sessions/complete-session.js";
import {
  sessionCriteriaUnmetNotifyReactor,
  CRITERIA_UNMET_NOTIFICATION_TYPE,
  criteriaUnmetGroupKey,
} from "../session-criteria-unmet-reactor.js";

const USER = "user-1";
const AGENT = "agent-1";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** Two REQUIRED evidence criteria, so two can escalate independently. */
const CRITERIA = [
  {
    key: "typecheck",
    statement: "Typecheck passes",
    check: { kind: "evidence", evidenceKey: "tsc" },
  },
  {
    key: "smoke",
    statement: "Smoke check passes",
    check: { kind: "evidence", evidenceKey: "smoke" },
  },
];

async function seed(
  opts: { criteria?: unknown[]; title?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, verification_report, created_at, updated_at, started_at)
     values ($1, $2, 'Ship the thing', $3, 'active', '[]'::jsonb, $4, '{}'::jsonb, $5::jsonb, null, now(), now(), now())`,
    [
      id,
      USER,
      opts.title ?? "Ship the thing",
      [],
      JSON.stringify(opts.criteria ?? CRITERIA),
    ]
  );
  return id;
}

type NotifRow = {
  id: string;
  type: string;
  user_id: string;
  title: string;
  body: string;
  source_type: string;
  source_id: string;
  group_key: string | null;
  category: string;
  priority: string;
};

const notifs = (type?: string) =>
  q<NotifRow>(
    type
      ? `select * from notifications where type = $1 order by created_at`
      : `select * from notifications order by created_at`,
    type ? [type] : []
  ).then((r) => r.rows);

/** Burn the automatic attempts on one criterion, returning the last result. */
async function exhaust(sessionId: string, criterionKey: string) {
  let last;
  for (let i = 0; i < 2; i++) {
    last = await recordSessionEvaluation({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      criterionKey,
      verdict: "fail",
      evaluatorKind: "evidence",
    });
  }
  return last!;
}

/**
 * `ReactorDeps` carries only pg-boss, which this reactor never touches — there
 * is no queue in a unit test and the handler must not need one.
 */
const NO_DEPS = { boss: null } as never;

/** Close the session and hand the REAL emitted close payload to the reactor. */
async function closeAndReact(
  sessionId: string,
  terminalStatus?: "closed" | "cancelled" | "failed"
) {
  await completeFocusSession({
    sessionId,
    userId: USER,
    ...(terminalStatus ? { terminalStatus } : {}),
  });
  const close = h.emitted.find((e) => e.action === "closed");
  expect(
    close,
    "the close door must have emitted focus_session.closed"
  ).toBeTruthy();
  await sessionCriteriaUnmetNotifyReactor.handler(close as never, NO_DEPS);
  return close!;
}

describe("session attention notifications", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      playbooks,
      playbookRuns,
      proposals,
      notifications,
      notificationPreferences,
      users,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    // Quiet hours are read on the RECIPIENT's clock, so the recipient must
    // exist. Pinned to UTC so the window in the quiet-hours test is unambiguous
    // wherever this suite runs.
    await h.client!.query(
      `insert into users (id, email, timezone) values ($1, $2, 'UTC')`,
      [USER, "user-1@example.test"]
    );
    await h.client!.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../database/migrations/0267_session_criteria_and_evaluations.sql"
        ),
        "utf8"
      )
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.emitted.length = 0;
    h.pushes.length = 0;
    h.sockets.length = 0;
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  // ── Escalation ────────────────────────────────────────────────────────────

  it("escalation: exhausting the attempts on a required criterion writes ONE notification, and pushes", async () => {
    const id = await seed({ title: "Ship the parser" });
    const last = await exhaust(id, "typecheck");
    expect(last.status).toBe("recorded");
    if (last.status === "recorded") expect(last.escalated).toBe(true);

    const rows = await notifs(CRITERION_ESCALATED_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // The person, the session, the criterion — all present, none templated-through.
    expect(row.user_id).toBe(USER);
    expect(row.title).toBe("Needs your call: Ship the parser");
    expect(row.body).toContain("Typecheck passes");
    expect(row.body).toContain("checked 2 times");
    expect(row.body).not.toContain("{{");
    // The SESSION is the destination, so a tap can resolve it.
    expect(row.source_type).toBe("session");
    expect(row.source_id).toBe(id);
    expect(row.group_key).toBe(criterionEscalationGroupKey(id));
    expect(row.category).toBe("ai");
    expect(row.priority).toBe("high");

    // Both declared channels actually fired.
    expect(h.pushes).toHaveLength(1);
    expect(h.sockets).toHaveLength(1);
  });

  it("escalation: the FIRST failed attempt escalates nothing (the ladder is real, not a constant)", async () => {
    const id = await seed();
    const first = await recordSessionEvaluation({
      sessionId: id,
      userId: USER,
      agentUserId: AGENT,
      criterionKey: "typecheck",
      verdict: "fail",
      evaluatorKind: "evidence",
    });
    expect(first.status).toBe("recorded");
    if (first.status === "recorded") expect(first.escalated).toBe(false);
    expect(await notifs()).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
  });

  it("escalation grouping: a SECOND criterion escalating in the same session adds NO row and NO push", async () => {
    const id = await seed();
    await exhaust(id, "typecheck");
    expect(await notifs(CRITERION_ESCALATED_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);

    await exhaust(id, "smoke");

    // One notification per SESSION — the founder's grouping decision. The
    // second criterion IS a real escalation (its owed slot is filed); it is the
    // INTERRUPTION that is suppressed, not the work item.
    expect(await notifs(CRITERION_ESCALATED_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);
  });

  it("escalation dedupe DISCRIMINATES: a different SESSION escalating is not suppressed", async () => {
    // The pair that rules out "the dedupe suppresses everything after the
    // first". A single-row test cannot tell a working key from a dead one.
    const a = await seed({ title: "Session A" });
    const b = await seed({ title: "Session B" });
    await exhaust(a, "typecheck");
    await exhaust(b, "typecheck");

    const rows = await notifs(CRITERION_ESCALATED_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.group_key).sort()).toEqual(
      [criterionEscalationGroupKey(a), criterionEscalationGroupKey(b)].sort()
    );
    expect(h.pushes).toHaveLength(2);
  });

  it("escalation: a MUTED category produces nothing at all — no row, no push", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules, quiet_hours_enabled)
       values ($1, $2, null, true, '{"ai":"mute"}'::jsonb, false)`,
      [randomUUID(), USER]
    );
    const id = await seed();
    const last = await exhaust(id, "typecheck");

    // The WORK still happened — the owed slot is filed regardless of prefs.
    expect(last.status).toBe("recorded");
    if (last.status === "recorded") expect(last.escalated).toBe(true);
    // Only the telling is suppressed.
    expect(await notifs()).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });

  it("escalation: quiet hours persist the row and suppress BOTH interrupting channels", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       values ($1, $2, null, true, '{}'::jsonb, true, '00:00', '23:59')`,
      [randomUUID(), USER]
    );
    const id = await seed();
    await exhaust(id, "typecheck");

    expect(await notifs(CRITERION_ESCALATED_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
  });

  // ── Close with required criteria unmet ────────────────────────────────────

  it("close: a session closing with a required criterion unmet notifies once, and pushes", async () => {
    // ONE required criterion, on purpose: an ungraded required criterion is
    // `unmeasured` and counts as unmet too, so a two-criterion session that
    // escalated one of them is already at TWO unmet. That is correct — "not
    // measured" is not "met" — and it is why the singular is exercised here
    // with a single-criterion session rather than by grading one of two.
    const id = await seed({
      title: "Ship the parser",
      criteria: [CRITERIA[0]],
    });
    await exhaust(id, "typecheck");
    await q(`delete from notifications`);
    h.pushes.length = 0;

    await closeAndReact(id);

    const rows = await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.title).toBe("Closed and flagged: Ship the parser");
    // `unmetSummary` inflects; `statusLabel` comes from the vocabulary door.
    expect(row.body).toContain("1 required criterion not met");
    expect(row.body).not.toContain("{{");
    expect(row.source_type).toBe("session");
    expect(row.source_id).toBe(id);
    expect(row.group_key).toBe(criteriaUnmetGroupKey(id));
    expect(row.priority).toBe("normal");
    expect(h.pushes).toHaveLength(1);
  });

  it("close: TWO unmet required criteria say 'criteria', not 'criterion'", async () => {
    const id = await seed();
    await exhaust(id, "typecheck");
    await exhaust(id, "smoke");
    await q(`delete from notifications`);

    await closeAndReact(id);

    const rows = await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain("2 required criteria not met");
    expect(rows[0]!.body).not.toContain("criterion not met");
  });

  it("close: a session whose required criteria all PASSED notifies nothing", async () => {
    // The anti-vacuity half: proves the reactor's derivation is load-bearing
    // and it is not simply notifying on every close.
    const id = await seed();
    for (const key of ["typecheck", "smoke"]) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        criterionKey: key,
        verdict: "pass",
        evaluatorKind: "evidence",
      });
    }
    await closeAndReact(id);
    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(0);
  });

  it("close: a CANCELLED session is exempt — cancelling ends the obligation", async () => {
    const id = await seed();
    await exhaust(id, "typecheck");
    await q(`delete from notifications`);
    h.pushes.length = 0;

    await closeAndReact(id, "cancelled");

    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(0);
    expect(h.pushes).toHaveLength(0);
  });

  it("close: a REDELIVERED close event writes no second row and raises no second push", async () => {
    const id = await seed();
    await exhaust(id, "typecheck");
    await q(`delete from notifications`);
    h.pushes.length = 0;

    const close = await closeAndReact(id);
    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);

    // pg-boss can deliver the same job twice. The one door suppresses it.
    await sessionCriteriaUnmetNotifyReactor.handler(close as never, NO_DEPS);
    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(1);
    expect(h.pushes).toHaveLength(1);
  });

  it("close: the reactor RE-DERIVES — a forged verdict on the payload changes nothing", async () => {
    // The payload carries `verdict`. A reactor that trusted it could be made to
    // ring a phone by a replayed or hand-crafted event.
    const id = await seed();
    for (const key of ["typecheck", "smoke"]) {
      await recordSessionEvaluation({
        sessionId: id,
        userId: USER,
        agentUserId: AGENT,
        criterionKey: key,
        verdict: "pass",
        evaluatorKind: "evidence",
      });
    }
    const close = await closeAndReact(id);
    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(0);

    await sessionCriteriaUnmetNotifyReactor.handler(
      {
        ...(close as Record<string, unknown>),
        data: {
          ...((close as Record<string, unknown>).data as Record<
            string,
            unknown
          >),
          verdict: { requiredUnmet: 99, state: "failing" },
        },
      } as never,
      NO_DEPS
    );

    expect(await notifs(CRITERIA_UNMET_NOTIFICATION_TYPE)).toHaveLength(0);
  });
});
