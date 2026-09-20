/**
 * Edit an EXISTING property def — the shared apply path.
 *
 * WHY THIS IS A DELEGATE AND NOT A WRITER. `propertyDefs.update`
 * (`routers/property-defs.ts`) already owns this row's edit rules: the
 * owner gate read from the LOADED row (overlay → editor of that workspace,
 * base def → the profile's owner, global → pod admin), and the slug-conflict
 * check against the same partial unique index the create path uses. A second
 * writer for one row is a fork the moment it exists, so this helper calls that
 * procedure through `.createCaller` — exactly the pattern
 * `createAndLinkPropertyDef` uses for the create half.
 *
 * WHAT IT ADDS: one apply path shared by BOTH the governed Hub door
 * (`hub-protocol/profiles.ts#updatePropertyDef`, granted/operator branch) and
 * the `property_def/update` proposal executor (agent proposal → materialize on
 * approval), so the two can never drift.
 *
 * GOVERNANCE IS NOT DECIDED HERE. Callers MUST gate first
 * (`checkPermissionOrPropose`) — this function does no governance, like its
 * create sibling.
 */

import { getDb } from "@synap/database";
import type { Context } from "../../types/context.js";
import { propertyDefsRouter } from "../../routers/property-defs.js";

export interface UpdatePropertyDefInput {
  userId: string;
  /** Workspace the calling user acts as a member of (required by the caller ctx). */
  workspaceId: string;
  propertyDefId: string;
  /** Any subset; at least one is required by the doors above. */
  slug?: string;
  valueType?:
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "date"
    | "secret"
    | "entity_id";
  constraints?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
}

export interface UpdatePropertyDefResult {
  propertyDef: Record<string, unknown> & { id: string };
}

export async function updatePropertyDef(
  input: UpdatePropertyDefInput
): Promise<UpdatePropertyDefResult> {
  const db = await getDb();

  // No `workspaceRole` here: the membership gates read the caller's role from
  // the database, and a faked "owner" would satisfy any check that trusted it.
  const callerCtx = {
    db,
    authenticated: true as const,
    userId: input.userId,
    workspaceId: input.workspaceId,
  } as unknown as Context;

  const { propertyDef } = await propertyDefsRouter
    .createCaller(callerCtx)
    .update({
      id: input.propertyDefId,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.valueType !== undefined ? { valueType: input.valueType } : {}),
      ...(input.constraints !== undefined
        ? { constraints: input.constraints }
        : {}),
      ...(input.uiHints !== undefined ? { uiHints: input.uiHints } : {}),
    });

  return {
    propertyDef: propertyDef as Record<string, unknown> & { id: string },
  };
}
