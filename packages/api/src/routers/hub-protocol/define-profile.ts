/**
 * The ONE define-kind / define-role door shared by every agent surface.
 *
 * MCP `synap_define_kind` / `synap_define_role` and Hub REST `POST /profiles`
 * all land here, so the mapping from a door's arguments onto the governed hub
 * `profiles.createProfile` (+ ONE `createPropertyDefs` for its fields) exists
 * once.
 * Before this, the mapping lived inline in the MCP handler and REST had no way
 * to express a role, an entity scope, or fields at all.
 *
 * Governance is NOT decided here: `profiles.createProfile` → `profiles.create`
 * runs `checkPermissionOrPropose`, and an agent structure write floors to a
 * proposal there. This file only shapes the input and the per-field ledger.
 */

import {
  PropertyValueType,
  slugifyPropertyKey,
  db,
  ProfileResolutionService,
  addEnumOptionRefusal,
  normalizeEnumOptions,
  readStoredEnum,
  withAddedEnumOption,
  type EffectiveProperty,
} from "@synap/database";

import type { ProposedKindField } from "../../services/profiles/proposed-kind-field.js";

import type { HubProtocolCaller } from "./rest/_shared.js";
import { withReviewUrl } from "./proposal-response.js";

const PROPERTY_VALUE_TYPES: string[] = Object.values(PropertyValueType);

/** Convenience default when the caller names none on CREATE — NOT a model
 *  limit. Roles attach to ANY kind; pass applicableKinds: ["item"] etc. */
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

/** One caller slug the door stored under a different spelling. */
export interface SlugNormalization {
  from: string;
  to: string;
  of: "kind" | "role" | "field";
}

/**
 * Every slug this call rewrites, the kind's AND every field's, computed BEFORE
 * any write so the FIRST result states them — including the call whose fields
 * are deferred behind the kind's review. Learned the hard way (ticket
 * a375443d): `social_account_audit` was stored as `social-account-audit` and
 * `botScore` as `botscore` with no word on the first call, and a code skill
 * approved against the requested names wrote to fields that do not exist.
 */
export function slugNormalizations(
  profileSlug: { from: string; to: string; of: "kind" | "role" },
  fields: ReadonlyArray<Record<string, unknown>>
): SlugNormalization[] {
  const out: SlugNormalization[] = [];
  if (profileSlug.from !== profileSlug.to) out.push(profileSlug);
  for (const spec of fields) {
    if (typeof spec.slug !== "string") continue;
    const to = slugifyPropertyKey(spec.slug) || spec.slug;
    if (to !== spec.slug) out.push({ from: spec.slug, to, of: "field" });
  }
  return out;
}

/** The result keys that announce the rewrites — FIRST in the result, so the
 *  tool text leads with them. Empty when nothing was rewritten. */
function normalizationNotice(
  list: SlugNormalization[]
): { notice: string; normalized: SlugNormalization[] } | Record<never, never> {
  if (list.length === 0) return {};
  return {
    notice: `Slugs were normalised (lowercase, words joined by "-"). Use the STORED slugs in code, skills and later calls: ${list
      .map((n) => `${n.from} → ${n.to} (${n.of})`)
      .join(", ")}.`,
    normalized: list,
  };
}

/**
 * One caller field spec, checked and normalised ONCE — read by both the
 * applied path (one `createPropertyDefs` batch) and the proposed path (the
 * valid ones ride the kind's proposal as `deferredFields`). An invalid spec
 * becomes its ledger entry, never a write.
 */
