/**
 * Pod hygiene approval halves:
 *
 *   profile/retire           soft-retire a kind after re-running its preflight
 *   profile/merge            the retire refusal's merge suggestion, applied by
 *                            the conversions engine (pod admin only)
 *   pod_hygiene/cleanup_pack apply the APPROVED items of a pack through the
 *                            existing doors; items the reviewer rejected
 *                            (`proposals.rejectItem`) are skipped
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  drizzleSql,
  proposals,
  automations,
  focusSessions,
  ProposalStatus,
} from "@synap/database";
import {
  readPackItems,
  type ReadCleanupPackItem,
} from "@synap-core/types/pod-hygiene";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import type { Context } from "../../../context.js";
import { automationsRouter } from "../../automations.js";
import { completeFocusSession } from "../../../services/focus-sessions/complete-session.js";
import { isTerminalSessionStatus } from "@synap-core/types/focus-sessions";
import { markProposalNotificationsActioned } from "../../../notifications/mark-proposal-notifications-actioned.js";
import { discardProposalSourceBlob } from "../../../utils/store-entity-source-blob.js";
import {
  applyProfileMerge,
  applyProfileRetire,
  type MergeSuggestion,
} from "../../../services/pod-hygiene/retire-profile.js";
import {
  registerProposalExecutor,
  type ProposalExecutorArgs,
  type ProposalExecutorResult,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** What one pack item did — stored on `data.outcomes[ref]` the moment it happens. */
interface StoredOutcome {
  outcome: "applied" | "skipped_by_reviewer" | "refused";
  reason?: string;
  at: string;
}

type ItemOutcome = StoredOutcome & {
  ref: string;
  subjectId: string;
  name: string;
  subjectKind: string;
};

/**
 * Write ONE item's outcome into the pack row as it happens, so a crash midway
 * leaves a true partial record rather than invisible side effects. A legacy v1
 * `outcomes` array is replaced by the keyed object.
 */
async function recordOutcome(
  packId: string,
  ref: string,
  stored: StoredOutcome
): Promise<void> {
  await db
    .update(proposals)
    .set({
      data: drizzleSql`jsonb_set(
        COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object(
          'outcomes',
          CASE WHEN jsonb_typeof(${proposals.data}->'outcomes') = 'object'
            THEN ${proposals.data}->'outcomes' ELSE '{}'::jsonb END
        ),
        ARRAY['outcomes', ${ref}::text],
        ${JSON.stringify(stored)}::jsonb,
        true
      )`,
    })
    .where(eq(proposals.id, packId));
}

