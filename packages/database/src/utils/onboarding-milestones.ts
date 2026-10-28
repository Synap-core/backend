/**
 * Onboarding milestones — the pod-side reads and the one switch (onboarding
 * plan v1 §5, slice A9).
 *
 * Milestones are DERIVED, never stored as their own records: each one's time
 * comes from a fact the pod already keeps (the start journey's values, the
 * setup proposal row, the proposals of the agents the owner operates). So a
 * milestone id always resolves to the same timestamp, and the CP can store it
 * idempotently per (pod, id). `@synap/jobs` `onboarding-milestones` turns these
 * facts into the payload and sends it.
 *
 * The switch (founder OQ3, 2026-10-28): ON by default, disclosed, turned off
 * in pod-admin Settings › Privacy. Stored on the singleton
 * `pod_settings.settings.onboardingMilestones`; absent = ON. Written only by a
 * signed-in pod admin through `onboardingMilestones.set`.
 *
 * Every reader THROWS on a failed read: "could not read" is never "no journey"
 * or "switched off".
 */

import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql as drizzleSql,
} from "drizzle-orm";

import { db } from "../index.js";
import { apiKeys } from "../schema/api-keys.js";
import { onboardingJourneys } from "../schema/onboarding-journeys.js";
import {
  podSettings,
  type OnboardingMilestonesSetting,
  type OnboardingMilestonesSync,
} from "../schema/pod-settings.js";
import { ProposalStatus, proposals } from "../schema/proposals.js";
import { workspaces } from "../schema/workspaces.js";

const DAY_MS = 86_400_000;

// ── The switch ─────────────────────────────────────────────────────────────

export interface OnboardingMilestonesSharing {
  enabled: boolean;
  /** Who last changed it, and when; null while it is the default. */
  changedBy: string | null;
  changedAt: string | null;
}

async function readPodSettingsBlob() {
  const [row] = await db
    .select({ id: podSettings.id, settings: podSettings.settings })
    .from(podSettings)
    .orderBy(asc(podSettings.createdAt))
    .limit(1);
  return row ?? null;
}

