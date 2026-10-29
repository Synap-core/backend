/**
 * The MORNING BRIEF on PGlite (tables generated from the Drizzle schema),
 * through the real SQL of `runMorningBriefs`: who gets one, when, once, and
 * what it says. Injected: the needs-you read (the signals router's own tests
 * pin THE number) and the notification door (its own tests pin mute, quiet
 * hours and push); the fake door writes the row the real one writes, so the
 * once-a-day marker is read from the table, as in production.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { db as DatabaseHandle } from "@synap/database";
import type { CreateNotificationInput } from "../../notifications/NotificationService.js";
import {
  composeMorningBrief,
  morningBriefDue,
  morningBriefSchedule,
  readClosedSince,
  runMorningBriefs,
  MORNING_BRIEF_NOTIFICATION_TYPE,
  type NeedsYouForBrief,
} from "./morning-brief.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

// 07:10 UTC = 08:10 in Paris (CET since 25 Oct 2026) = 03:10 in New York.
const NOW = new Date("2026-10-29T07:10:00Z");
const hoursAgo = (n: number) =>
  new Date(NOW.getTime() - n * 3_600_000).toISOString();

/** Paris, first space stores nothing: 08:00 in the person's own timezone. */
const A = "person-a";
/** New York, first space stores 07:00 UTC: the stored timezone wins. */
const B = "person-b";
/** Proactive AI off in their first space. */
const C = "person-c";
/** Snoozed until tomorrow. */
const D = "person-d";
/** An agent that owns a space: never a recipient. */
const G = "agent-g";

let client: PGlite;
let database: typeof DatabaseHandle;

async function person(id: string, timezone: string, userType = "human") {
  await client.query(
    `insert into users (id, email, timezone, user_type) values ($1, $2, $3, $4)`,
    [id, `${id}@example.test`, timezone, userType]
  );
}