async function alreadyApproved(proposalId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

async function markApproved(
  args: ProposalExecutorArgs,
  dataPatch?: Record<string, unknown>
): Promise<void> {
  const { proposal, userId, input, deps } = args;
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
      ...(dataPatch
        ? {
            data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || ${JSON.stringify(dataPatch)}::jsonb`,
          }
        : {}),
    })
    .where(eq(proposals.id, input.proposalId));
  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );
}

/** The human a pack is for — every owner-scoped door runs as them. */
function packOwner(proposal: ProposalExecutorArgs["proposal"]): string {
  const owner =
    proposal.subjectUserId ??
    ((proposal.data as Record<string, unknown> | null)?.sourceId as
      string | undefined);
  if (!owner) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cleanup pack has no owner",
    });
  }
  return owner;
}

async function applyPackItem(
  item: ReadCleanupPackItem,
  ctx: { ownerUserId: string; approverUserId: string; packId: string }
): Promise<void> {
  const targetId = item.subject.id;
  switch (item.action) {
    case "close_session": {
      const [session] = await db
        .select({
          status: focusSessions.status,
          updatedAt: focusSessions.updatedAt,
        })
        .from(focusSessions)
        .where(eq(focusSessions.id, targetId));
      if (!session) throw new Error("No longer exists");
      if (isTerminalSessionStatus(session.status)) {
        throw new Error("Already closed");
      }
      // Re-validate against what the reviewer saw: still idle, and untouched
      // since the pack was filed. A v1 item carries no snapshot, so only the
      // status check applies to it.
      const snapshotAt = item.item?.snapshot.updatedAt;
      if (
        session.status !== "stale" ||
        (snapshotAt !== undefined &&
          new Date(session.updatedAt).getTime() > Date.parse(snapshotAt))
      ) {
        throw new Error("Active again since this pack was filed");
      }
      const result = await completeFocusSession({
        sessionId: targetId,
        userId: ctx.ownerUserId,
        terminalStatus: "closed",
        summary: "Closed by an approved cleanup pack (idle, no activity).",
      });
      if (!result) throw new Error("Session no longer exists");
      if (!isTerminalSessionStatus(result.session.status)) {
        throw new Error(
          `Session did not close (status ${result.session.status})`
        );
      }
      return;
    }
    case "expire_proposal": {
      const [target] = await db
        .select({ data: proposals.data })
        .from(proposals)
        .where(eq(proposals.id, targetId));
      const rows = await db
        .update(proposals)
        .set({
          status: ProposalStatus.EXPIRED,
          updatedAt: new Date(),
          data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object('expiredByCleanupPack', ${ctx.packId}::text)`,
        })
        .where(
          and(
            eq(proposals.id, targetId),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        )
        .returning({ id: proposals.id });
      if (rows.length === 0) throw new Error("Proposal is no longer pending");
      markProposalNotificationsActioned([targetId]);
      await discardProposalSourceBlob({
        database: db,
        userId: ctx.ownerUserId,
        proposalData: target?.data,
      });
      return;
    }
    case "retire_profile": {
      const result = await applyProfileRetire({
        profileId: targetId,
        approverUserId: ctx.approverUserId,
        sourceProposalId: ctx.packId,
      });
      if (result.applied === "none") throw new Error(result.reason);
      return;
    }
    case "pause_automation": {
      const [row] = await db
        .select({
          runCount: automations.runCount,
          lastRunAt: automations.lastRunAt,
        })
        .from(automations)
        .where(eq(automations.id, targetId));
      if (!row) throw new Error("Automation no longer exists");
      if (row.runCount > 0 || row.lastRunAt) {
        throw new Error("Automation has run since the pack was filed");
      }
      const caller = automationsRouter.createCaller({
        db,
        authenticated: true as const,
        userId: ctx.ownerUserId,
      } as unknown as Context);
      const result = await caller.pause({ id: targetId });
      if (result.status !== "paused")
        throw new Error("Automation did not pause");
      return;
    }
  }
}

/** Apply a pack's approved items (v2 and legacy v1). Exported for the behavioural test. */
export async function applyCleanupPack(args: ProposalExecutorArgs): Promise<{
  outcomes: ItemOutcome[];
  appliedIds: string[];
  unreadable: number;
}> {
  const { proposal, userId, input } = args;
  const ownerUserId = packOwner(proposal);
  const data = (proposal.data ?? {}) as Record<string, unknown>;
  const dispositions = (data.dispositions ?? {}) as Record<
    string,
    { status?: string }
  >;
  // Outcomes a previous, interrupted approve already recorded. An item recorded
  // `applied` is not run again: its door would now refuse ("Already closed")
  // and overwrite a true record with a false one.
  const prior =
    data.outcomes &&
    typeof data.outcomes === "object" &&
    !Array.isArray(data.outcomes)
      ? (data.outcomes as Record<string, StoredOutcome | undefined>)
      : {};
  const read = readPackItems(data);
  const outcomes: ItemOutcome[] = [];
  const appliedIds: string[] = [];

  for (const item of read.items) {
    const at = new Date().toISOString();
    const identity = {
      ref: item.ref,
      subjectId: item.subject.id,
      name: item.subject.name,
      subjectKind: item.subject.kind,
    };
    const previous = prior[item.ref];
    if (previous?.outcome === "applied") {
      outcomes.push({ ...previous, ...identity });
      appliedIds.push(item.subject.id);
      continue;
    }
    let stored: StoredOutcome;
    if (dispositions[item.ref]?.status === "reject") {
      stored = { outcome: "skipped_by_reviewer", at };
    } else {
      try {
        await applyPackItem(item, {
          ownerUserId,
          approverUserId: userId,
          packId: input.proposalId,
        });
        stored = { outcome: "applied", at };
        appliedIds.push(item.subject.id);
      } catch (err) {
        stored = {
          outcome: "refused",
          reason: err instanceof Error ? err.message : String(err),
          at,
        };
      }
    }
    await recordOutcome(input.proposalId, item.ref, stored);
    outcomes.push({
      ...stored,
      ref: item.ref,
      subjectId: item.subject.id,
      name: item.subject.name,
      subjectKind: item.subject.kind,
    });
  }
  return { outcomes, appliedIds, unreadable: read.unreadable };
}

