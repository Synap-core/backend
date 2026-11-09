/**
 * An agent's work belongs to the person it works for. A row an agent created
 * (`createdBy` = the agent user) is that person's row: the person can edit,
 * activate, pause or archive it (finding 50fd3e65, 2026-11-07: the founder
 * could not switch on two pod-wide automations their own agent proposed and
 * they approved).
 *
 * The person behind an agent is `users.createdByUserId` of a `userType =
 * 'agent'` row, the same reading the governance doors use
 * (`loadAgentOwner`, `governance-rules.ts`). This file is the one place that
 * turns "a row's owner" into "the person it stands for", so the write gate and
 * the automation run check cannot read it two ways.
 */
import { eq } from "drizzle-orm";
import { users } from "../schema/index.js";

/**
 * The person an owner id stands for:
 *  - a human user → itself;
 *  - an agent user → the human who created it, or `null` when nobody owns it;
 *  - no users row (a system owner) → `undefined`.
 *
 * A FAILED read throws; it never reads as "no person".
 */
export async function personOfOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any drizzle handle (db / tx)
  database: any,
  ownerId: string
): Promise<string | null | undefined> {
  const [owner] = (await database
    .select({
      userType: users.userType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1)) as Array<{ userType: string; createdByUserId: string | null }>;
  if (!owner) return undefined;
  return owner.userType === "agent" ? (owner.createdByUserId ?? null) : ownerId;
}
