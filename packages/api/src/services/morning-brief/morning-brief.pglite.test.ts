/**
 * The MORNING BRIEF on PGlite (tables generated from the Drizzle schema),
 * through the real SQL of `runMorningBriefs`: who gets one, when, once, and
 * what it says. Injected: the needs-you read (the signals router's own tests
 * pin THE number) and the notification door (its own tests pin mute, quiet
 * hours and push); the fake door writes the row the real one writes, so the
 * once-a-day marker is read from the table, as in production.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  nounInSentence,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { db as DatabaseHandle } from "@synap/database";
import type { CreateNotificationInput } from "../../notifications/NotificationService.js";
import {
  countNeedsYou,
  signalFromReviewSession,
} from "../signals/needs-you-union.js";
import {
  composeMorningBrief,
  morningBriefDue,
  morningBriefSchedule,
  needsYouForBrief,
  readClosedSince,
  runMorningBriefs,
  type NeedsYouForBrief,
} from "./morning-brief.js";
import {
  DELIVERED_DIGEST_TYPE,
  classifyOutcome,
  composeDeliveredDigest,
  digestSince,
  foldDelivered,
  outcomeMetAt,
  readDeliveredSince,
  type DeliveredFacts,
} from "./delivered-digest.js";

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

/**
 * Paris. Its space with stored settings says 08:00 "UTC" (a default a save
 * wrote): read on the person's clock. Its archived space (turned off) and its
 * oldest space (nothing stored) do not count.
 */
const A = "person-a";
/** New York; its space stores 16:00 Tokyo: a real stored timezone wins. */
const B = "person-b";
/**
 * Paris. Its OLDEST space stores nothing (08:00 would be due); a later one
 * stored the brief OFF: the space with stored settings decides.
 */
const E = "person-e";
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
  settings: Record<string, unknown> = {},
  archived = false
) {
  await client.query(
    `insert into workspaces (id, owner_id, name, settings, created_at, archived_at)
     values ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)`,
    [
      randomUUID(),
      ownerId,
      `${ownerId} space ${createdHoursAgo}`,
      JSON.stringify(settings),
      hoursAgo(createdHoursAgo),
      archived ? hoursAgo(1) : null,
    ]
  );
}

