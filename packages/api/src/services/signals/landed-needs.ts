/**
 * WHAT A RECENT APPROVAL LANDED THAT ONLY THE PERSON CAN TAKE ON, read for
 * the needs-you union (`signals.ts` › `readAttention`) as `access-request`
 * rows: a draft automation or playbook to turn on, a playbook whose skills
 * must be enabled. Turning one on is the person's act (an agent's activation
 * is floored to a person, `automation/activate`).
 *
 * ONE read: the viewer's applied proposals of the last
 * {@link LANDED_NEEDS_DAYS} days (reviewed by them, made for them or filed by
 * them, under the proposal floor), then `resolveLandedObjects`, which floors
 * each object by the reader and derives its next step once (`objectNextOf`).
 * The row lives exactly as long as the next step does: once the person turns
 * it on, the next read finds nothing. Each object once, its newest approval
 * first.
 *
 * Under any lens it is not read (`readsAccess`): the union's floor-only rule.
 */

import {
  and,
  db,
  desc,
  eq,
  gte,
  inArray,
  or,
  proposals,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ObjectNextAction } from "@synap-core/types/units";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { resolveLandedObjects } from "../proposals/landed-read.js";
import type { LandedNeedSignalInput } from "./needs-you-union.js";
import {
  ACCESS_REQUEST_SCAN_LIMIT,
  type AccessRequestHalf,
} from "./access-requests.js";

/** How far back an approval's landed objects are read. */
export const LANDED_NEEDS_DAYS = 7;

/** The next steps only a person takes on an object an approval landed. */
export const PERSON_ONLY_NEXT_ACTIONS = [
  "turn_on",
  "enable",
] as const satisfies readonly ObjectNextAction[];

const APPLIED = [ProposalStatus.APPROVED, ProposalStatus.AUTO_APPROVED];

const isPersonOnly = (
  action: string
): action is LandedNeedSignalInput["action"] =>
  (PERSON_ONLY_NEXT_ACTIONS as readonly string[]).includes(action);

const isLandedNeedKind = (
  kind: string
): kind is LandedNeedSignalInput["kind"] =>
  kind === "automation" || kind === "playbook";

export async function listLandedNeedsPerson(args: {
  userId: string;
  roster: boolean;
  now?: Date;
}): Promise<AccessRequestHalf<LandedNeedSignalInput>> {
  const since = new Date(
    (args.now ?? new Date()).getTime() - LANDED_NEEDS_DAYS * 86_400_000
  );
  const rows = await db
    .select({
      status: proposals.status,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      targetId: proposals.targetId,
      data: proposals.data,
      workspaceId: proposals.workspaceId,
      updatedAt: proposals.updatedAt,
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.status, APPLIED),
        gte(proposals.updatedAt, since),
        or(
          eq(proposals.reviewedBy, args.userId),
          eq(proposals.subjectUserId, args.userId),
          eq(proposals.createdBy, args.userId)
        ),
        proposalUserFloor(args.userId)
      )
    )
    .orderBy(desc(proposals.updatedAt))
    .limit(ACCESS_REQUEST_SCAN_LIMIT + 1);
  const scanned = rows.slice(0, ACCESS_REQUEST_SCAN_LIMIT);
  const landed = await resolveLandedObjects(scanned, {
    userId: args.userId,
    roster: args.roster,
  });
  const seen = new Set<string>();
  const out: LandedNeedSignalInput[] = [];
  scanned.forEach((row, i) => {
    for (const object of landed[i] ?? []) {
      const action = object.next?.action;
      if (!action || !isPersonOnly(action) || !isLandedNeedKind(object.kind))
        continue;
      const key = `${object.kind}:${object.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: object.kind,
        id: object.id,
        name: object.name?.trim() ?? "",
        action,
        landedAt: new Date(row.updatedAt),
      });
    }
  });
  return { rows: out, truncated: rows.length > ACCESS_REQUEST_SCAN_LIMIT };
}
