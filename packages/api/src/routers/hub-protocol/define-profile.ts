/**
 * The ONE define-kind / define-role door shared by every agent surface.
 *
 * MCP `synap_define_kind` / `synap_define_role` and Hub REST `POST /profiles`
 * all land here, so the mapping from a door's arguments onto the governed hub
 * `profiles.createProfile` (+ one `createPropertyDef` per field) exists once.
 * Before this, the mapping lived inline in the MCP handler and REST had no way
 * to express a role, an entity scope, or fields at all.
 *
 * Governance is NOT decided here: `profiles.createProfile` → `profiles.create`
 * runs `checkPermissionOrPropose`, and an agent structure write floors to a
 * proposal there. This file only shapes the input and the per-field ledger.
 */

import { PropertyValueType } from "@synap/database";

import type { HubProtocolCaller } from "./rest/_shared.js";

const PROPERTY_VALUE_TYPES: string[] = Object.values(PropertyValueType);

/** Base kinds a role attaches to when the caller names none. */
const DEFAULT_ROLE_APPLICABLE_KINDS = ["company", "person"];

export interface DefineProfileInput {
  userId: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  /** Omit → 'kind'. */
  profileKind?: "kind" | "role";
  applicableKinds?: string[];
  roleCategory?: string;
  entityScope?: "pod" | "workspace";
  description?: string;
  icon?: string;
  uiHints?: Record<string, unknown>;
  defaultValues?: Record<string, unknown>;
  parentProfileId?: string;
  /** Field definitions (`{ slug, valueType, … }[]`). Validated here. */
  fields?: unknown;
  reasoning?: string;
  agentUserId?: string;
}

export interface DefineProfileLabels {
  /** The door's own name, used in agent-facing prose (`synap_define_kind`). */
  door: string;
  /** The argument that carries field defs on that door (`properties`, `fields`). */
  fieldsParam: string;
}

export type DefineProfileOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

type ProfilesCaller = Pick<HubProtocolCaller, "profiles">;

export async function defineProfile(
  caller: ProfilesCaller,
  input: DefineProfileInput,
  labels: DefineProfileLabels
): Promise<DefineProfileOutcome> {
  if (input.fields !== undefined && !Array.isArray(input.fields)) {
    return {
      ok: false,
      error: `${labels.door}: \`${labels.fieldsParam}\` must be an ARRAY of field definitions ({ slug, valueType }). To set default VALUES for new entities of this kind, use \`defaultValues\` instead.`,
    };
  }

  const uiHints: Record<string, unknown> = { ...(input.uiHints ?? {}) };
  if (input.icon !== undefined) uiHints.icon = input.icon;
  if (input.description !== undefined) uiHints.description = input.description;

  const profileKind = input.profileKind ?? "kind";
  const applicableKinds =
    profileKind === "role"
      ? input.applicableKinds && input.applicableKinds.length > 0
        ? input.applicableKinds
        : DEFAULT_ROLE_APPLICABLE_KINDS
      : input.applicableKinds;

  const result = (await caller.profiles.createProfile({
    userId: input.userId,
    workspaceId: input.workspaceId,
    slug: input.slug,
    displayName: input.displayName,
    profileKind,
    ...(applicableKinds ? { applicableKinds } : {}),
    ...(input.roleCategory !== undefined
      ? { roleCategory: input.roleCategory }
      : {}),
    ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
    ...(input.defaultValues ? { defaultValues: input.defaultValues } : {}),
    ...(input.parentProfileId
      ? { parentProfileId: input.parentProfileId }
      : {}),
    // Passed ONLY when declared — an omitted entityScope must reach
    // `resolveEntityScope` as undefined so the kind→pod / role→workspace
    // doctrine default applies.
    ...(input.entityScope ? { entityScope: input.entityScope } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
  })) as unknown as Record<string, unknown>;

  const fieldSpecs = (input.fields ?? []) as Array<Record<string, unknown>>;

  // Governance gated the profile itself → there is no profileId to hang fields
  // on. Return the proposal and say the fields are still pending, rather than
  // half-applying a schema.
  if (result && result.status === "proposed") {
    return {
      ok: true,
      result: {
        ...result,
        ...(fieldSpecs.length > 0
          ? {
              properties: {
                status: "deferred",
                message: `The kind itself is awaiting review. Re-call ${labels.door} with the same slug once the proposal is approved to add these fields (the call is slug-idempotent).`,
                pending: fieldSpecs.length,
              },
            }
          : {}),
      },
    };
  }

  const createdProfile = result?.profile as { id?: string } | null | undefined;
  const profileId = createdProfile?.id;
  if (fieldSpecs.length === 0 || !profileId) {
    return { ok: true, result };
  }

  const properties: Array<Record<string, unknown>> = [];
  for (const spec of fieldSpecs) {
    const propSlug = typeof spec.slug === "string" ? spec.slug : undefined;
    const valueType =
      typeof spec.valueType === "string" ? spec.valueType : undefined;
    if (!propSlug || !valueType) {
      properties.push({
        slug: propSlug ?? null,
        status: "error",
        error: "Each property requires `slug` and `valueType`.",
      });
      continue;
    }
    // The hub door types valueType as `z.string()` and then casts it onto the
    // `property_defs.value_type` PG enum, so an unknown string fails at INSERT
    // time with a Postgres error the agent cannot act on.
    if (!PROPERTY_VALUE_TYPES.includes(valueType)) {
      properties.push({
        slug: propSlug,
        status: "error",
        error: `Unsupported valueType '${valueType}'. Valid: ${PROPERTY_VALUE_TYPES.join(", ")}.`,
      });
      continue;
    }
    try {
      const propResult = await caller.profiles.createPropertyDef({
        userId: input.userId,
        workspaceId: input.workspaceId,
        profileId,
        slug: propSlug,
        valueType,
        ...(spec.constraints
          ? { constraints: spec.constraints as Record<string, unknown> }
          : {}),
        ...(spec.uiHints || spec.displayName
          ? {
              uiHints: {
                ...((spec.uiHints as Record<string, unknown>) ?? {}),
                ...(typeof spec.displayName === "string"
                  ? { displayName: spec.displayName }
                  : {}),
              },
            }
          : {}),
        ...(typeof spec.required === "boolean"
          ? { required: spec.required }
          : {}),
        ...(spec.defaultValue !== undefined
          ? { defaultValue: spec.defaultValue }
          : {}),
        ...(typeof spec.displayOrder === "number"
          ? { displayOrder: spec.displayOrder }
          : {}),
        ...(spec.overlay === true ? { overlay: true } : {}),
        reasoning: `Field of kind '${input.slug}' defined via ${labels.door}`,
        ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      });
      properties.push({ slug: propSlug, ...propResult });
    } catch (err) {
      // One rejected field must not discard the fields that did land — the
      // caller gets a per-field ledger and can retry just the failures.
      properties.push({
        slug: propSlug,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, result: { ...result, properties } };
}