const briefOff = {
  proactiveAi: {
    enabled: true,
    morningBriefing: {
      enabled: false,
      cronHour: 8,
      cronMinute: 0,
      timezone: "UTC",
    },
  },
};

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
/** The brief's tests are about the brief: nothing delivered, no digest. */
const NOTHING_DELIVERED: DeliveredFacts = {
  prsMerged: 0,
  commitsLanded: 0,
  outcomesMet: 0,
  sessionsClosed: 0,
  closedTitles: [],
  floor: false,
};
const readDelivered = async () => NOTHING_DELIVERED;
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
  await person(E, "Europe/Paris");
  await person(G, "UTC", "agent");
  await space(A, 600, briefOff, true);
  await space(A, 500);
  await space(A, 100, briefAt(8, "UTC"));
  await space(B, 300, briefAt(16, "Asia/Tokyo"));
  await space(E, 500);
  await space(E, 100, briefOff);
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

  it("the title carries the count; the body names what is next, the session to close and the last day", () => {
    expect(
      composeMorningBrief({
        needsYou: { count: 1, floor: false, next: ["Pick a tone"] },
        readyToClose: 1,
        closedUnmet: 1,
        closedWithoutCriteria: 0,
      })
    ).toEqual({
      title: "1 thing needs you",
      body: [
        "Next: Pick a tone",
        "It is ready for you to close.",
        "In the last day, 1 session closed with its criteria unmet.",
      ].join("\n"),
    });
  });

  it("with only closed sessions to report, the title says nothing needs you", () => {
    expect(
      composeMorningBrief({
        needsYou: { count: 0, floor: false, next: [] },
        readyToClose: 0,
        closedUnmet: 2,
        closedWithoutCriteria: 1,
      })
    ).toEqual({
      title: "Nothing needs you today",
      body: "In the last day, 2 sessions closed with their criteria unmet and 1 session closed with no success criteria.",
    });
  });

  it("a capped count reads as a floor, and a long name is cut", () => {
    const brief = composeMorningBrief({
      needsYou: { count: 100, floor: true, next: ["x".repeat(90)] },
      readyToClose: 0,
      closedUnmet: 0,
      closedWithoutCriteria: 3,
    });
    expect(brief).toEqual({
      title: "100+ things need you today",
      body: `Next: ${"x".repeat(59)}…\nIn the last day, 3 sessions closed with no success criteria.`,
    });
  });

  it("a session ready to close is a PART of the headline, never added beside it", () => {
    // The real counting rule: a review session is summed into `needsYou`.
    const review = signalFromReviewSession(
      { id: "s-9", title: "Ship the brief", goal: null, updatedAt: NOW },
      NOW
    );
    const count = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      reviewSessions: 1,
      reviewSessionIds: ["s-9"],
    });
    expect(count.needsYou).toBe(1);
    const facts = needsYouForBrief({ count, rows: { needs_you: [review] } });
    expect(facts).toEqual({
      needsYou: { count: 1, floor: false, next: ["Ship the brief"] },
      readyToClose: 1,
    });
    expect(
      composeMorningBrief({
        ...facts,
        closedUnmet: 0,
        closedWithoutCriteria: 0,
      })!.body
    ).toBe("Next: Ship the brief\nIt is ready for you to close.");
    expect(
      composeMorningBrief({
        needsYou: { count: 5, floor: false, next: [] },
        readyToClose: 2,
        closedUnmet: 0,
        closedWithoutCriteria: 0,
      })
    ).toEqual({
      title: "5 things need you today",
      body: "2 are ready for you to close.",
    });
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

  it('a stored "UTC" (the default a save writes back) reads as unset', () => {
    expect(
      morningBriefSchedule(briefAt(7, "UTC") as never, "Europe/Paris")
    ).toMatchObject({ hour: 7, timeZone: "Europe/Paris" });
    expect(morningBriefSchedule(briefAt(7, "UTC") as never, "")).toMatchObject({
      timeZone: "UTC",
    });
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
    await client.query(
      `delete from notifications where type = $1 or type = $2`,
      ["ai.proactive.morning_briefing", DELIVERED_DIGEST_TYPE]
    );
  });

  it("sends one brief to who is due and has something to say; agents, the off switch, a snooze and the settings space are honoured", async () => {
    const door = fakeDoor(NOW);
    const result = await runMorningBriefs({
      database,
      now: NOW,
      notify: door.notify,
      readNeedsYou,
      readDelivered,
    });
    // People: A, B, C, D, E (the agent is not one). Due: A (08:00 on its
    // Paris clock) and B (16:00 Tokyo, not New York's 03:10). Not due: C
    // (off), D (snoozed), E (its stored-settings space turned the brief off).
    // B has nothing to say.
    // The digest is due for E too (its brief is off, not its digest).
    expect(result).toEqual({
      people: 5,
      due: 2,
      sent: 1,
      failed: 0,
      digest: { due: 3, sent: 0, failed: 0 },
    });
    expect(door.calls).toHaveLength(1);
    expect(door.calls[0]).toMatchObject({
      type: "ai.proactive.morning_briefing",
      userId: A,
      workspaceId: null,
      sourceType: "proactive_message",
      // The person's day, so the door's dedupe window holds one open brief.
      groupKey: "morning-brief:2026-10-29",
    });
    expect(door.calls[0]!.data.title).toBe("4 things need you today");
    expect(door.calls[0]!.data.body).toBe(
      [
        "Next: Approve the invoice · Pick a tone · Review the launch plan",
        "1 is ready for you to close.",
        "In the last day, 2 sessions closed with their criteria unmet and 1 session closed with no success criteria.",
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
      readDelivered,
    });
    expect(first.calls).toHaveLength(1);

    const again = fakeDoor(NOW);
    const rerun = await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 15 * 60_000),
      notify: again.notify,
      readNeedsYou,
      readDelivered,
    });
    expect(again.calls).toHaveLength(0);
    expect(rerun.sent).toBe(0);

    const tomorrow = fakeDoor(NOW);
    await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 24 * 3_600_000),
      notify: tomorrow.notify,
      readNeedsYou,
      readDelivered,
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
      readDelivered,
    });
    expect(result).toMatchObject({ due: 2, sent: 0, failed: 2 });
    expect(door.calls).toHaveLength(0);
  });
});

