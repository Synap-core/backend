/**
 * THE MORNING BRIEF — the producer the push contract reserved
 * (`@synap-core/types/push`, category `morning-brief`): once a day per person,
 * at the time their proactive settings name, ONE passive item saying what
 * waits on them. W0 of the status-flow plan (pod document aac47c4a,
 * 2026-10-29).
 *
 * BUILT ONLY FROM FACTS THE POD ALREADY COMPUTES, never a second rule:
 *   - what waits on you: THE needs-you read (`signals.needsYou`). Its count is
 *     the badge's number; its first three are Home's "next three moves"
 *     (`homeMoves` over `needsYouBuckets`);
 *   - sessions ready to close: the same read's `review` part, the sessions
 *     whose next move is `ready_to_close` (THE next-move rule,
 *     `continuation-packet.ts`). Closing is the PERSON's move (founder
 *     decision 2026-09-20): the brief names them, it never closes them;
 *   - sessions closed in the last day with required criteria unmet: the
 *     `session.closed.criteria_unmet` notifications its reactor already
 *     raised; and closed with no criteria at all: the work sessions settled
 *     since then that declared none.
 *
 * WHEN. Proactive settings live per workspace and the brief is per person, so
 * it reads the person's FIRST space (the oldest active workspace they own):
 * `morningBriefing.cronHour:cronMinute` in `morningBriefing.timezone` when the
 * space stored its settings, else the default 08:00 in the person's own
 * timezone (`users.timezone`). The cron ticks every 15 minutes and a person is
 * due for the hour after their time, so a missed tick catches up.
 *
 * HELD BACK by what holds every proactive post (`proactivePostHeldBy`: the
 * kill switch, a snooze) and by `morningBriefing.enabled`; delivered through
 * the ONE notification door, so mute, quiet hours and the push category
 * toggle apply as they do to every notification.
 *
 * ONCE A DAY. A brief raised in the last 20 hours is the marker: the due
 * window is one hour a day, so 20 hours never separates two ticks of one day
 * and always separates two days. A muted brief writes no row, and a re-run is
 * muted the same way.
 *
 * NOTHING TO SAY, NOTHING SENT. A read that FAILS skips that person (logged)
 * and the next tick retries: a failed read is never "nothing waits".
 */

import { createLogger } from "@synap-core/core";
import {
  db as defaultDb,
  and,
  eq,
  gte,
  isNull,
  drizzleSql,
  focusSessions,
  notifications,
  users,
  workspaces,
} from "@synap/database";
import {
  getDefaultProactiveAiPreferences,
  type ProactiveAiPreferences,
  type WorkspaceSettings,
} from "@synap/database/schema";
import { homeMoves } from "@synap-core/types/lens";
import { needsYouBuckets } from "@synap-core/types/needs-you";
import { proactivePostHeldBy } from "@synap/jobs/utils/proactive-post.js";
import type { Context } from "../../context.js";
import {
  NotificationService,
  localHourMinute,
  type CreateNotificationInput,
} from "../../notifications/NotificationService.js";
import { CRITERIA_UNMET_NOTIFICATION_TYPE } from "../../notifications/session-criteria-unmet-reactor.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";

const logger = createLogger({ module: "morning-brief" });

/** The registry type — lowercase `notificationType` so the producer scan sees it. */
const notificationType = "ai.proactive.morning_briefing" as const;
export const MORNING_BRIEF_NOTIFICATION_TYPE = notificationType;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A person is due for this long after their time (four 15-minute ticks). */
export const MORNING_BRIEF_DUE_WINDOW_MINUTES = 60;
/** A brief raised this recently means today's is sent. */
export const MORNING_BRIEF_ONCE_WITHIN_MS = 20 * HOUR_MS;
/** "In the last day" for the closed sessions. */
export const MORNING_BRIEF_LOOKBACK_MS = 24 * HOUR_MS;
/** A named item longer than this is cut, so the brief stays a few lines. */
const ITEM_MAX = 60;

// ── Pure: what the brief says ───────────────────────────────────────────────

export interface MorningBriefFacts {
  /** THE needs-you number; `floor` when a half of its read hit a cap. */
  needsYou: { count: number; floor: boolean; next: string[] };
  /** Sessions whose next move is the person's close (`ready_to_close`). */
  readyToClose: number;
  /** Sessions closed in the last day with required criteria unmet. */
  closedUnmet: number;
  /** Sessions closed in the last day that declared no criteria. */
  closedWithoutCriteria: number;
}

