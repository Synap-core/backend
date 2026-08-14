/**
 * Governance TIGHTEN-POSTURE recommender — the channel-scoped twin of the
 * `governance.tighten_lane` recommender (`recommend-tighten.ts`).
 *
 * Where tighten_lane watches ONE AGENT's rejected write-motifs and proposes
 * pinning that motif to review, this recommender watches a CHANNEL's rejected
 * agent writes — across ALL agents — and, when a channel keeps producing writes
 * the humans reject, proposes TIGHTENING that channel's POSTURE (a
 * `config_settings` guideline with `posture:'propose'`, read at rung 2.55 by
 * `resolveMostSpecificPosture` → `resolveOriginTrust`). The signal is the SAME
 * reject-rate math as tighten_lane; the one structural divergence is the key:
 * posture is a channel property, agent-independent, so this scans pod-wide and
 * GROUPS BY CHANNEL, not by (agent, motif).
 *
 * NEVER silent + never a direct guideline write: like tighten/widen, the ONLY
 * side effect is a PENDING proposal via the one door `insertPendingProposal`,
 * plus its pod-wide notification. Approving it creates the guideline — see the
 * approve-branch (B4c) in `apply-approval.ts`.
 *
 * REUSE from recommend-tighten.ts (verbatim math, so the two lanes agree):
 *   - the DECIDED denominator set (APPROVED / AUTO_APPROVED / REJECTED only —
 *     PENDING/expired never dilute a "how reliably do humans reject this" rate).
 *   - the mute set (`proposal_cluster_mutes`) excluded from BOTH numerator and
 *     denominator, keyed on the structural fingerprint.
 *   - the floors MIN_CLUSTER_SIZE=5, MIN_REJECT_RATE=0.9.
 *
 * The channel per row comes from the SAME provenance rung 2.55 uses:
 * `proposals.sourceMessageId → messages.channelId` (an inner join drops rows with
 * no source message — a channel can't be assigned, so they're not signal). The
 * channel's `workspaceId` (for the approval scope rule) is resolved once per
 * qualifying channel from `channels`.
 */

import {
  db,
  and,
  eq,
  desc,
  isNull,
  isNotNull,
  inArray,
  proposals,
  messages,
  channels,
  configSettings,
  proposalClusterMutes,
  GUIDELINE_KEY,
  type GuidelineValue,
  insertPendingProposal,
  ProposalStatus,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { computeProposalFingerprint } from "./fingerprint.js";
import { notifyPodWideProposal } from "../../notifications/notify-pod-wide-proposal.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";

const logger = createLogger({ module: "governance-recommend-tighten-posture" });

/** Mirrors SCAN_LIMIT / floors in recommend-tighten.ts. */
const SCAN_LIMIT = 500;
const SAMPLE_CAP = 20;
const MIN_CLUSTER_SIZE = 5;
const MIN_REJECT_RATE = 0.9;

/**
 * `governance.tighten_posture` proposal payload. The subject CHANNEL lives in the
 * payload — this recommender authors the row (`proposals.agentUserId` is null),
 * and the write is channel-scoped, not agent-scoped. `workspaceId` is the
 * channel's own workspace (null for a pod-wide channel) — the approval scope rule
 * reads it.
 */
export interface GovernanceTightenPostureProposalData {
  channelId: string;
  workspaceId?: string | null;
  rejectRate: number;
  clusterSize: number;
  sampleProposalIds: string[];
}

interface ScanRow {
  id: string;
  proposalType: string;
  targetType: string;
  status: string;
  targetId: string;
  data: unknown;
  channelId: string;
}

/** Recent agent proposals with a resolvable channel (all statuses). */
async function loadChannelProposals(): Promise<ScanRow[]> {
  const rows = (await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      status: proposals.status,
      targetId: proposals.targetId,
      data: proposals.data,
      channelId: messages.channelId,
    })
    .from(proposals)
    .innerJoin(messages, eq(proposals.sourceMessageId, messages.id))
    .where(
      and(
        isNotNull(proposals.agentUserId),
        isNotNull(proposals.sourceMessageId)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(SCAN_LIMIT)) as ScanRow[];
  return rows;
}

/** The active mute set (`proposal_cluster_mutes`) — reused verbatim from tighten. */
async function loadActiveMutedFingerprints(): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ fingerprint: proposalClusterMutes.fingerprint })
    .from(proposalClusterMutes)
    .where(isNull(proposalClusterMutes.revokedAt));
  return new Set(rows.map((r) => r.fingerprint));
}