// ── The delivered digest (plan d679e92c C9) ─────────────────────────────────

describe("composeDeliveredDigest — what got delivered, nothing when nothing", () => {
  it("says nothing when nothing was delivered", () => {
    expect(composeDeliveredDigest(NOTHING_DELIVERED)).toBeNull();
  });

  it("names each kind once, then the sessions closed", () => {
    expect(
      composeDeliveredDigest({
        prsMerged: 2,
        commitsLanded: 1,
        outcomesMet: 3,
        sessionsClosed: 4,
        closedTitles: ["Ship the digest", "y".repeat(90), "Mute", "Fourth"],
        floor: false,
      })
    ).toEqual({
      title: "Delivered since your last digest",
      body: `2 pull requests merged, 1 commit landed, 3 outcomes delivered, 4 sessions closed.\nClosed: Ship the digest · ${"y".repeat(59)}… · Mute`,
    });
  });

  it("a capped read reads as a floor", () => {
    expect(
      composeDeliveredDigest({
        ...NOTHING_DELIVERED,
        sessionsClosed: 1,
        floor: true,
      })?.body
    ).toBe(`1 ${nounInSentence(resolveObjectNoun("session"))}+ closed.`);
  });
});

describe("what counts as delivered", () => {
  const since = new Date(hoursAgo(24));
  it("an outcome counts from the time the pod stamped it delivered, never a guess", () => {
    expect(
      outcomeMetAt({ status: "done", satisfiedByEvidence: { at: hoursAgo(2) } })
    ).toBe(Date.parse(hoursAgo(2)));
    expect(outcomeMetAt({ status: "done", attestedAt: hoursAgo(3) })).toBe(
      Date.parse(hoursAgo(3))
    );
    // Done by an approval, with no recorded time: not counted.
    expect(
      outcomeMetAt({ status: "done", satisfiedByProposalId: "p" })
    ).toBeNull();
    expect(
      outcomeMetAt({ status: "pending", attestedAt: hoursAgo(1) })
    ).toBeNull();
    expect(
      outcomeMetAt({
        status: "done",
        attestedAt: hoursAgo(1),
        retiredAt: hoursAgo(1),
      })
    ).toBeNull();
  });

  it("a PR is its ref, a commit its kind or url; a fact is a check, not a delivery", () => {
    expect(
      classifyOutcome({
        kind: "output",
        ref: { url: "https://github.com/Synap-core/backend/pull/7" },
      })
    ).toEqual({ kind: "pr", key: "synap-core/backend#7" });
    expect(
      classifyOutcome({ kind: "commit", key: "commit-browser-abc12345" })
    ).toMatchObject({ kind: "commit" });
    expect(
      classifyOutcome({
        kind: "output",
        ref: { url: "https://github.com/Synap-core/browser/commit/abc12345" },
      })
    ).toMatchObject({ kind: "commit" });
    expect(classifyOutcome({ kind: "fact" })).toEqual({ kind: "skip" });
    expect(classifyOutcome({ kind: "document" })).toEqual({ kind: "outcome" });
  });

  it("a PR met as an outcome AND merged as a fact counts once", () => {
    const facts = foldDelivered(
      [
        {
          id: "s",
          title: "Lane",
          goal: null,
          status: "active",
          closedAt: null,
          expectedOutputs: [
            {
              kind: "pull_request",
              status: "done",
              satisfiedByEvidence: { at: hoursAgo(1) },
              ref: { url: "https://github.com/Synap-core/backend/pull/7" },
            },
          ],
        },
      ],
      ["synap-core/backend#7", "synap-core/backend#8"],
      since,
      false
    );
    expect(facts.prsMerged).toBe(2);
  });

  it("since the last digest, else a day, never more than a week", () => {
    expect(digestSince(NOW, null).toISOString()).toBe(hoursAgo(24));
    expect(digestSince(NOW, new Date(hoursAgo(30))).toISOString()).toBe(
      hoursAgo(30)
    );
    expect(digestSince(NOW, new Date(hoursAgo(24 * 30))).toISOString()).toBe(
      hoursAgo(24 * 7)
    );
  });
});

