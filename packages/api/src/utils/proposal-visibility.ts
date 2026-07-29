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
import { proposals, workspaceMembers, users } from "@synap/database/schema";
import { isPodAdmin } from "./workspace-role.js";

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

  // An agent-authored proposal's `sourceId` is the AGENT's user row, never the
  // human's — so the direct match above can never admit the human who OWNS
  // that agent. Resolve the agent's creator (`users.createdByUserId`) and
  // admit ONLY that one human — the sole widening here, never any other user.
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