/** Merge ONE top-level key into the singleton row, creating the row if absent. */
async function writePodSettingsKey(key: string, value: unknown): Promise<void> {
  const row = await readPodSettingsBlob();
  if (!row) {
    await db.insert(podSettings).values({ settings: { [key]: value } });
    return;
  }
  await db
    .update(podSettings)
    .set({
      settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(podSettings.id, row.id));
}

export async function readOnboardingMilestonesSharing(): Promise<OnboardingMilestonesSharing> {
  const stored = (await readPodSettingsBlob())?.settings?.onboardingMilestones;
  return {
    enabled: stored?.enabled !== false,
    changedBy: stored?.changedBy ?? null,
    changedAt: stored?.changedAt ?? null,
  };
}

/** Set the switch. The caller has checked the pod admin; this only stores. */
export async function setOnboardingMilestonesSharing(input: {
  enabled: boolean;
  changedBy: string;
}): Promise<OnboardingMilestonesSharing> {
  await writePodSettingsKey("onboardingMilestones", {
    enabled: input.enabled,
    changedBy: input.changedBy,
    changedAt: new Date().toISOString(),
  } satisfies OnboardingMilestonesSetting);
  return readOnboardingMilestonesSharing();
}

/** What was last delivered (the digest of the payload the CP accepted). */
export async function readOnboardingMilestonesSync(): Promise<OnboardingMilestonesSync | null> {
  return (
    (await readPodSettingsBlob())?.settings?.onboardingMilestonesSync ?? null
  );
}

export async function recordOnboardingMilestonesSent(
  digest: string,
  now: Date = new Date()
): Promise<void> {
  await writePodSettingsKey("onboardingMilestonesSync", {
    digest,
    sentAt: now.toISOString(),
  } satisfies OnboardingMilestonesSync);
}

// ── The facts ──────────────────────────────────────────────────────────────

export interface OnboardingMilestoneFacts {
  journey: {
    userId: string;
    status: string;
    offeredAt: Date;
    completedAt: Date | null;
    /** `progress.values.start` as stored: the job reads only what it allows. */
    start: Record<string, unknown>;
  };
  /** The row `start.setup.proposalId` names, or null (none filed, or gone). */
  setupProposal: {
    status: string;
    createdAt: Date;
    reviewedAt: Date | null;
    /** When every space the approval created is archived: the last archive. */
    undoneAt: Date | null;
  } | null;
  /** The first proposal filed by an agent the owner operates, and the first approved. */
  firstAgentProposalAt: Date | null;
  firstAgentApprovalAt: Date | null;
  /** First owner review or operated-agent proposal on days 7-13 after `offeredAt`. */
  week2ActivityAt: Date | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const minDate = (...ds: Array<Date | null | undefined>): Date | null =>
  ds.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);

/**
 * The start journey: the pod-lens row that carries `values.start`, the
 * earliest offered. Only a pod admin can write `values.start`
 * (`onboarding.recordStartStep`), and v1 onboards the owner only (OQ5), so this
 * is the owner's start. Null when no start journey exists.
 */
export async function readOnboardingMilestoneFacts(): Promise<OnboardingMilestoneFacts | null> {
  const [row] = await db
    .select({
      userId: onboardingJourneys.userId,
      status: onboardingJourneys.status,
      offeredAt: onboardingJourneys.offeredAt,
      completedAt: onboardingJourneys.completedAt,
      start: drizzleSql<unknown>`${onboardingJourneys.progress} -> 'values' -> 'start'`,
    })
    .from(onboardingJourneys)
    .where(
      and(
        eq(onboardingJourneys.lensKind, "pod"),
        drizzleSql`jsonb_typeof(${onboardingJourneys.progress} -> 'values' -> 'start') = 'object'`
      )
    )
    .orderBy(asc(onboardingJourneys.offeredAt))
    .limit(1);
  if (!row || !isRecord(row.start)) return null;
  const start = row.start;

  // The setup proposal and, once approved, whether its spaces were undone.
  let setupProposal: OnboardingMilestoneFacts["setupProposal"] = null;
  const setup = isRecord(start.setup) ? start.setup : null;
  if (typeof setup?.proposalId === "string") {
    const [p] = await db
      .select({
        status: proposals.status,
        createdAt: proposals.createdAt,
        reviewedAt: proposals.reviewedAt,
        data: proposals.data,
      })
      .from(proposals)
      .where(eq(proposals.id, setup.proposalId))
      .limit(1);
    if (p) {
      const data = isRecord(p.data) ? p.data : {};
      const created = Array.isArray(data.createdWorkspaceIds)
        ? data.createdWorkspaceIds.filter(
            (id): id is string => typeof id === "string"
          )
        : typeof data.materializedWorkspaceId === "string"
          ? [data.materializedWorkspaceId]
          : [];
      let undoneAt: Date | null = null;
      if (p.status === ProposalStatus.APPROVED && created.length > 0) {
        const spaces = await db
          .select({ archivedAt: workspaces.archivedAt })
          .from(workspaces)
          .where(inArray(workspaces.id, created));
        if (
          spaces.length === created.length &&
          spaces.every((s) => s.archivedAt)
        ) {
          undoneAt = spaces.reduce<Date | null>(
            (max, s) => (!max || s.archivedAt! > max ? s.archivedAt : max),
            null
          );
        }
      }
      setupProposal = {
        status: p.status,
        createdAt: p.createdAt,
        reviewedAt: p.reviewedAt,
        undoneAt,
      };
    }
  }

  // The agents the owner operates: an unrevoked hub key acting as them (the
  // same set `startState` reads for the first-work step), plus the agent the
  // start recorded.
  const keys = await db
    .selectDistinct({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.linkedUserId, row.userId),
        isNull(apiKeys.revokedAt)
      )
    );
  const agent = isRecord(start.agent) ? start.agent : null;
  const agentIds = [
    ...new Set([
      ...keys.map((k) => k.userId),
      ...(typeof agent?.agentUserId === "string" ? [agent.agentUserId] : []),
    ]),
  ];

  let firstAgentProposalAt: Date | null = null;
  let firstAgentApprovalAt: Date | null = null;
  let agentWeek2At: Date | null = null;
  const week2From = new Date(row.offeredAt.getTime() + 7 * DAY_MS);
  const week2To = new Date(row.offeredAt.getTime() + 14 * DAY_MS);
  if (agentIds.length > 0) {
    const [first] = await db
      .select({ at: drizzleSql<Date | null>`min(${proposals.createdAt})` })
      .from(proposals)
      .where(inArray(proposals.agentUserId, agentIds));
    const [approved] = await db
      .select({ at: drizzleSql<Date | null>`min(${proposals.reviewedAt})` })
      .from(proposals)
      .where(
        and(
          inArray(proposals.agentUserId, agentIds),
          eq(proposals.status, ProposalStatus.APPROVED),
          isNotNull(proposals.reviewedAt)
        )
      );
    const [week2] = await db
      .select({ at: drizzleSql<Date | null>`min(${proposals.createdAt})` })
      .from(proposals)
      .where(
        and(
          inArray(proposals.agentUserId, agentIds),
          gte(proposals.createdAt, week2From),
          lt(proposals.createdAt, week2To)
        )
      );
    firstAgentProposalAt = toDate(first?.at);
    firstAgentApprovalAt = toDate(approved?.at);
    agentWeek2At = toDate(week2?.at);
  }
  const [ownerWeek2] = await db
    .select({ at: drizzleSql<Date | null>`min(${proposals.reviewedAt})` })
    .from(proposals)
    .where(
      and(
        eq(proposals.reviewedBy, row.userId),
        gte(proposals.reviewedAt, week2From),
        lt(proposals.reviewedAt, week2To)
      )
    );

  return {
    journey: {
      userId: row.userId,
      status: row.status,
      offeredAt: row.offeredAt,
      completedAt: row.completedAt,
      start,
    },
    setupProposal,
    firstAgentProposalAt,
    firstAgentApprovalAt,
    week2ActivityAt: minDate(agentWeek2At, toDate(ownerWeek2?.at)),
  };
}

/** `min()` over a timestamptz comes back as a string through the raw driver. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