describe("readDeliveredSince — through the real SQL", () => {
  /** A person whose agents delivered; no space, so the pass never picks them. */
  const F = "person-f";
  const LANE = randomUUID();
  const OLD = randomUUID();
  const STRANGER = "person-s";
  const STRANGER_LANE = randomUUID();

  async function session(args: {
    id: string;
    user: string;
    status: string;
    updatedHoursAgo: number;
    closedHoursAgo?: number;
    title?: string;
    outputs?: unknown[];
  }) {
    await client.query(
      `insert into focus_sessions (id, user_id, title, goal, status, origin, metadata, criteria, expected_outputs, closed_at, updated_at)
       values ($1, $2, $3, 'A goal', $4, 'agent', '{}'::jsonb, '[]'::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz)`,
      [
        args.id,
        args.user,
        args.title ?? null,
        args.status,
        JSON.stringify(args.outputs ?? []),
        args.closedHoursAgo === undefined
          ? null
          : hoursAgo(args.closedHoursAgo),
        hoursAgo(args.updatedHoursAgo),
      ]
    );
  }

  async function merged(
    sessionId: string,
    n: number,
    h: number,
    intoDefault: boolean
  ) {
    await client.query(
      `insert into events (id, type, data, timestamp) values ($1, 'dev.pr_merged', $2::jsonb, $3::timestamptz)`,
      [
        randomUUID(),
        JSON.stringify({
          repo: "Synap-core/backend",
          number: n,
          url: `https://github.com/Synap-core/backend/pull/${n}`,
          intoDefault,
          sessionId,
        }),
        hoursAgo(h),
      ]
    );
  }

  beforeAll(async () => {
    await person(F, "Europe/Paris");
    await person(STRANGER, "UTC");
    await session({
      id: LANE,
      user: F,
      status: "closed",
      updatedHoursAgo: 1,
      closedHoursAgo: 1,
      title: "Ship the digest",
      outputs: [
        // A PR met by evidence (and merged as a fact below): once.
        {
          key: "pr-backend-7",
          kind: "pull_request",
          label: "backend#7",
          status: "done",
          satisfiedByEvidence: { kind: "ref", id: "x", at: hoursAgo(2) },
          ref: { url: "https://github.com/Synap-core/backend/pull/7" },
        },
        {
          key: "commit-browser-abc12345",
          kind: "commit",
          label: "browser@abc12345",
          status: "done",
          satisfiedByEvidence: { kind: "ref", id: "y", at: hoursAgo(3) },
          ref: { url: "https://github.com/Synap-core/browser/commit/abc12345" },
        },
        {
          kind: "document",
          label: "Report",
          status: "done",
          attestedAt: hoursAgo(4),
        },
        // Not counted: a fact, a met time never recorded, too old, withdrawn.
        {
          kind: "fact",
          label: "Tests pass",
          status: "done",
          attestedAt: hoursAgo(1),
        },
        {
          kind: "document",
          label: "Approved",
          status: "done",
          satisfiedByProposalId: "p",
        },
        {
          kind: "document",
          label: "Old",
          status: "done",
          attestedAt: hoursAgo(30),
        },
        {
          kind: "document",
          label: "Dropped",
          status: "done",
          attestedAt: hoursAgo(1),
          retiredAt: hoursAgo(1),
        },
      ],
    });
    // Closed too long ago, and untouched since: not news.
    await session({
      id: OLD,
      user: F,
      status: "closed",
      updatedHoursAgo: 40,
      closedHoursAgo: 40,
    });
    // Cancelled since: ended, not delivered.
    await session({
      id: randomUUID(),
      user: F,
      status: "cancelled",
      updatedHoursAgo: 2,
      closedHoursAgo: 2,
    });
    await session({
      id: STRANGER_LANE,
      user: STRANGER,
      status: "closed",
      updatedHoursAgo: 1,
      closedHoursAgo: 1,
    });
    await merged(LANE, 7, 2, true);
    await merged(LANE, 8, 5, true);
    // Into a stacked branch: not on main, not delivered (founder F3).
    await merged(LANE, 9, 5, false);
    // Before the window.
    await merged(LANE, 10, 30, true);
    // Someone else's session.
    await merged(STRANGER_LANE, 11, 1, true);
  });

  it("counts PRs merged (once each), commits landed, outcomes met and work sessions closed since then", async () => {
    expect(
      await readDeliveredSince(database, F, new Date(hoursAgo(24)))
    ).toEqual({
      prsMerged: 2,
      commitsLanded: 1,
      outcomesMet: 1,
      sessionsClosed: 1,
      closedTitles: ["Ship the digest"],
      floor: false,
    });
  });

  it("nothing since a later moment is nothing", async () => {
    expect(
      await readDeliveredSince(database, F, new Date(hoursAgo(0.5)))
    ).toEqual(NOTHING_DELIVERED);
  });
});

