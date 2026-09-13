/**
 * Create a property def AND link it to its profile — the shared write path.
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the governed Hub route
 * (`hub-protocol/profiles.ts#createPropertyDef`, operator/auto-approved-agent
 * auto-apply) AND the `property_def/create` proposal executor (agent proposal
 * → materialize on approval). A property def row is INVISIBLE to a profile
 * until it is linked via `profile_properties` — every caller MUST perform
 * both steps through this function, never call propertyDefsRouter.create()
 * alone (that would leave an orphaned, unrendered def).
 *
 * Delegates to the regular `property-defs` and `profile-properties` routers
 * (via `.createCaller`) so slug-conflict handling, profile-accessibility
 * checks, and workspace-membership gating are inherited rather than
 * reimplemented. Mirrors the caller pattern used by the `entity/create`
 * proposal executor (see routers/proposals/approve-executors.ts).
 */

import { TRPCError } from "@trpc/server";
import { getDb, ProfileResolutionService } from "@synap/database";
import type { Context } from "../../types/context.js";
import {
  assertProfileSchemaWrite,
  propertyLinkLevel,
} from "../../utils/profile-schema-write-access.js";
import { propertyDefsRouter } from "../../routers/property-defs.js";
import { profilePropertiesRouter } from "../../routers/profile-properties.js";

export interface CreateAndLinkPropertyDefInput {
  userId: string;
  /** Workspace the calling user acts as a member of (required by workspaceProcedure). */
  workspaceId: string;
  /** Profile to attach the field to. Omit to create a global (profile-less) def — it will NOT be linked. */
  profileId?: string;
  slug: string;
  valueType:
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
  /** Workspace-scoped overlay (invisible to other workspaces) instead of a profile-base def. */
  overlay?: boolean;
  /** profile_properties link options — default to the same values profile-properties.link uses. */
  required?: boolean;
  defaultValue?: unknown;
  displayOrder?: number;
}

export interface CreateAndLinkPropertyDefResult {
  propertyDef: Record<string, unknown> & { id: string };
  link: Record<string, unknown> | null;
}

/**
 * Apply a property-def create (+ link, when profileId is given). Caller MUST
 * gate first (checkPermissionOrPropose) — this function does no governance.
 */
export async function createAndLinkPropertyDef(
  input: CreateAndLinkPropertyDefInput
): Promise<CreateAndLinkPropertyDefResult> {
  const db = await getDb();
  const overlay = input.overlay === true;

  // Ownership gate BEFORE the def exists. The two writes below are separate
  // router calls, not one transaction, so a link refused AFTER the create
  // would leave an orphaned, unrenderable def behind. `profile-properties.link`
  // re-checks with the precise answer (it can see an existing link); this
  // pre-check evaluates the same rule for a brand-new link.
  if (input.profileId) {
    const profile = await new ProfileResolutionService(db).resolveProfile(
      input.profileId,
      input.userId,
      input.workspaceId
    );
    if (!profile) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Profile not found: ${input.profileId}`,
      });
    }
    await assertProfileSchemaWrite(db, input.userId, profile, {
      level: propertyLinkLevel({
        required: input.required,
        defaultValue: input.defaultValue,
        alreadyLinked: false,
      }),
      actingWorkspaceId: input.workspaceId,
    });
  }

  // No `workspaceRole` here: the membership gates read the caller's role from
  // the database, and a faked "owner" would satisfy any check that trusted it.
  const callerCtx = {
    db,
    authenticated: true as const,
    userId: input.userId,
    workspaceId: input.workspaceId,
  } as unknown as Context;

  const propertyDefCaller = propertyDefsRouter.createCaller(callerCtx);
  const { propertyDef } = await propertyDefCaller.create({
    slug: input.slug,
    valueType: input.valueType,
    constraints: input.constraints,
    uiHints: input.uiHints,
    profileId: input.profileId,
    overlay,
  });

  let link: Record<string, unknown> | null = null;
  if (input.profileId) {
    const profilePropertiesCaller =
      profilePropertiesRouter.createCaller(callerCtx);
    const linkResult = await profilePropertiesCaller.link({
      profileId: input.profileId,
      propertyDefId: propertyDef.id,
      required: input.required ?? false,
      defaultValue: input.defaultValue,
      displayOrder: input.displayOrder ?? 0,
    });
    link = linkResult.link as Record<string, unknown>;
  }

  return {
    propertyDef: propertyDef as Record<string, unknown> & { id: string },
    link,
  };
}