async function space(
  ownerId: string,
  createdHoursAgo: number,
  settings: Record<string, unknown> = {}
) {
  await client.query(
    `insert into workspaces (id, owner_id, name, settings, created_at)
     values ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
    [
      randomUUID(),
      ownerId,
      `${ownerId} space ${createdHoursAgo}`,
      JSON.stringify(settings),
      hoursAgo(createdHoursAgo),
    ]
  );
}

const briefAt = (cronHour: number, timezone: string, more = {}) => ({
  proactiveAi: {
    enabled: true,
    morningBriefing: { enabled: true, cronHour, cronMinute: 0, timezone },
    ...more,
  },
});

async function closedSession(args: {
  user: string;
  status: string;
  closedHoursAgo: number;
  criteria?: unknown[];
  origin?: string;
}) {
  await client.query(
    `insert into focus_sessions (id, user_id, goal, status, origin, metadata, criteria, expected_outputs, closed_at, updated_at)
     values ($1, $2, 'A goal', $3, $4, '{}'::jsonb, $5::jsonb, '[]'::jsonb, $6::timestamptz, $6::timestamptz)`,
    [
      randomUUID(),
      args.user,
      args.status,
      args.origin ?? "user",
      JSON.stringify(args.criteria ?? []),
      hoursAgo(args.closedHoursAgo),
    ]
  );
}

async function notification(
  user: string,
  type: string,
  createdHoursAgo: number,
  sourceId: string | null = null
) {
  await client.query(
    `insert into notifications (user_id, type, category, priority, title, body, source_type, source_id, status, created_at)
     values ($1, $2, 'ai', 'normal', 't', 'b', 'session', $3, 'unread', $4::timestamptz)`,
    [user, type, sourceId, hoursAgo(createdHoursAgo)]
  );
}

/** The door's stand-in: writes the row the real door writes, records the call. */
function fakeDoor(at: Date) {
  const calls: CreateNotificationInput[] = [];
  const notify = async (input: CreateNotificationInput) => {
    calls.push(input);
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `insert into notifications (user_id, type, category, priority, title, body, source_type, status, created_at)
       values ($1, $2, 'ai', 'normal', $3, $4, $5, 'unread', $6::timestamptz) returning id`,
      [
        input.userId,
        input.type,
        String(input.data.title),
        String(input.data.body),
        input.sourceType,
        at.toISOString(),
      ]
    );
    return row!.id;
  };
  return { calls, notify };
}

const NEEDS: Record<string, NeedsYouForBrief> = {
  [A]: {
    needsYou: {
      count: 4,
      floor: false,
      next: ["Approve the invoice", "Pick a tone.", "Review the launch plan"],
    },
    readyToClose: 1,
  },
};
const readNeedsYou = async (userId: string): Promise<NeedsYouForBrief> =>
  NEEDS[userId] ?? {
    needsYou: { count: 0, floor: false, next: [] },
    readyToClose: 0,
  };

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  database = drizzle(client, { schema }) as unknown as typeof DatabaseHandle;

  await person(A, "Europe/Paris");
  await person(B, "America/New_York");
  await person(C, "UTC");
  await person(D, "UTC");
  await person(G, "UTC", "agent");
  // A's FIRST space stores nothing; a later one turned the brief off.
  await space(A, 500);
  await space(A, 100, {
    proactiveAi: {
      enabled: true,
      morningBriefing: {
        enabled: false,
        cronHour: 8,
        cronMinute: 0,
        timezone: "UTC",
      },
    },
  });
  await space(B, 300, briefAt(7, "UTC"));
  await space(C, 300, {
    proactiveAi: { ...briefAt(7, "UTC").proactiveAi, enabled: false },
  });
  await space(D, 300, briefAt(7, "UTC", { mutedUntil: hoursAgo(-24) }));
  await space(G, 300, briefAt(7, "UTC"));

  // A's last day: one closed without criteria counts; criteria declared,
  // cancelled, too old and an automation run do not.
  await closedSession({ user: A, status: "closed", closedHoursAgo: 2 });
  await closedSession({
    user: A,
    status: "closed",
    closedHoursAgo: 2,
    criteria: [
      { key: "ships", statement: "It ships", check: { kind: "human" } },
    ],
  });
  await closedSession({ user: A, status: "cancelled", closedHoursAgo: 2 });
  await closedSession({ user: A, status: "closed", closedHoursAgo: 30 });
  await closedSession({
    user: A,
    status: "closed",
    closedHoursAgo: 2,
    origin: "automation",
  });
  // Criteria unmet: one session raised twice, another once, one too old.
  const unmet = "session.closed.criteria_unmet";
  await notification(A, unmet, 3, "s-1");
  await notification(A, unmet, 1, "s-1");
  await notification(A, unmet, 5, "s-2");
  await notification(A, unmet, 40, "s-3");
}, 120_000);

describe("composeMorningBrief — plain words, nothing when nothing", () => {
  it("says nothing when nothing waits and nothing closed", () => {
    expect(
      composeMorningBrief({
        needsYou: { count: 0, floor: false, next: [] },
        readyToClose: 0,
        closedUnmet: 0,
        closedWithoutCriteria: 0,
      })
    ).toBeNull();
  });

  it("names the count, the next three, the sessions to close and the last day", () => {
    expect(
      composeMorningBrief({
        needsYou: { count: 1, floor: false, next: ["Pick a tone"] },
        readyToClose: 2,
        closedUnmet: 1,
        closedWithoutCriteria: 0,
      })
    ).toEqual({
      title: "Your morning brief",
      body: [
        "1 thing waits on you: Pick a tone.",
        "2 sessions are ready for you to close.",
        "In the last day, 1 session closed with required criteria not met.",
      ].join("\n"),
    });
  });

  it("a capped count reads as a floor, and a long name is cut", () => {
    const brief = composeMorningBrief({
      needsYou: { count: 100, floor: true, next: ["x".repeat(90)] },
      readyToClose: 0,
      closedUnmet: 0,
      closedWithoutCriteria: 3,
    });
    expect(brief!.body).toBe(
      `100+ things wait on you: ${"x".repeat(59)}….\nIn the last day, 3 sessions closed with no criteria.`
    );
  });
});

describe("when the brief is due", () => {
  it("is due for the hour after the time, on the person's clock, across midnight", () => {
    const paris = { hour: 8, minute: 0, timeZone: "Europe/Paris" };
    expect(morningBriefDue(new Date("2026-10-29T07:00:00Z"), paris)).toBe(true);
    expect(morningBriefDue(new Date("2026-10-29T07:59:00Z"), paris)).toBe(true);
    expect(morningBriefDue(new Date("2026-10-29T08:00:00Z"), paris)).toBe(
      false
    );
    expect(morningBriefDue(new Date("2026-10-29T06:59:00Z"), paris)).toBe(
      false
    );
    const late = { hour: 23, minute: 30, timeZone: "UTC" };
    expect(morningBriefDue(new Date("2026-10-30T00:10:00Z"), late)).toBe(true);
    expect(morningBriefDue(new Date("2026-10-30T00:31:00Z"), late)).toBe(false);
  });

  it("reads the stored time and timezone; with none stored, 08:00 on the person's clock", () => {
    expect(morningBriefSchedule({}, "Europe/Paris")).toMatchObject({
      hour: 8,
      minute: 0,
      timeZone: "Europe/Paris",
    });
    expect(
      morningBriefSchedule(briefAt(7, "Asia/Tokyo") as never, "Europe/Paris")
    ).toMatchObject({ hour: 7, timeZone: "Asia/Tokyo" });
  });
});

describe("readClosedSince", () => {
  it("counts each unmet session once, and work sessions closed with no criteria", async () => {
    expect(await readClosedSince(database, A, new Date(hoursAgo(24)))).toEqual({
      closedUnmet: 2,
      closedWithoutCriteria: 1,
    });
  });
});

describe("runMorningBriefs", () => {
  beforeEach(async () => {
    await client.query(`delete from notifications where type = $1`, [
      MORNING_BRIEF_NOTIFICATION_TYPE,
    ]);
  });

  it("sends one brief to who is due and has something to say; agents, the off switch and a snooze are skipped", async () => {
    const door = fakeDoor(NOW);
    const result = await runMorningBriefs({
      database,
      now: NOW,
      notify: door.notify,
      readNeedsYou,
    });
    // People: A, B, C, D (the agent is not one). Due: A (08:00 Paris) and B
    // (07:00 UTC, its stored timezone, not New York's 03:10). B has nothing.
    expect(result).toEqual({ people: 4, due: 2, sent: 1, failed: 0 });
    expect(door.calls).toHaveLength(1);
    expect(door.calls[0]).toMatchObject({
      type: "ai.proactive.morning_briefing",
      userId: A,
      workspaceId: null,
      sourceType: "proactive_message",
    });
    expect(door.calls[0]!.data.body).toBe(
      [
        "4 things wait on you: Approve the invoice; Pick a tone; Review the launch plan.",
        "1 session is ready for you to close.",
        "In the last day, 2 sessions closed with required criteria not met and 1 session closed with no criteria.",
      ].join("\n")
    );
  });

  it("a re-run the same morning sends nothing; the next morning sends again", async () => {
    const first = fakeDoor(NOW);
    await runMorningBriefs({
      database,
      now: NOW,
      notify: first.notify,
      readNeedsYou,
    });
    expect(first.calls).toHaveLength(1);

    const again = fakeDoor(NOW);
    const rerun = await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 15 * 60_000),
      notify: again.notify,
      readNeedsYou,
    });
    expect(again.calls).toHaveLength(0);
    expect(rerun.sent).toBe(0);

    const tomorrow = fakeDoor(NOW);
    await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 24 * 3_600_000),
      notify: tomorrow.notify,
      readNeedsYou,
    });
    expect(tomorrow.calls.map((c) => c.userId)).toEqual([A]);
  });

  it("a failed read skips the person and is counted, never sent as an empty brief", async () => {
    const door = fakeDoor(NOW);
    const result = await runMorningBriefs({
      database,
      now: NOW,
      notify: door.notify,
      readNeedsYou: async () => {
        throw new Error("signals read failed");
      },
    });
    expect(result).toMatchObject({ due: 2, sent: 0, failed: 2 });
    expect(door.calls).toHaveLength(0);
  });
});
