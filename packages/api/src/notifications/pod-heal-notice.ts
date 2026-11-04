/**
 * Tell the pod owner when the host's self-heal restarted a service, or gave up
 * on one (plan "Pod resilience" G7b).
 *
 * `synap heal` (synap-heal.timer, every 2 min) restarts a container Docker
 * marks unhealthy, within a budget, and records each act as a `pod.heal` line
 * in deploy/state/events.jsonl, with WHY (`why`: stuck / dead / unhealthy, the
 * last stall's request). Until now nothing read that file: on 2026-11-03 the
 * backend was restarted for ~1.5 h and nobody was told. The backend reads it
 * through its read-only deploy mount (`apps/api/src/status/heal-events.ts`,
 * the reader; the same mount `pod-update-outcome.ts` reads last-update.json
 * from), and this module decides who hears what.
 *
 * ONE door: `NotificationService.create`, to the pod owner + admins
 * (`resolvePodAdminUserIds`), pod-wide, `sourceType: "system"` — exactly the
 * U4 audience and shape. Two types, like U4's pair: a restart is NEWS
 * (`pod.service_restarted`: informational, expires); a spent budget is an ASK
 * (`pod.service_heal_exhausted`: the service is still down and only a person
 * on the host can act).
 *
 * ONCE: (1) a durable watermark, `pod_settings.settings.podHealNoticeWatermark`
 * = the newest event `ts` already handled, so a re-read never repeats; with no
 * watermark yet, only events of the last `HEAL_NOTICE_LOOKBACK_MS` count;
 * (2) at most one notice per service per type per read (the newest event
 * wins: three restarts read together are one notice); (3) the registry's
 * `dedupeWindowMs` per `groupKey` `pod-heal:<service>`, so a restart every
 * 2 minutes is not a notice every 5.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, podSettings, drizzleSql } from "@synap/database";
import { NotificationService } from "./NotificationService.js";
import { resolvePodAdminUserIds } from "../services/capabilities/pod-owner.js";

const logger = createLogger({ module: "pod-heal-notice" });

/** Spelled as `type:` so the producer tripwire sees this file produce them. */
const restarted = { type: "pod.service_restarted" } as const;
const exhausted = { type: "pod.service_heal_exhausted" } as const;
export const POD_SERVICE_RESTARTED_NOTIFICATION_TYPE = restarted.type;
export const POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE = exhausted.type;

/** Without a watermark, how far back an event still counts as news. */
export const HEAL_NOTICE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

export const POD_HEAL_WATERMARK_SETTING = "podHealNoticeWatermark" as const;

/** One `pod.heal` line, projected to what this module reads (the reader's output). */
export interface PodHealEvent {
  ts: string;
  status: string;
  service: string;
  restartsInWindow: number | null;
  /** stuck | dead | unhealthy, or null when the line predates `why`. */
  class: string | null;
  waitedTicks: number | null;
  /** The last stall the backend logged before the act, when heal found one. */
  stall: {
    blockedMs: number;
    method: string | null;
    path: string | null;
  } | null;
}

/** The heal window `synap heal` counts restarts in (SYNAP_HEAL_WINDOW_MIN). */
const HEAL_WINDOW_MIN = 30;

function stallSentence(e: PodHealEvent): string {
  if (!e.stall) return "";
  const s = Math.max(1, Math.round(e.stall.blockedMs / 1000));
  const during =
    e.stall.method && e.stall.path
      ? `, during ${e.stall.method} ${e.stall.path}`
      : "";
  return ` Its last stall blocked it for ${s} s${during}.`;
}

/** The type + copy for one event. Pure. Null ⇒ this event tells nobody. */
export function describePodHealEvent(
  e: PodHealEvent
): { type: string; detail: string } | null {
  if (e.status === "restarted") {
    let why: string;
    if (e.class === "stuck") {
      const waited =
        e.waitedTicks && e.waitedTicks > 0
          ? ` The pod waited ${e.waitedTicks} more check${e.waitedTicks === 1 ? "" : "s"} first, in case it recovered on its own.`
          : "";
      why = `It was running but had stopped answering in time.${waited}`;
    } else if (e.class === "dead") {
      why = "It had stopped answering: nothing was listening.";
    } else {
      why = "Docker reported it unhealthy.";
    }
    return {
      type: POD_SERVICE_RESTARTED_NOTIFICATION_TYPE,
      detail: `${why}${stallSentence(e)} If it happens again, run \`synap doctor\` on the pod host.`,
    };
  }
  if (e.status === "budget_exhausted") {
    const n = e.restartsInWindow ?? 0;
    return {
      type: POD_SERVICE_HEAL_EXHAUSTED_NOTIFICATION_TYPE,
      detail: `The pod restarted it ${n} time${n === 1 ? "" : "s"} in ${HEAL_WINDOW_MIN} minutes and it is still unhealthy, so it stopped restarting it.${stallSentence(e)} Run \`synap doctor\` on the pod host.`,
    };
  }
  return null;
}