/** Any PENDING `governance.tighten_posture` already open for this channel. */
async function hasPendingPostureProposal(channelId: string): Promise<boolean> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.proposalType, "governance.tighten_posture"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows.some((r) => {
    const data = r.data as Partial<GovernanceTightenPostureProposalData> | null;
    return data?.channelId === channelId;
  });
}

/**
 * A covering channel posture=propose guideline already pins this channel to
 * review — proposing again is redundant. Mirror of tighten's
 * `hasCoveringProposeRule` (there: a covering propose RULE; here: a covering
 * propose GUIDELINE).
 */
async function hasCoveringPostureGuideline(
  channelId: string
): Promise<boolean> {
  const rows = (await db
    .select({ value: configSettings.value })
    .from(configSettings)
    .where(
      and(
        eq(configSettings.key, GUIDELINE_KEY),
        eq(configSettings.scopeKind, "channel"),
        eq(configSettings.scopeRef, channelId),
        isNull(configSettings.revokedAt)
      )
    )) as Array<{ value: GuidelineValue | Record<string, unknown> }>;
  return rows.some((r) => (r.value as GuidelineValue)?.posture === "propose");
}

/** Resolve each qualifying channel's workspaceId (null for pod-wide channels). */
async function loadChannelWorkspaces(
  channelIds: string[]
): Promise<Map<string, string | null>> {
  if (channelIds.length === 0) return new Map();
  const rows = (await db
    .select({ id: channels.id, workspaceId: channels.workspaceId })
    .from(channels)
    .where(inArray(channels.id, channelIds))) as Array<{
    id: string;
    workspaceId: string | null;
  }>;
  return new Map(rows.map((r) => [r.id, r.workspaceId]));
}

interface ChannelAcc {
  decided: number;
  rejected: number;
  sampleProposalIds: string[];
}

/**
 * Scan every channel's agent writes and file a tighten_posture proposal per
 * channel the humans reject consistently. Pod-wide (grouped by channel across all
 * agents) — the one structural divergence from tighten_lane's per-agent loop.
 */
