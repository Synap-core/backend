/**
 * U4 — tell the pod owner when an update did not land.
 *
 * The host-side engine (`synap update`) records every outcome in
 * deploy/state/last-update.json, which the backend reads through its read-only
 * deploy mount (`apps/api/src/pod-updates`). A rollback RECREATES the backend,
 * so the boot that follows is the natural moment to read it: apps/api calls
 * this once per boot with the projected outcome.
 *
 * ONE door: `NotificationService.create` (preferences, routing, the bell), to
 * the pod owner + admins (`resolvePodAdminUserIds`) — the same audience as a
 * pod-wide proposal. Pod-wide (`workspaceId: null`), `sourceType: "system"`.
 *
 * IDEMPOTENT per update id and recipient: `(sourceType='system',
 * sourceId='pod-update:<updateId>', type, userId)` is durable state, so every
 * later boot that re-reads the same file is a no-op, and an admin added later
 * still gets told. The Control Plane emails the same outcome separately (it
 * dedupes on its own `pod_updates` row) — the two channels are independent on
 * purpose: a self-hosted pod has no CP, and a CP email must not depend on the
 * pod being healthy enough to boot.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  inArray,
  notifications,
  podSettings,
  drizzleSql,
} from "@synap/database";
import { NotificationService } from "./NotificationService.js";
import { resolvePodAdminUserIds } from "../services/capabilities/pod-owner.js";

const logger = createLogger({ module: "pod-update-outcome" });

const notificationType = "pod.update_failed";
export const POD_UPDATE_FAILED_NOTIFICATION_TYPE = notificationType;
/**
 * The failed ROLLBACK: an ask (needs-you, never expires), not news. Spelled
 * as `type:` so the producer tripwire (`notification-producer-allowlist`)
 * sees this file produce it.
 */
const rollbackFailed = { type: "pod.update_rollback_failed" } as const;
export const POD_UPDATE_ROLLBACK_FAILED_NOTIFICATION_TYPE = rollbackFailed.type;

/** Which notice an outcome is: a failed rollback asks; the rest is news. */
export function podUpdateOutcomeNotificationType(status: string): string {
  return status === "rollback_failed"
    ? POD_UPDATE_ROLLBACK_FAILED_NOTIFICATION_TYPE
    : POD_UPDATE_FAILED_NOTIFICATION_TYPE;
}

export interface PodUpdateOutcomeInput {
  updateId: string;
  status: string;
  from: string | null;
  to: string | null;
  reason: string | null;
  dbRestored: boolean;
}

const NOTIFY = new Set(["rolled_back", "rollback_failed", "failed"]);

/**
 * A version as a person reads it. A release (`v1.4.0`, `1.4.0`) is its own
 * name; a build the host made from a checkout is tagged `local-<git sha>`
 * (`local-b88d021b7d74`), which means nothing in a sentence — it is "a local
 * build". Absent ⇒ `fallback`.
 */
export function humanizePodVersion(
  version: string | null | undefined,
  fallback: string
): string {
  const v = version?.trim();
  if (!v) return fallback;
  if (/^local-[0-9a-f]{7,}$/i.test(v)) return "a local build";
  return v;
}

/** The headline + detail copy for one outcome. Pure. Null ⇒ no notification. */
export function describePodUpdateOutcome(
  o: PodUpdateOutcomeInput
): { headline: string; detail: string } | null {
  if (!NOTIFY.has(o.status)) return null;
  const why = o.reason ? ` (${o.reason})` : "";
  const previous = humanizePodVersion(o.from, "the previous version");
  if (o.status === "rolled_back") {
    return {
      headline: "was rolled back",
      detail: `The update failed${why}. Your pod is running ${previous} again${
        o.dbRestored
          ? ", with its data restored from the pre-update backup"
          : ""
      }.`,
    };
  }
  if (o.status === "rollback_failed") {
    return {
      headline: "failed and needs attention",
      detail: `The update failed${why} and the automatic rollback did not complete. Run \`synap doctor\` on the pod host.`,
    };
  }
  // `failed` is written only by the pod's systemd unit (deploy/request-
  // outcome.sh, "by":"unit"): the engine stopped before it recorded an
  // outcome, after it may have changed the pod — never "still on <from>".
  return {
    headline: "failed",
    detail: `The update failed${why}. Your pod is still on ${previous}.`,
  };
}

