/**
 * proposal-visibility — the SSOT gate for "may this user SEE this proposal?".
 *
 * Extracted from the hand-inlined checks in `proposals.get` / `proposals.source`
 * so every reader (those two tRPC procedures, the channel-bind chokepoint in
 * `resolve-or-create-channel.ts`, and the hydration path in
 * `hub-protocol/context.ts`) enforces the EXACT same predicate:
 *
 *   - workspace proposal (workspaceId set) ⇒ caller must be a member with a role
 *     in {owner, admin, editor}.
 *   - pod-wide proposal (workspaceId NULL) ⇒ ONLY the proposer (`data.sourceId`)
 *     may see it.
 *
 * Deliberately STRICTER than `userVisibleWhere` / the access-registry `proposals`
 * rule (which admit viewers and treat a NULL workspace as pod-visible-to-all):
 * a guessed proposal UUID must not become an AI-prompt injection or a cross-user
 * read, so this gate is the one used on the sensitive proposal-binding paths.
 */

import { TRPCError } from "@trpc/server";
import { db as defaultDb, eq, and, inArray } from "@synap/database";
import {
  focusSessions,
  proposals,
  workspaceMembers,
  users,
} from "@synap/database/schema";
import { isPodAdmin } from "./workspace-role.js";
import { sessionReadableWhere } from "../access/session-visibility.js";
import { proposalSessionIds } from "../services/proposals/session-content-redaction.js";

type Database = typeof defaultDb;

/**
 * Throw unless `userId` may see the proposal `proposalId`.
 * NOT_FOUND if the proposal does not exist; FORBIDDEN if it exists but the user
 * is not permitted. Returns void on success.
 */
export async function assertProposalVisibleTo(
  proposalId: string,
  userId: string,
  opts?: { db?: Database }
): Promise<void> {
  const database = opts?.db ?? defaultDb;

  const proposal = await database.query.proposals.findFirst({
    where: eq(proposals.id, proposalId),
    columns: { workspaceId: true, data: true, agentUserId: true },
  });

  if (!proposal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  }

  // Pod admins may view ANY proposal on their pod. The pod-admin surface is
  // pod-scoped authority, and a pod-wide proposal (workspaceId NULL) has no
  // workspace membership to gate on — the strict `sourceId === userId` branch
  // below only ever admits the PROPOSER (an agent, for agent writes), which
  // locked the human owner out of reviewing agent-authored pod-wide proposals
  // (the /open-link 403). This bypass also aligns this gate with the browser's
  // lenient `userVisibleWhere` read path, which already shows these to admins.
  if (await isPodAdmin(userId)) return;

  if (proposal.workspaceId) {
    const membership = await database.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, proposal.workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
    });
    if (
      !membership ||
      !["owner", "admin", "editor"].includes(membership.role)
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Editor or higher role required to view this proposal",
      });
    }
    return;
  }

  // Pod-wide proposal (no workspaceId) — only the proposer may see it.
  const proposalData = proposal.data as Record<string, unknown> | null;
  if (proposalData?.sourceId === userId) return;

  // CORRECTED 2026-09-07 — previously asserted `sourceId` "is the AGENT's user
  // row, never the human's". FALSE: `utils/permission-check.ts:2750` (canonical
  // `createProposal`) writes the HUMAN, while `services/proposals/dev-approval.ts:222`
  // and `services/playbooks/stage-gate.ts:232` write the AGENT. See the
  // `data.sourceId` contract on `RequestShapedProposalData`.
  // The `agentUserId` resolution is still required: on the dev-approval paths
  // the owning human appears in NEITHER field, so resolve the agent's creator
  // (`users.createdByUserId`) and admit ONLY that one human. This is a
  // VISIBILITY gate, not an authority gate — an agent seeing its own pending
  // proposal is intended (it must be able to revise it), so unlike
  // `computeCanReviewApproval` this deliberately carries NO agent-class floor.
  if (proposal.agentUserId) {
    const agent = await database.query.users.findFirst({
      where: eq(users.id, proposal.agentUserId),
      columns: { createdByUserId: true },
    });
    if (agent?.createdByUserId === userId) return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Not authorized to view this proposal",
  });
}

/**
 * Throw unless `userId` may COMMENT on the proposal `proposalId` (founder
 * decision 2026-09-27): the visibility gate above (editor+), OR the caller can
 * read the session the proposal belongs to — its `session_id` (the run it was
 * filed in, e.g. an intake room) or its subject when it targets a session —
 * through THE session read rule, with the door's roster semantics
 * (`rosterReadFor(ctx)`; `false` on an agent door).
 *
 * COMMENT ONLY. Approve/reject stay on the review ladder, which this never
 * widens; `proposals.get` / `source` / the channel-bind and AI-hydration paths
 * keep `assertProposalVisibleTo` unchanged. Only a FORBIDDEN from the gate is
 * re-checked: NOT_FOUND stays NOT_FOUND.
 */
export async function assertProposalCommentableBy(
  proposalId: string,
  reader: { userId: string; roster: boolean },
  opts?: { db?: Database }
): Promise<void> {
  const database = opts?.db ?? defaultDb;
  try {
    await assertProposalVisibleTo(proposalId, reader.userId, opts);
    return;
  } catch (err) {
    if (!(err instanceof TRPCError) || err.code !== "FORBIDDEN") throw err;
    const proposal = await database.query.proposals.findFirst({
      where: eq(proposals.id, proposalId),
      columns: { sessionId: true, targetType: true, targetId: true },
    });
    const sessionIds = proposal ? proposalSessionIds(proposal) : [];
    if (sessionIds.length > 0) {
      const [readable] = await database
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(
            inArray(focusSessions.id, sessionIds),
            sessionReadableWhere(reader)
          )
        )
        .limit(1);
      if (readable) return;
    }
    throw err;
  }
}