describe("runMorningBriefs — the digest in the same pass", () => {
  beforeEach(async () => {
    await client.query(
      `delete from notifications where type = $1 or type = $2`,
      ["ai.proactive.morning_briefing", DELIVERED_DIGEST_TYPE]
    );
  });

  it("sends one digest to who is due and had something delivered, at most once a day, pod-wide and per day", async () => {
    const door = fakeDoor(NOW);
    const result = await runMorningBriefs({
      database,
      now: NOW,
      notify: door.notify,
      readNeedsYou,
    });
    // Due: A, B, E. Only A had work sessions closed in the last day (the
    // two closed 2 h ago; the cancelled one, the old one and the automation
    // run do not count).
    expect(result.digest).toEqual({ due: 3, sent: 1, failed: 0 });
    const digests = door.calls.filter((c) => c.type === DELIVERED_DIGEST_TYPE);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      userId: A,
      workspaceId: null,
      sourceType: "proactive_message",
      groupKey: "delivered-digest:2026-10-29",
      data: {
        title: "Delivered since your last digest",
        body: "2 sessions closed.\nClosed: A goal · A goal",
        since: hoursAgo(24),
      },
    });

    // A re-run the same morning sends no second digest.
    const again = fakeDoor(NOW);
    const rerun = await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 15 * 60_000),
      notify: again.notify,
      readNeedsYou,
    });
    expect(rerun.digest.sent).toBe(0);
    expect(again.calls.filter((c) => c.type === DELIVERED_DIGEST_TYPE)).toEqual(
      []
    );

    // The next morning reports since the last digest: nothing new, nothing
    // sent. D's snooze ends then, so D is due too (and had nothing delivered).
    const tomorrow = fakeDoor(NOW);
    const next = await runMorningBriefs({
      database,
      now: new Date(NOW.getTime() + 24 * 3_600_000),
      notify: tomorrow.notify,
      readNeedsYou,
    });
    expect(next.digest).toEqual({ due: 4, sent: 0, failed: 0 });
  });

  it("a failed read skips the person and is counted, never sent as an empty digest", async () => {
    const door = fakeDoor(NOW);
    const result = await runMorningBriefs({
      database,
      now: NOW,
      notify: door.notify,
      readNeedsYou,
      readDelivered: async () => {
        throw new Error("sessions read failed");
      },
    });
    expect(result.digest).toEqual({ due: 3, sent: 0, failed: 3 });
    // The brief is not held back by the digest's failure.
    expect(result.sent).toBe(1);
    expect(door.calls.map((c) => c.type)).toEqual([
      "ai.proactive.morning_briefing",
    ]);
  });
});
