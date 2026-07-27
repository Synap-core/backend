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
import { db as defaultDb, eq, and } from "@synap/database";
import { proposals, workspaceMembers } from "@synap/database/schema";

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
    columns: { workspaceId: true, data: true },
  });

  if (!proposal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Proposal not found" });
  }

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
  if (proposalData?.sourceId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Not authorized to view this proposal",
    });
  }
}
