/**
 * "Sign in with Synap" — what a person signed in to an app may DECIDE about
 * the app's own AI (PR #29 M2, founder design "approve AI drafts inline").
 *
 * A person's app token is the person: it may approve within its grant, which
 * includes proposals the app's OWN agent filed — the app shows its AI's drafts
 * and the person approves them in place. That is intended, so it stays
 * allowed by default, but it is made VISIBLE (the proposal records
 * `approvedInApp`) and SWITCHABLE: the app's owner sets
 * `personMayDecideOwnAgentProposals` false (`apps.setSignInPolicy`) and such
 * an approval is refused. Trade-off: with it on, an app whose AI and whose
 * sign-in are the same code can file and approve its own work as long as a
 * signed-in person's token is in hand — the stamp is how a reviewer sees it.
 *
 * A request is an app sign-in when its grant names an app (`clientId` is an
 * app's public id) and no agent acts in it: an app's own agent key always
 * carries its acting agent, so the two cannot be confused.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, getActingAgentUserId, getRequestGrant } from "@synap/database";
import { apps } from "@synap/database/schema";
import { isAppPublicId } from "@synap-core/types/membrane";

/** The app this request is a person's sign-in to, or null. */
export async function signedInApp(): Promise<{
  publicId: string;
  name: string;
  agentUserId: string | null;
  personMayDecideOwnAgentProposals: boolean;
} | null> {
  const clientId = getRequestGrant()?.clientId ?? null;
  if (!isAppPublicId(clientId) || getActingAgentUserId()) return null;
  const [app] = await db
    .select({
      publicId: apps.publicId,
      name: apps.name,
      agentUserId: apps.agentUserId,
      metadata: apps.metadata,
    })
    .from(apps)
    .where(eq(apps.publicId, clientId!))
    .limit(1);
  if (!app) return null;
  return {
    publicId: app.publicId,
    name: app.name,
    agentUserId: app.agentUserId,
    personMayDecideOwnAgentProposals:
      (app.metadata as Record<string, unknown> | null)
        ?.personMayDecideOwnAgentProposals !== false,
  };
}

/**
 * Before an approval: refuse a sign-in approving its app's OWN agent's
 * proposal when the owner turned that off. Returns the app (for the stamp)
 * when the request is an app sign-in, else null.
 */
export async function assertAppSignInMayApprove(proposal: {
  agentUserId?: string | null;
}): Promise<{ publicId: string; name: string } | null> {
  const app = await signedInApp();
  if (!app) return null;
  if (
    !app.personMayDecideOwnAgentProposals &&
    app.agentUserId &&
    proposal.agentUserId === app.agentUserId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${app.name} may not approve what its own AI proposed — its owner turned that off. Approve it in Synap.`,
    });
  }
  return { publicId: app.publicId, name: app.name };
}
