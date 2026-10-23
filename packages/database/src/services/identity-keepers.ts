/**
 * What keeps a person's IDENTITY (the users row and the Kratos identity) when
 * they are taken out of every space.
 *
 * Removing someone from a space removes MEMBERSHIPS. Deleting who they are is a
 * separate, much rarer act, and `workspaces.removeFromPod` used to do it for
 * anyone left with no space membership, whoever asked: a one-space admin's
 * click could delete a real account that is still linked to Synap Cloud, that
 * joined through a pod invite, or whose data (entities, documents, proposals,
 * messages) stays behind keyed to a user that no longer exists.
 *
 * This is the ONE answer to "does anything still hold this identity?". An
 * empty list is the only case in which the identity may be deleted. A FAILED
 * read throws; it never reads as "nothing keeps them".
 *
 * NOT here: who may delete (the caller's pod-admin role is the router's).
 */

import { eq, or } from "drizzle-orm";
import { db } from "../client-pg.js";
import { documents } from "../schema/documents.js";
import { entities } from "../schema/entities.js";
import { federatedIdentityLinks } from "../schema/federation.js";
import { messages } from "../schema/messages.js";
import { proposals } from "../schema/proposals.js";
import { podMembers } from "../schema/workspaces.js";
import { hasActivePodAccess, readPodUserAccess } from "./pod-user-access.js";

export type IdentityKeeper =
  "active_access" | "pod_member" | "linked_account" | "authored_data";

type Reader = Pick<typeof db, "select">;

async function exists(
  query: PromiseLike<readonly unknown[]>
): Promise<boolean> {
  return (await query).length > 0;
}

export async function readIdentityKeepers(
  userId: string,
  conn: Reader = db
): Promise<IdentityKeeper[]> {
  const [access, member, linked, authored] = await Promise.all([
    readPodUserAccess(userId, conn).then(hasActivePodAccess),
    exists(
      conn
        .select({ id: podMembers.id })
        .from(podMembers)
        .where(eq(podMembers.userId, userId))
        .limit(1)
    ),
    exists(
      conn
        .select({ id: federatedIdentityLinks.userId })
        .from(federatedIdentityLinks)
        .where(eq(federatedIdentityLinks.userId, userId))
        .limit(1)
    ),
    Promise.all([
      exists(
        conn
          .select({ id: entities.id })
          .from(entities)
          .where(
            or(
              eq(entities.userId, userId),
              eq(entities.createdByUserId, userId)
            )
          )
          .limit(1)
      ),
      exists(
        conn
          .select({ id: documents.id })
          .from(documents)
          .where(
            or(
              eq(documents.userId, userId),
              eq(documents.createdByUserId, userId)
            )
          )
          .limit(1)
      ),
      exists(
        conn
          .select({ id: proposals.id })
          .from(proposals)
          .where(eq(proposals.createdBy, userId))
          .limit(1)
      ),
      exists(
        conn
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.userId, userId))
          .limit(1)
      ),
    ]).then((found) => found.some(Boolean)),
  ]);
  const keepers: IdentityKeeper[] = [];
  if (access) keepers.push("active_access");
  if (member) keepers.push("pod_member");
  if (linked) keepers.push("linked_account");
  if (authored) keepers.push("authored_data");
  return keepers;
}
