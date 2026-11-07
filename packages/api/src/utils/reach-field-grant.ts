/**
 * A pod app may PROPOSE a lead's LinkedIn profile on a pod-wide record
 * (decision 3632f045, a default the founder may override; CRM "Find their
 * LinkedIn", founder 2026-11-07: "for actions that are just an API with a
 * parameter ... it should just launch the underlying tool, no need for ai").
 *
 * A key limited to spaces has its entity update judged in the record's STORED
 * workspace (S7: `entities.update` passes `grantWorkspaceId` = the row's own),
 * so a pod-wide person or company (workspace null) is refused to an app
 * granted the CRM space: it could find a lead's profile with its lookup tool
 * and never save it. ONE exception, and only this one:
 *
 *  - the patch carries ONLY reach fields (`REACH_FIELDS`: the LinkedIn profile
 *    address and member id, the fields the pod's channels reach a person by)
 *    in `properties`, nothing else of the call (no title, description, body,
 *    kind, delete, home, status move, space);
 *  - the record is a pod-wide person or company;
 *  - the key's grant does NOT already permit the write pod scope (then the
 *    ordinary rule stands);
 *  - one of the key's spaces permits `entity.<kind>.update` there AND the
 *    record wears a live role in that space (the role-reach rule of D1,
 *    `role-write-grant.ts`, extended to these fields: the role IS the space
 *    lens), and the key reads the record.
 *
 * Then the write is checked in that space and ALWAYS proposed (never applied,
 * the person's own token through the app included): the person approves it in
 * their pod. Every other own field of a pod-wide record stays refused (403).
 * No grant on the request (a signed-in session, an approval the person
 * replays) = no exception needed: null.
 */

import {
  and,
  db,
  eq,
  getRequestGrant,
  isNull,
  type KeyGrant,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import {
  holderOfGrant,
  parsePlace,
  placeSpaceIds,
} from "@synap-core/types/grants";
import { keyGrantReadClause } from "../access/grant-read.js";
import { grantDeniedKey, type GrantWriteInput } from "./grant-write-check.js";
import { roleInSpacesWhere } from "./project-scope.js";

/** The fields a pod app may propose on a pod-wide record it reaches through a role. */
export const REACH_FIELDS: readonly string[] = [
  "linkedinUrl",
  "linkedinProviderId",
];

/** The kinds the exception covers: the ones a role (lead, contact) is worn by. */
const REACH_KINDS: readonly string[] = ["person", "company"];

/**
 * The call's keys that do not change what is written (who asks, why, how it
 * is grouped or shown). Any other key set on the call takes it out of the
 * exception.
 */
const NEUTRAL_KEYS = new Set([
  "id",
  "properties",
  "source",
  "reasoning",
  "agentUserId",
  "batchId",
  "viewContext",
  "forcePropose",
]);

/**
 * Whether an `entities.update` call writes ONLY reach fields: at least one,
 * every `properties` key a reach field, and no other key of the call set.
 */
export function isReachFieldPatch(input: Record<string, unknown>): boolean {
  const properties = input.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    return false;
  const keys = Object.keys(properties);
  if (keys.length === 0 || !keys.every((k) => REACH_FIELDS.includes(k)))
    return false;
  return Object.entries(input).every(
    ([k, v]) => v === undefined || NEUTRAL_KEYS.has(k)
  );
}

/** Every space the key's scopes are limited to, in the grant's order. */
function keySpaces(grant: KeyGrant): string[] {
  return [
    ...new Set(
      grant.scopes.flatMap((scope) =>
        placeSpaceIds(parsePlace(scope, holderOfGrant(grant)))
      )
    ),
  ];
}

/**
 * The space a reach-field patch of this pod-wide record is checked (and
 * proposed) in, or null when the exception does not apply (the ordinary rule
 * then decides: a pod-wide record's own fields are judged pod scope). Call it
 * only for a patch `isReachFieldPatch` accepts.
 */
export async function reachFieldGrantSpace(
  target: {
    entityId: string;
    /** The record's stored kind (`entities.type`). */
    kind: string | null;
    /** The record's STORED workspace; null = pod-wide. */
    storedWorkspaceId: string | null;
  },
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<string | null> {
  if (!grant || target.storedWorkspaceId !== null) return null;
  if (!target.kind || !REACH_KINDS.includes(target.kind)) return null;
  const write: Omit<GrantWriteInput, "workspaceId"> = {
    subjectType: "entity",
    action: "update",
    data: { id: target.entityId },
  };
  // Already permitted pod scope (a key not limited to spaces): no exception.
  if ((await grantDeniedKey({ ...write, workspaceId: null }, grant)) === null)
    return null;
  for (const space of keySpaces(grant)) {
    if ((await grantDeniedKey({ ...write, workspaceId: space }, grant)) !== null)
      continue;
    const [row] = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.id, target.entityId),
          isNull(entities.deletedAt),
          isNull(entities.workspaceId),
          keyGrantReadClause(entities, grant),
          roleInSpacesWhere(entities.workspaceId, entities.id, [space])
        )
      )
      .limit(1);
    if (row) return space;
  }
  return null;
}