export async function recommendTightenPostureForAllChannels(): Promise<{
  proposalsFiled: number;
  proposalIds: string[];
}> {
  logger.info("recommend-tighten-posture: starting scan");
  const rows = await loadChannelProposals();
  if (rows.length === 0) {
    return { proposalsFiled: 0, proposalIds: [] };
  }
  const mutedFingerprints = await loadActiveMutedFingerprints();

  const isMuted = (r: ScanRow) =>
    mutedFingerprints.size > 0 &&
    mutedFingerprints.has(
      computeProposalFingerprint({
        proposalType: r.proposalType,
        targetType: r.targetType,
        targetId: r.targetId,
        data: r.data,
      })
    );

  // DECIDED-only denominator + rejected numerator, keyed by CHANNEL (mirror the
  // tighten math, one bucket per channel instead of per (agent, motif)).
  const DECIDED: ReadonlySet<string> = new Set<string>([
    ProposalStatus.APPROVED,
    ProposalStatus.AUTO_APPROVED,
    ProposalStatus.REJECTED,
  ]);
  const byChannel = new Map<string, ChannelAcc>();
  for (const r of rows) {
    if (isMuted(r)) continue;
    const acc = byChannel.get(r.channelId) ?? {
      decided: 0,
      rejected: 0,
      sampleProposalIds: [],
    };
    if (DECIDED.has(r.status)) acc.decided += 1;
    if (r.status === ProposalStatus.REJECTED) {
      acc.rejected += 1;
      if (acc.sampleProposalIds.length < SAMPLE_CAP)
        acc.sampleProposalIds.push(r.id);
    }
    byChannel.set(r.channelId, acc);
  }

  // Qualify channels against the floors, worst offenders first.
  const qualifying = Array.from(byChannel.entries())
    .filter(([, acc]) => {
      if (acc.rejected < MIN_CLUSTER_SIZE) return false;
      const denom = acc.decided > 0 ? acc.decided : acc.rejected;
      return acc.rejected / denom >= MIN_REJECT_RATE;
    })
    .sort((a, b) => b[1].rejected - a[1].rejected);
  if (qualifying.length === 0) {
    return { proposalsFiled: 0, proposalIds: [] };
  }

  const workspaces = await loadChannelWorkspaces(
    qualifying.map(([channelId]) => channelId)
  );
  // The pod owner authors these channel-scoped recommendations — there is no
  // per-channel agent to attribute them to (posture is agent-independent). Also
  // the userId the history-feed side effect needs.
  const podOwnerUserId = await resolvePodOwnerUserId();

  const proposalIds: string[] = [];
  let failed = 0;

  for (const [channelId, acc] of qualifying) {
    try {
      if (await hasPendingPostureProposal(channelId)) continue;
      if (await hasCoveringPostureGuideline(channelId)) continue;

      const denom = acc.decided > 0 ? acc.decided : acc.rejected;
      const rejectRate = Number((acc.rejected / denom).toFixed(4));
      const workspaceId = workspaces.get(channelId) ?? null;

      const data: GovernanceTightenPostureProposalData = {
        channelId,
        workspaceId,
        rejectRate,
        clusterSize: acc.rejected,
        sampleProposalIds: acc.sampleProposalIds,
      };

      // Pod-wide (`workspaceId: null`) so it fans to owner + admins; authored by
      // the pod owner (posture is agent-independent — no per-channel agent).
      const { proposal, deduped } = await insertPendingProposal({
        workspaceId: null,
        targetType: "governance",
        targetId: channelId,
        proposalType: "governance.tighten_posture",
        data: data as unknown as Record<string, unknown>,
        createdBy: podOwnerUserId,
        proposedByUserId: null,
      });

      if (!deduped) {
        void notifyPodWideProposal({
          proposalId: proposal.id,
          proposalType: "governance.tighten_posture",
          description: `Tighten posture for a channel (rejected ${acc.rejected}× — ${Math.round(
            rejectRate * 100
          )}%)`,
        });
      }

      if (podOwnerUserId) {
        void emitSideEffects({
          subjectType: "proposal",
          action: "created",
          subjectId: proposal.id,
          userId: podOwnerUserId,
          data: {
            proposalStatus: "created",
            targetType: "governance",
            changeType: "governance.tighten_posture",
          },
        }).catch((err) => {
          logger.warn(
            { err, proposalId: proposal.id, channelId },
            "recommend-tighten-posture: emitSideEffects failed (non-fatal)"
          );
        });
      }

      proposalIds.push(proposal.id);
      logger.info(
        { channelId, rejectRate, clusterSize: acc.rejected },
        "recommend-tighten-posture: filed tighten_posture proposal"
      );
    } catch (err) {
      failed += 1;
      logger.error(
        { err, channelId },
        "recommend-tighten-posture: failed for channel, skipping"
      );
    }
  }

  logger.info(
    {
      channelsScanned: byChannel.size,
      qualifying: qualifying.length,
      failed,
      mutedFingerprints: mutedFingerprints.size,
      proposalsFiled: proposalIds.length,
    },
    "recommend-tighten-posture: scan complete"
  );
  return { proposalsFiled: proposalIds.length, proposalIds };
}