function clip(text: string): string {
  const t = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:]+$/, "");
  return t.length > ITEM_MAX ? `${t.slice(0, ITEM_MAX - 1).trimEnd()}…` : t;
}

function sessions(n: number): string {
  return n === 1 ? "1 session" : `${n} sessions`;
}

/** The brief, in plain words; `null` when there is nothing to say. */
export function composeMorningBrief(
  f: MorningBriefFacts
): { title: string; body: string } | null {
  const lines: string[] = [];
  if (f.needsYou.count > 0) {
    const head =
      f.needsYou.count === 1 && !f.needsYou.floor
        ? "1 thing waits on you"
        : `${f.needsYou.count}${f.needsYou.floor ? "+" : ""} things wait on you`;
    const named = f.needsYou.next.map(clip).filter(Boolean);
    lines.push(named.length > 0 ? `${head}: ${named.join("; ")}.` : `${head}.`);
  }
  if (f.readyToClose > 0) {
    lines.push(
      f.readyToClose === 1
        ? "1 session is ready for you to close."
        : `${f.readyToClose} sessions are ready for you to close.`
    );
  }
  const closed: string[] = [];
  if (f.closedUnmet > 0) {
    closed.push(
      `${sessions(f.closedUnmet)} closed with required criteria not met`
    );
  }
  if (f.closedWithoutCriteria > 0) {
    closed.push(`${sessions(f.closedWithoutCriteria)} closed with no criteria`);
  }
  if (closed.length > 0)
    lines.push(`In the last day, ${closed.join(" and ")}.`);
  if (lines.length === 0) return null;
  return { title: "Your morning brief", body: lines.join("\n") };
}

// ── Pure: when the brief is due ─────────────────────────────────────────────

export interface MorningBriefSchedule {
  prefs: ProactiveAiPreferences;
  hour: number;
  minute: number;
  timeZone: string;
}

/**
 * The person's brief settings from their first space's stored settings. A
 * space that never stored them reads the defaults (`proactive/index.ts`),
 * except the timezone: the default "UTC" is nobody's morning, so the person's
 * own timezone stands in until they pick one.
 */
export function morningBriefSchedule(
  settings: WorkspaceSettings | null | undefined,
  personTimeZone: string | null | undefined
): MorningBriefSchedule {
  const defaults = getDefaultProactiveAiPreferences();
  const stored = settings?.proactiveAi;
  const prefs: ProactiveAiPreferences = {
    ...defaults,
    ...stored,
    morningBriefing: {
      ...defaults.morningBriefing,
      ...stored?.morningBriefing,
    },
  };
  return {
    prefs,
    hour: prefs.morningBriefing.cronHour,
    minute: prefs.morningBriefing.cronMinute,
    timeZone:
      stored?.morningBriefing?.timezone ||
      personTimeZone ||
      defaults.morningBriefing.timezone,
  };
}

/** Is `now` within the hour after the person's brief time, on their clock? */
export function morningBriefDue(
  now: Date,
  at: Pick<MorningBriefSchedule, "hour" | "minute" | "timeZone">
): boolean {
  const [h, m] = localHourMinute(now, at.timeZone).split(":").map(Number);
  const since =
    (((h! * 60 + m! - (at.hour * 60 + at.minute)) % 1440) + 1440) % 1440;
  return since < MORNING_BRIEF_DUE_WINDOW_MINUTES;
}

// ── Reads ───────────────────────────────────────────────────────────────────

type Database = typeof defaultDb;

export type NeedsYouForBrief = Pick<
  MorningBriefFacts,
  "needsYou" | "readyToClose"
>;

/**
 * THE needs-you read, as the person's own Home reads it (a person context:
 * no agent, not the hub door, so the session roster counts as on Home).
 */
export async function readNeedsYouForBrief(
  userId: string
): Promise<NeedsYouForBrief> {
  const { signalsRouter } = await import("../../routers/signals.js");
  const caller = signalsRouter.createCaller({
    db: defaultDb,
    authenticated: true,
    userId,
    workspaceId: null,
    agentUserId: null,
    isHubProtocol: false,
  } as unknown as Context);
  const read = await caller.needsYou({});
  const { moves } = homeMoves(needsYouBuckets(read.rows.needs_you));
  return {
    needsYou: {
      count: read.count.needsYou,
      floor: read.count.truncated,
      next: moves.map((m) => m.signal.title),
    },
    readyToClose: read.count.review,
  };
}