function checkFieldSpec(
  spec: Record<string, unknown>
):
  | { field: ProposedKindField; normalized: { normalizedFrom?: string } }
  | { entry: Record<string, unknown> } {
  const declaredSlug = typeof spec.slug === "string" ? spec.slug : undefined;
  // Same ONE normalisation as the profile slug.
  const propSlug = declaredSlug
    ? slugifyPropertyKey(declaredSlug) || declaredSlug
    : undefined;
  const normalized: { normalizedFrom?: string } =
    propSlug && declaredSlug && propSlug !== declaredSlug
      ? { normalizedFrom: declaredSlug }
      : {};
  const valueType =
    typeof spec.valueType === "string" ? spec.valueType : undefined;
  if (!propSlug || !valueType) {
    return {
      entry: {
        slug: propSlug ?? null,
        ...normalized,
        status: "error",
        error: "Each property requires `slug` and `valueType`.",
      },
    };
  }
  // The hub door types valueType as `z.string()` and then casts it onto the
  // `property_defs.value_type` PG enum, so an unknown string fails at INSERT
  // time with a Postgres error the agent cannot act on.
  if (!PROPERTY_VALUE_TYPES.includes(valueType)) {
    return {
      entry: {
        slug: propSlug,
        ...normalized,
        status: "error",
        error: `Unsupported valueType '${valueType}'. Valid: ${PROPERTY_VALUE_TYPES.join(", ")}.`,
      },
    };
  }
  const uiHints =
    spec.uiHints || typeof spec.displayName === "string"
      ? {
          ...((spec.uiHints as Record<string, unknown>) ?? {}),
          ...(typeof spec.displayName === "string"
            ? { displayName: spec.displayName }
            : {}),
        }
      : undefined;
  return {
    normalized,
    field: {
      slug: propSlug,
      valueType,
      ...(spec.constraints
        ? { constraints: spec.constraints as Record<string, unknown> }
        : {}),
      ...(uiHints ? { uiHints } : {}),
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
    },
  };
}

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

  // ONE normalisation for every caller-supplied slug on this door — the SAME
  // `slugifyPropertyKey` the approve-side reconciliation uses, never a second
  // table. Before this, a key was slugified by the reconciliation door
  // (`ek_type` → `ek-type`, its label kept) and HARD-REJECTED here by the
  // `/^[a-z0-9-]+$/` zod downstream: one product, two answers for one input.
  // `|| raw` keeps a slug that slugifies to nothing (`"!!!"`) reaching the
  // validator, so it still fails loudly instead of becoming "".
  const profileSlug = slugifyPropertyKey(input.slug) || input.slug;
  const fieldSpecs = (input.fields ?? []) as Array<Record<string, unknown>>;
  const announced = normalizationNotice(
    slugNormalizations(
      {
        from: input.slug,
        to: profileSlug,
        of: input.profileKind === "role" ? "role" : "kind",
      },
      fieldSpecs
    )
  );

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

  // Checked BEFORE the create, so the valid fields can ride the kind's
  // proposal (`deferredFields`): one approval creates the kind AND them, and
  // the author never re-calls (ticket a375443d — 16 proposals, one per field,
  // then the agent's proposal limit). The direct path ignores them and adds
  // them below through ONE `createPropertyDefs`.
  const checkedFields = fieldSpecs.map(checkFieldSpec);
  const carried = checkedFields.flatMap((c) => ("field" in c ? [c.field] : []));
  const refusedFields = checkedFields.flatMap((c) =>
    "entry" in c ? [c.entry] : []
  );
  const reasoning =
    carried.length > 0
      ? `${input.reasoning ?? `Defined via ${labels.door}`} Fields: ${carried
          .map((f) => `${f.slug} (${f.valueType})`)
          .join(", ")}.`
      : input.reasoning;

  const result = (await caller.profiles.createProfile({
    userId: input.userId,
    workspaceId: input.workspaceId,
    slug: profileSlug,
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
    ...(reasoning ? { reasoning } : {}),
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    ...(carried.length > 0 ? { deferredFields: carried } : {}),
  })) as unknown as Record<string, unknown>;

  // Governance gated the profile itself → there is no profileId to hang fields
  // on. A NEW kind carries its valid fields in its own proposal
  // (`fieldsIncluded`); a gated change to an EXISTING kind does not, and its
  // fields stay deferred to a re-call. Never half-applies a schema.
  if (result && result.status === "proposed") {
    const included =
      typeof result.fieldsIncluded === "number" ? result.fieldsIncluded : 0;
    // ONE proposal shape: `profiles.createProfile` drops the gate's
    // `reviewUrl`, so fill it here from the shared `/open/<id>` builder — the
    // agent must be able to show the review link (see proposal-response.ts).
    return {
      ok: true,
      result: withReviewUrl({
        ...announced,
        ...result,
        ...(included > 0
          ? {
              properties: {
                status: "included",
                message: `These ${included} field(s) ride the kind's proposal: approving it creates the kind AND them. Do not re-call ${labels.door} for them.`,
                included: carried.map((f) => f.slug),
                ...(refusedFields.length > 0 ? { refused: refusedFields } : {}),
              },
            }
          : fieldSpecs.length > 0
            ? {
                properties: {
                  status: "deferred",
                  message: `The kind itself is awaiting review. Re-call ${labels.door} with the same slug once the proposal is approved to add these fields (the call is slug-idempotent: it ADDS fields that do not exist yet and reports \`status: "unchanged"\` for any slug that already does — it never rewrites a stored definition).`,
                  pending: fieldSpecs.length,
                },
              }
            : {}),
      }),
    };
  }

  const createdProfile = result?.profile as
    | { id?: string; scope?: string; profileKind?: string | null }
    | null
    | undefined;
  const profileId = createdProfile?.id;
  if (fieldSpecs.length === 0 || !profileId) {
    return { ok: true, result: { ...announced, ...result } };
  }
  // W2b ROLE PRINCIPLE: re-declaring an EXISTING pod-wide role from a
  // workspace ADDS that workspace's fields as OVERLAYS — the shared role's
  // base schema is every workspace's, so one domain must not widen it for all.
  const overlayOnSharedRole =
    result?.existing === true &&
    createdProfile?.profileKind === "role" &&
    (createdProfile?.scope === "shared" || createdProfile?.scope === "system");

  // The kind's fields as the caller's space sees them, for a re-declared
  // field that GROWS its allowed values (option C, below).
  // Read only when a re-declared field names a closed set: nothing else on
  // this path needs the stored schema.
  const declaresOptions = carried.some(
    (field) =>
      declaredOptionKeys(
        field.constraints as Record<string, unknown> | undefined
      ) !== undefined
  );
  const storedFields: EffectiveProperty[] =
    result?.existing === true && declaresOptions
      ? await new ProfileResolutionService(db).getEffectiveProperties(
          profileId,
          input.workspaceId
        )
      : [];

  const outcomeBySlug = new Map<string, Record<string, unknown>>();
  // A field that already exists and grows its allowed values goes through the
  // property-def EDIT door, field by field; it never rides the create batch.
  for (const field of carried) {
    try {
      const grown = await growFieldOptions(
        caller,
        input,
        // The define door normalises a slug (`uo_category` → `uo-category`);
        // a field seeded with the other spelling is still the same field.
        storedFields.find(
          (p) =>
            p.slug === field.slug || slugifyPropertyKey(p.slug) === field.slug
        ),
        field
      );
      if (grown) outcomeBySlug.set(field.slug, grown);
    } catch (err) {
      outcomeBySlug.set(field.slug, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ONE call for every other valid field (ticket a375443d): on an existing
  // kind an agent's N fields used to file N proposals, and ran into its
  // proposal limit. The batch door gates once — granted, each field applies
  // with its own receipt; proposed, one proposal the owner approves once.
  const toCreate = carried
    .filter((field) => !outcomeBySlug.has(field.slug))
    .map((field) =>
      field.overlay !== true && overlayOnSharedRole
        ? { ...field, overlay: true }
        : field
    );
  let fieldsProposal: Record<string, unknown> | undefined;
  if (toCreate.length > 0) {
    try {
      const batch = (await caller.profiles.createPropertyDefs({
        userId: input.userId,
        workspaceId: input.workspaceId,
        profileId,
        profileName: input.displayName,
        fields: toCreate,
        reasoning:
          input.reasoning ??
          `Fields of kind '${profileSlug}' defined via ${labels.door}`,
        ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      })) as {
        status: string;
        proposalId?: string | null;
        properties?: Array<Record<string, unknown>>;
      };
      if (batch.status === "proposed" && batch.proposalId) {
        fieldsProposal = withReviewUrl({
          status: "proposed",
          proposalId: batch.proposalId,
          message: `These ${toCreate.length} field(s) are ONE proposal: approving it adds them all. Do not re-call ${labels.door} for them.`,
        });
        for (const field of toCreate) {
          outcomeBySlug.set(field.slug, {
            status: "proposed",
            proposalId: batch.proposalId,
          });
        }
      } else {
        for (const entry of batch.properties ?? []) {
          const { slug, ...rest } = entry;
          if (typeof slug === "string") outcomeBySlug.set(slug, rest);
        }
      }
    } catch (err) {
      // The ONE gate refused the batch (or it was malformed): every field
      // says so, and the caller can retry them together.
      const error = err instanceof Error ? err.message : String(err);
      for (const field of toCreate) {
        outcomeBySlug.set(field.slug, { status: "error", error });
      }
    }
  }

  // The per-field ledger, in the caller's order.
  const properties: Array<Record<string, unknown>> = checkedFields.map(
    (checked) =>
      "entry" in checked
        ? checked.entry
        : {
            slug: checked.field.slug,
            ...checked.normalized,
            ...(outcomeBySlug.get(checked.field.slug) ?? {
              status: "error",
              error: "No outcome was reported for this field.",
            }),
          }
  );

  return {
    ok: true,
    result: {
      ...announced,
      ...result,
      ...(fieldsProposal ? { fieldsProposal } : {}),
      properties,
    },
  };
}

/** The keys a declared field's closed set names, in either spelling. */
function declaredOptionKeys(
  constraints: Record<string, unknown> | undefined
): string[] | undefined {
  const objects = normalizeEnumOptions(constraints?.enumOptions);
  if (objects) return objects.map((o) => o.key);
  return Array.isArray(constraints?.enum)
    ? constraints.enum.filter((v): v is string => typeof v === "string")
    : undefined;
}

/**
 * A field that ALREADY EXISTS, re-declared with MORE allowed values: the new
 * values are added through the property-def EDIT door (governed: an agent
 * gets a proposal), each judged by the one rule `addEnumOptionRefusal` —
 * never on the kind's lifecycle, never one typo away from an allowed value
 * (option C, decision fa6c8833). This is the door the write-time refusal of a
 * value points an agent to when no allowed value fits.
 *
 * Anything else about an existing field is left as it was (this door never
 * rewrites a stored definition): `null` hands it to the create door, which
 * reports `unchanged` and names the edit door. A declaration that also DROPS
 * a value is not a growth and is handed over the same way.
 */
async function growFieldOptions(
  caller: ProfilesCaller,
  input: DefineProfileInput,
  stored: EffectiveProperty | undefined,
  field: ProposedKindField
): Promise<Record<string, unknown> | null> {
  if (!stored) return null;
  const declared = declaredOptionKeys(
    field.constraints as Record<string, unknown> | undefined
  );
  const storedKeys = readStoredEnum({
    constraints: stored.constraints as Record<string, unknown> | null,
    uiHints: stored.uiHints as Record<string, unknown> | null,
  });
  if (!declared || !storedKeys) return null;
  if (storedKeys.some((k) => !declared.includes(k))) return null;
  const added = declared.filter((v) => !storedKeys.includes(v));
  if (added.length === 0) return null;

  const refused: Array<{ value: string; reason: string; closest?: string }> =
    [];
  let constraints = stored.constraints as Record<string, unknown> | null;
  const accepted: string[] = [];
  for (const value of added) {
    const refusal = addEnumOptionRefusal(
      {
        constraints,
        uiHints: stored.uiHints as Record<string, unknown> | null,
        isLifecycle: stored.isLifecycle,
      },
      value
    );
    if (refusal) {
      refused.push({
        value,
        reason: refusal.refusal,
        ...(refusal.closest ? { closest: refusal.closest } : {}),
      });
      continue;
    }
    constraints = withAddedEnumOption(constraints, value);
    accepted.push(value);
  }
  const refusedNote =
    refused.length > 0
      ? ` Not added: ${refused
          .map((r) =>
            r.reason === "close_match"
              ? `'${r.value}' (use '${r.closest}', already allowed)`
              : r.reason === "lifecycle"
                ? `'${r.value}' (this field is the kind's status: design statuses on the kind)`
                : `'${r.value}'`
          )
          .join(", ")}.`
      : "";
  if (accepted.length === 0) {
    return {
      status: "unchanged",
      optionsRefused: refused,
      message: `No value was added to '${field.slug}'.${refusedNote}`,
    };
  }
  const res = (await caller.profiles.updatePropertyDef({
    userId: input.userId,
    workspaceId: input.workspaceId,
    propertyDefId: stored.id,
    constraints: constraints ?? {},
    reasoning: `Add ${accepted.map((v) => `'${v}'`).join(", ")} to the allowed values of '${field.slug}'.`,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
  })) as Record<string, unknown>;
  return withReviewUrl({
    ...res,
    optionsAdded: accepted,
    ...(refused.length > 0 ? { optionsRefused: refused } : {}),
    message:
      (res.status === "proposed"
        ? `Adding ${accepted.map((v) => `'${v}'`).join(", ")} to '${field.slug}' is waiting for review.`
        : `Added ${accepted.map((v) => `'${v}'`).join(", ")} to '${field.slug}'.`) +
      refusedNote,
  });
}