/**
 * Which events of a read tell someone: newer than the watermark (or, with
 * none, inside the lookback), one per (service, type) — the newest. Pure.
 */
export function selectPodHealNotices(
  events: readonly PodHealEvent[],
  watermark: string | null,
  now: Date
): Array<{ event: PodHealEvent; type: string; detail: string }> {
  const floor = new Date(now.getTime() - HEAL_NOTICE_LOOKBACK_MS).toISOString();
  const newest = new Map<
    string,
    { event: PodHealEvent; type: string; detail: string }
  >();
  for (const event of events) {
    if (watermark !== null && event.ts <= watermark) continue;
    if (event.ts < floor) continue;
    const copy = describePodHealEvent(event);
    if (!copy) continue;
    const key = `${event.service}|${copy.type}`;
    const prev = newest.get(key);
    if (!prev || prev.event.ts <= event.ts) newest.set(key, { event, ...copy });
  }
  return [...newest.values()];
}

export interface PodHealNoticeDeps {
  recipients(): Promise<string[]>;
  /** null = never written (not a failed read: a failed read throws). */
  readWatermark(): Promise<string | null>;
  writeWatermark(ts: string): Promise<void>;
  create(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<string | undefined>;
  now(): Date;
}

const defaultDeps: PodHealNoticeDeps = {
  recipients: resolvePodAdminUserIds,
  readWatermark: async () => {
    const [row] = await db
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    const v = (row?.settings as Record<string, unknown> | null | undefined)?.[
      POD_HEAL_WATERMARK_SETTING
    ];
    return typeof v === "string" ? v : null;
  },
  writeWatermark: async (ts) => {
    const value = JSON.stringify(ts);
    const [existing] = await db
      .select({ id: podSettings.id })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    if (existing) {
      await db
        .update(podSettings)
        .set({
          settings: drizzleSql`jsonb_set(
            coalesce(${podSettings.settings}, '{}'::jsonb),
            '{podHealNoticeWatermark}',
            ${value}::jsonb,
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(podSettings.id, existing.id));
    } else {
      await db
        .insert(podSettings)
        .values({ settings: { [POD_HEAL_WATERMARK_SETTING]: ts } });
    }
  },
  create: (input) => NotificationService.create(input),
  now: () => new Date(),
};

/**
 * Notify about the heal events of one read. Returns how many notifications
 * were created. Never throws. The watermark moves to the newest event read
 * only when every send went through, so a failed send is retried on the next
 * read (the dedupe window keeps a retried one from doubling).
 */
export async function notifyPodHealEvents(
  events: readonly PodHealEvent[],
  deps: PodHealNoticeDeps = defaultDeps
): Promise<number> {
  if (events.length === 0) return 0;
  let sent = 0;
  try {
    const watermark = await deps.readWatermark();
    const notices = selectPodHealNotices(events, watermark, deps.now());
    let allSent = true;
    if (notices.length > 0) {
      const recipients = await deps.recipients();
      for (const { event, type, detail } of notices) {
        for (const userId of recipients) {
          try {
            const id = await deps.create({
              type,
              userId,
              workspaceId: null,
              sourceType: "system",
              sourceId: `pod-heal:${event.service}:${event.ts}`,
              groupKey: `pod-heal:${event.service}`,
              data: {
                service: event.service,
                detail,
                status: event.status,
                class: event.class,
                at: event.ts,
              },
            });
            if (id) sent++;
          } catch (err) {
            allSent = false;
            logger.warn(
              { err, service: event.service, status: event.status },
              "Pod heal notification failed (retried on the next read)"
            );
          }
        }
      }
    }
    const newest = events.reduce(
      (max, e) => (e.ts > max ? e.ts : max),
      watermark ?? ""
    );
    if (allSent && newest && newest !== watermark) {
      await deps.writeWatermark(newest);
    }
    return sent;
  } catch (err) {
    logger.warn({ err }, "Pod heal notices failed (non-fatal)");
    return sent;
  }
}