/** Each person who owns an active space, with their first space's settings. */
async function briefCandidates(database: Database) {
  return database
    .selectDistinctOn([workspaces.ownerId], {
      userId: workspaces.ownerId,
      settings: workspaces.settings,
      timeZone: users.timezone,
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerId))
    .where(and(isNull(workspaces.archivedAt), eq(users.userType, "human")))
    .orderBy(workspaces.ownerId, workspaces.createdAt);
}

async function briefRaisedSince(
  database: Database,
  userId: string,
  since: Date
): Promise<boolean> {
  const [row] = await database
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, notificationType),
        gte(notifications.createdAt, since)
      )
    )
    .limit(1);
  return !!row;
}

/** The person's sessions closed since `since`: criteria unmet, and none declared. */
export async function readClosedSince(
  database: Database,
  userId: string,
  since: Date
): Promise<Pick<MorningBriefFacts, "closedUnmet" | "closedWithoutCriteria">> {
  const [[unmet], [none]] = await Promise.all([
    database
      .select({
        n: drizzleSql<number>`count(DISTINCT ${notifications.sourceId})::int`,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          eq(notifications.type, CRITERIA_UNMET_NOTIFICATION_TYPE),
          gte(notifications.createdAt, since)
        )
      ),
    database
      .select({ n: drizzleSql<number>`count(*)::int` })
      .from(focusSessions)
      .where(
        and(
          ...sessionListConditions({
            userId,
            scope: { workspaceLens: undefined, projectLens: undefined },
            // `cancelled` ends the obligation (as the criteria-unmet reactor
            // reads it): a cancelled session is not news here either.
            status: ["closed", "failed"],
            settledSince: since.toISOString(),
          }),
          drizzleSql`(CASE WHEN jsonb_typeof(${focusSessions.criteria}) = 'array'
            THEN jsonb_array_length(${focusSessions.criteria}) ELSE 0 END) = 0`
        )
      ),
  ]);
  return {
    closedUnmet: Number(unmet?.n ?? 0),
    closedWithoutCriteria: Number(none?.n ?? 0),
  };
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface MorningBriefPassResult {
  /** People who own an active space. */
  people: number;
  /** Of them, due now and not held back by their settings. */
  due: number;
  sent: number;
  /** Reads that failed; the next tick retries them. */
  failed: number;
}

type Notify = (input: CreateNotificationInput) => Promise<string | undefined>;

/** One tick of the brief (`morning-brief` queue, every 15 minutes). */
export async function runMorningBriefs(args?: {
  database?: Database;
  now?: Date;
  notify?: Notify;
  readNeedsYou?: (userId: string) => Promise<NeedsYouForBrief>;
}): Promise<MorningBriefPassResult> {
  const database = args?.database ?? defaultDb;
  const now = args?.now ?? new Date();
  const notify: Notify =
    args?.notify ?? ((input) => NotificationService.create(input));
  const readNeedsYou = args?.readNeedsYou ?? readNeedsYouForBrief;

  const candidates = await briefCandidates(database);
  const result: MorningBriefPassResult = {
    people: candidates.length,
    due: 0,
    sent: 0,
    failed: 0,
  };
  for (const c of candidates) {
    const schedule = morningBriefSchedule(c.settings, c.timeZone);
    if (proactivePostHeldBy(schedule.prefs, now)) continue;
    if (!schedule.prefs.morningBriefing.enabled) continue;
    if (!morningBriefDue(now, schedule)) continue;
    result.due++;
    try {
      const since = new Date(now.getTime() - MORNING_BRIEF_ONCE_WITHIN_MS);
      if (await briefRaisedSince(database, c.userId, since)) continue;
      const [needs, closed] = await Promise.all([
        readNeedsYou(c.userId),
        readClosedSince(
          database,
          c.userId,
          new Date(now.getTime() - MORNING_BRIEF_LOOKBACK_MS)
        ),
      ]);
      const brief = composeMorningBrief({ ...needs, ...closed });
      if (!brief) continue;
      const id = await notify({
        type: notificationType,
        userId: c.userId,
        // Pod-wide: the brief counts every space, so no space's rules own it.
        workspaceId: null,
        sourceType: "proactive_message",
        data: { ...brief, proactiveType: "morning_briefing" },
      });
      if (id) result.sent++;
    } catch (err) {
      result.failed++;
      logger.warn(
        { err, userId: c.userId },
        "morning brief: a read failed — skipped, the next tick retries"
      );
    }
  }
  logger.info(result, "morning brief pass");
  return result;
}
