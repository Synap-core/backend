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
import {
  ProposedKindFieldSchema,
  type ProposedKindField,
} from "./proposed-kind-field.js";

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

/**
 * A field the caller DECLARED that differs from the def already stored under
 * this slug — and was therefore NOT written. `property-defs.create` is
 * slug-idempotent, never convergent: on a slug hit it returns the existing row
 * untouched. Reporting the declaration as applied is the lie this type exists
 * to prevent (see `existing` on the result).
 */
export interface IgnoredDeclaration {
  field: "valueType" | "constraints" | "uiHints";
  declared: unknown;
  stored: unknown;
}

export interface CreateAndLinkPropertyDefResult {
  propertyDef: Record<string, unknown> & { id: string };
  link: Record<string, unknown> | null;
  /**
   * TRUE when the def already existed under this slug+scope and was returned
   * as-is. The caller MUST NOT report such a call as "applied": nothing about
   * the DEFINITION was written. (The profile LINK below is still upserted, so
   * `required` / `defaultValue` / `displayOrder` do converge.)
   */
  existing: boolean;
  /** Declared def fields that differ from the stored row. Empty unless `existing`. */
  ignored: IgnoredDeclaration[];
}

/** Order-insensitive structural compare, so `{a,b}` and `{b,a}` are the same. */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * What the caller declared vs what is stored, for the def fields this helper
 * would have written on a create. A field the caller did NOT declare
 * (`undefined`) is not a difference — it was never a claim.
 */
export function diffIgnoredDeclarations(
  declared: Pick<
    CreateAndLinkPropertyDefInput,
    "valueType" | "constraints" | "uiHints"
  >,
  stored: Record<string, unknown>
): IgnoredDeclaration[] {
  const ignored: IgnoredDeclaration[] = [];
  const compare = (
    field: IgnoredDeclaration["field"],
    declaredValue: unknown
  ) => {
    if (declaredValue === undefined) return;
    const storedValue = stored[field];
    if (canonical(declaredValue) !== canonical(storedValue)) {
      ignored.push({ field, declared: declaredValue, stored: storedValue });
    }
  };
  compare("valueType", declared.valueType);
  compare("constraints", declared.constraints);
  compare("uiHints", declared.uiHints);
  return ignored;
}

/**
 * The checks `createAndLinkPropertyDef` runs before it writes anything: the
 * profile resolves for this user, and the user may link this field onto it.
 * Shared with the batch below, which runs it on EVERY field before the first
 * write.
 */
export async function assertPropertyDefLinkable(
  input: Pick<
    CreateAndLinkPropertyDefInput,
    "userId" | "workspaceId" | "profileId" | "required" | "defaultValue"
  >
): Promise<void> {
  if (!input.profileId) return;
  const db = await getDb();
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
  await assertPropertyDefLinkable(input);

  // No `workspaceRole` here: the membership gates read the caller's role from
  // the database, and a faked "owner" would satisfy any check that trusted it.
  const callerCtx = {
    db,
    authenticated: true as const,
    userId: input.userId,
    workspaceId: input.workspaceId,
  } as unknown as Context;

  const propertyDefCaller = propertyDefsRouter.createCaller(callerCtx);
  const createResult = await propertyDefCaller.create({
    slug: input.slug,
    valueType: input.valueType,
    constraints: input.constraints,
    uiHints: input.uiHints,
    profileId: input.profileId,
    overlay,
  });
  const { propertyDef } = createResult;
  // `property-defs.create` returns `existing: true` on a slug hit and writes
  // NOTHING. That fact used to die here — every caller then reported the call
  // as "applied" with the caller's declaration nowhere in the stored row.
  const existing = (createResult as { existing?: boolean }).existing === true;
  const ignored = existing
    ? diffIgnoredDeclarations(input, propertyDef as Record<string, unknown>)
    : [];

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
    existing,
    ignored,
  };
}

/**
 * Apply N fields of ONE profile together — the approval of a batched
 * `property_def/create` proposal (ticket a375443d: adding 19 fields to an
 * approved kind filed 19 proposals and hit the agent's limit). ALL OR NONE:
 * every field is parsed and checked (shape, a slug twice in the batch, the
 * profile, the approver's right to link it) BEFORE the first write, so a
 * refused field writes nothing. The writes are separate router calls, not one
 * transaction: a failure part-way throws, the approval is recorded failed, and
 * a retry converges, because `createAndLinkPropertyDef` is slug-idempotent
 * (a field already written is returned as it is).
 */
export async function createAndLinkPropertyDefs(input: {
  userId: string;
  workspaceId: string;
  profileId: string;
  fields: readonly unknown[];
}): Promise<CreateAndLinkPropertyDefResult[]> {
  const parsed: ProposedKindField[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.fields) {
    const result = ProposedKindFieldSchema.safeParse(raw);
    if (!result.success) {
      const slug =
        raw && typeof raw === "object" && "slug" in raw
          ? String((raw as { slug: unknown }).slug)
          : "?";
      problems.push(
        `${slug}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "field"} ${i.message}`)
          .join("; ")}`
      );
      continue;
    }
    if (seen.has(result.data.slug)) {
      problems.push(`${result.data.slug}: named twice`);
      continue;
    }
    seen.add(result.data.slug);
    parsed.push(result.data);
  }
  if (problems.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No field was added: ${problems.join(", ")}.`,
    });
  }
  for (const field of parsed) {
    await assertPropertyDefLinkable({
      userId: input.userId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      required: field.required,
      defaultValue: field.defaultValue,
    });
  }
  const results: CreateAndLinkPropertyDefResult[] = [];
  for (const field of parsed) {
    results.push(
      await createAndLinkPropertyDef({
        userId: input.userId,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        slug: field.slug,
        valueType:
          field.valueType as CreateAndLinkPropertyDefInput["valueType"],
        constraints: field.constraints,
        uiHints: field.uiHints,
        overlay: field.overlay === true,
        required: field.required,
        defaultValue: field.defaultValue,
        displayOrder: field.displayOrder,
      })
    );
  }
  return results;
}