/** Register the pod hygiene approve executors. */
export function registerPodHygieneExecutors(): void {
  registerProposalExecutor({
    key: "profile/retire",
    async execute(args): Promise<ProposalExecutorResult> {
      if (await alreadyApproved(args.input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const profileId = args.proposal.targetId;
      const result = await applyProfileRetire({
        profileId,
        approverUserId: args.userId,
        sourceProposalId: args.input.proposalId,
      });
      // The reviewer-facing note: which kind the tombstone points at, or why
      // an applied merge's canonical could not be named.
      await markApproved(
        args,
        result.applied === "verified"
          ? {
              ...(result.mergedInto ? { mergedInto: result.mergedInto } : {}),
              ...(result.mergedIntoSkipped
                ? { mergedIntoSkipped: result.mergedIntoSkipped }
                : {}),
            }
          : undefined
      );
      return {
        success: true,
        primaryId: profileId,
        effect:
          result.applied === "verified"
            ? {
                applied: "verified",
                rows: 1,
                ids: [profileId],
                subject: "profiles",
              }
            : { applied: "none", reason: result.reason },
      };
    },
  });

  registerProposalExecutor({
    key: "profile/merge",
    async execute(args): Promise<ProposalExecutorResult> {
      if (await alreadyApproved(args.input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const suggestion = (args.proposal.data as Record<string, unknown> | null)
        ?.suggestion as MergeSuggestion | undefined;
      if (!suggestion) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Merge proposal is missing its suggestion",
        });
      }
      const result = await applyProfileMerge({
        proposalId: args.input.proposalId,
        approverUserId: args.userId,
        suggestion,
      });
      await markApproved(args, { mergeResult: result });
      return {
        success: true,
        primaryId: args.proposal.targetId,
        effect:
          result.status === "applied"
            ? {
                applied: "verified",
                rows: Number(result.counts.entitiesRepointed ?? 0),
                subject: "entities",
              }
            : {
                applied: "none",
                reason: `The conversions ledger reported '${result.status}' for this merge.`,
              },
      };
    },
  });

  registerProposalExecutor({
    key: "pod_hygiene/cleanup_pack",
    async execute(args): Promise<ProposalExecutorResult> {
      if (await alreadyApproved(args.input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const { outcomes, appliedIds, unreadable } = await applyCleanupPack(args);
      // Outcomes are already on the row, item by item; only the status is left.
      await markApproved(args);
      // Keyed by the item's NAME — a ref like `close_session:<uuid>` is not
      // something a reviewer can act on.
      const refusals = outcomes
        .filter((o) => o.outcome === "refused")
        .map(
          (o) =>
            `${o.name} (${resolveObjectNoun(o.subjectKind).toLowerCase()}): ${o.reason}`
        );
      if (unreadable > 0) {
        refusals.push(
          `${unreadable} item(s) in this pack could not be read and were not applied.`
        );
      }
      return {
        success: true,
        created: 0,
        effect:
          appliedIds.length > 0
            ? {
                applied: "verified",
                rows: appliedIds.length,
                ids: appliedIds,
                subject: "cleanup_pack",
              }
            : {
                applied: "none",
                reason:
                  refusals.length > 0
                    ? "No item could be applied — see refusals."
                    : "Every item was rejected by the reviewer.",
              },
        ...(refusals.length > 0 ? { refusals } : {}),
      };
    },
  });
}