export interface PodUpdateOutcomeDeps {
  recipients(): Promise<string[]>;
  alreadyNotified(sourceId: string): Promise<Set<string>>;
  /** Record who has been told about `sourceId` — durably, beside the bell. */
  markNotified(sourceId: string, userIds: readonly string[]): Promise<void>;
  create(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<string | undefined>;
}

/**
 * WHO HAS BEEN TOLD, durably: `pod_settings.settings.podUpdateOutcomeNotified`
 * = `{ sourceId, userIds }` for the outcome on disk (the engine keeps ONE
 * outcome, so one record — a new update id replaces it).
 *
 * The bell row cannot be this record. The notice expires
 * (`expiresAfterMs`) and the daily `notification-cleanup` worker DELETES
 * expired read/dismissed rows — and a person can delete a notification. With
 * the row as the only record, the next boot re-read the unchanged
 * `last-update.json`, found no row and told everyone again, every week. The
 * rows are still read (a pod that notified before this record existed), and
 * the record is backfilled from them.
 */
export const POD_UPDATE_NOTIFIED_SETTING = "podUpdateOutcomeNotified" as const;

interface PodUpdateNotifiedRecord {
  sourceId: string;
  userIds: string[];
}

function readNotifiedRecord(
  settings: Record<string, unknown> | null | undefined
): PodUpdateNotifiedRecord | null {
  const raw = settings?.[POD_UPDATE_NOTIFIED_SETTING] as
    Partial<PodUpdateNotifiedRecord> | undefined;
  if (!raw || typeof raw.sourceId !== "string") return null;
  const userIds = Array.isArray(raw.userIds)
    ? raw.userIds.filter((u): u is string => typeof u === "string")
    : [];
  return { sourceId: raw.sourceId, userIds };
}

const defaultDeps: PodUpdateOutcomeDeps = {
  recipients: resolvePodAdminUserIds,
  alreadyNotified: async (sourceId) => {
    const [settingsRow, rows] = await Promise.all([
      db
        .select({ settings: podSettings.settings })
        .from(podSettings)
        .orderBy(podSettings.createdAt)
        .limit(1),
      db.query.notifications.findMany({
        where: and(
          eq(notifications.sourceType, "system"),
          eq(notifications.sourceId, sourceId),
          inArray(notifications.type, [
            POD_UPDATE_FAILED_NOTIFICATION_TYPE,
            POD_UPDATE_ROLLBACK_FAILED_NOTIFICATION_TYPE,
          ])
        ),
        columns: { userId: true },
      }),
    ]);
    const record = readNotifiedRecord(settingsRow[0]?.settings);
    return new Set([
      ...(record?.sourceId === sourceId ? record.userIds : []),
      ...rows.map((r) => r.userId),
    ]);
  },
  markNotified: async (sourceId, userIds) => {
    const record = JSON.stringify({ sourceId, userIds: [...userIds] });
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
            '{podUpdateOutcomeNotified}',
            ${record}::jsonb,
            true
          )`,
          updatedAt: new Date(),
        })
        .where(eq(podSettings.id, existing.id));
    } else {
      await db.insert(podSettings).values({
        settings: { [POD_UPDATE_NOTIFIED_SETTING]: JSON.parse(record) },
      });
    }
  },
  create: (input) => NotificationService.create(input),
};

/** Returns how many recipients were newly notified. Never throws. */
export async function notifyPodUpdateOutcome(
  outcome: PodUpdateOutcomeInput,
  deps: PodUpdateOutcomeDeps = defaultDeps
): Promise<number> {
  const copy = describePodUpdateOutcome(outcome);
  if (!copy) return 0;
  const sourceId = `pod-update:${outcome.updateId}`;
  try {
    const recipients = await deps.recipients();
    if (recipients.length === 0) return 0;
    const already = await deps.alreadyNotified(sourceId);
    const told = new Set(already);
    let sent = 0;
    for (const userId of recipients) {
      if (already.has(userId)) continue;
      const id = await deps.create({
        type: podUpdateOutcomeNotificationType(outcome.status),
        userId,
        workspaceId: null,
        sourceType: "system",
        sourceId,
        data: {
          version: humanizePodVersion(outcome.to, "the new release"),
          headline: copy.headline,
          detail: copy.detail,
          status: outcome.status,
        },
      });
      if (id) {
        sent++;
        told.add(userId);
      }
    }
    // One idempotent write per boot: it also backfills a pod that notified
    // before the record existed (its rows are the only trace). A failed
    // write is logged, never a reason to report the sends as failed.
    if (told.size > 0) {
      await deps
        .markNotified(sourceId, [...told].sort())
        .catch((err) =>
          logger.warn(
            { err, updateId: outcome.updateId },
            "Could not record who was told about the update outcome"
          )
        );
    }
    return sent;
  } catch (err) {
    logger.warn(
      { err, updateId: outcome.updateId, status: outcome.status },
      "Pod update outcome notification failed (non-fatal)"
    );
    return 0;
  }
}
