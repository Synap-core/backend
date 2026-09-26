/**
 * Hub Protocol REST — /discover
 *
 * Single endpoint for AI agent session bootstrap. Returns entity profiles with
 * their property schemas, plus the canonical CLI command tree.
 *
 * Agents call this once per session instead of relying on static skill file
 * descriptions, which drift as custom profiles are added or changed.
 *
 * Tiers (measured live, 2026-09-14, 123-profile pod):
 *   ?summary=true  — slugs + displayNames + scopes + description + icon +
 *                     usage (`entityCount`, `lastActivityAt`, `rank`) +
 *                     `origin` per row, top-level `groups`, NO property
 *                     schemas. Rows are ORDERED BY USAGE RANK by default
 *                     (founder decision D1): the census found no consumer
 *                     that reads row position — Raycast / IS / CLI /
 *                     hub-rest-client all match by slug or id, and the prior
 *                     order was `profiles.id` (uuid), i.e. arbitrary.
 *                     `?sort=name` = alphabetical. Usage is read through the
 *                     ONE aggregate (`services/discover/usage-aggregate.ts`);
 *                     a failed read yields `usageError` + name order, never
 *                     zero counts. ~29.9KB full pod before the usage fields,
 *                     ~19.4KB scoped to one workspace lens. Call first.
 *   ?profileSlugs=task,person — full schemas only for named profiles. Use this
 *                     after the summary tier instead of loading every schema.
 *   (default)       — full property schemas + create commands for every
 *                     profile. ~203KB full pod. Expensive — prefer the two
 *                     tiers above.
 */

import { z } from "@hono/zod-openapi";
import {
  getDb,
  resolvePropertyLabel,
  resolvePropertyOptions,
} from "@synap/database";
import { listEffectiveRelationTypes } from "../../../utils/relation-types.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
import {
  loadProfileFill,
  type ProfileFill,
} from "../../../services/discover/usage-aggregate.js";
import {
  resolveProfileDescription,
  resolveProfileIcon,
} from "../../../utils/profile-presentation.js";
import { rankProfilesByUsage } from "../../../services/discover/profile-ranking.js";
import { PROFILE_ORIGINS } from "@synap/database/schema";

const DiscoverPropertySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  type: z
    .string()
    .describe(
      "valueType: string | number | boolean | date | entity_id | array | select"
    ),
  options: z
    .array(z.string())
    .optional()
    .describe("Valid values for select/enum types"),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  targetProfileSlug: z.string().optional(),
  schemaScope: z
    .enum(["base", "workspace"])
    .describe("base = global/profile definition; workspace = explicit overlay"),
  workspaceId: z.string().nullable().optional(),
  displayOrder: z
    .number()
    .optional()
    .describe(
      "The resolver's own field order (`compareEffectiveProperties`: base layer before overlay, then displayOrder, then slug). The projection dropped it until 2026-09-21, which is why no schema-derived form/projection could be built from this door."
    ),
  uiHints: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The stored `uiHints` blob (PropertyUIHints): placeholder, inputType, displayAs, format, includeTime, linkedProfileSlug, helpText, description, readOnly, … Emitted whole rather than cherry-picked — a per-key allowlist is exactly how `displayOrder` and most of this object went missing. Labels and options are NOT read from here; they come from the shared resolvers."
    ),
  fill: z
    .object({
      filled: z
        .number()
        .describe("Entities with a non-empty value for this property."),
      sampleSize: z
        .number()
        .describe(
          "Entities of this kind at this lens — the denominator. Counted over `entities` itself, so a property-less entity IS counted."
        ),
    })
    .optional()
    .describe(
      "TWO NUMBERS, never a ratio — the consumer divides. ABSENT = not requested (?fill=true) or unreadable: UNMEASURED. `sampleSize === 0` = the kind has no entities at this lens: UNMEASURABLE (new kind / cold start), NOT zero. `sampleSize > 0 && filled === 0` = a real measured zero. A `fillRate: number` collapses all three into `0`. This is a TIEBREAKER for ranking fields, never a gate — nothing filters a property out on it."
    ),
});

/**
 * Project ONE effective property def onto the wire shape above.
 *
 * Exported (and pure) so the schema-door ⇄ write-validator parity tripwire can
 * drive the REAL projection instead of hand-building its output — the seam is
 * the thing that broke, so the seam is what the guard must cross.
 *
 * `options` and `displayName` come from the ONE shared resolver
 * (`resolvePropertyOptions` / `resolvePropertyLabel`, `@synap/database`). Until
 * 2026-09-12 this block read `constraints.options` / `uiHints.options` /
 * `uiHints.displayName` — three keys nothing in this codebase writes — while
 * the seeds write `constraints.enum` and `uiHints.label`. The consequence was
 * measured on the live pod: the `options` field that `DiscoverPropertySchema`
 * documents as "Valid values for select/enum types" was ABSENT on every
 * property of every profile, and every `displayName` was the raw slug. An
 * agent read `decision`, saw `status` as a free string, wrote `"open"`, and was
 * rejected by a validator quoting an enum the door never showed it.
 *
 * The resolver reads the validator's key (`constraints.enum`) FIRST and keeps
 * the old spellings as fallbacks, so this is strictly widening: a custom def
 * already authored with `options` is unaffected.
 */
export function toDiscoverProperty(
  d: Record<string, unknown>,
  /**
   * Optional measured fill. OMIT it (not `{filled:0,sampleSize:0}`) when the
   * stat was not requested or could not be read — absence is the encoding of
   * UNMEASURED, and it must stay distinguishable from a measured zero.
   */
  fill?: { filled: number; sampleSize: number }
) {
  const constraints =
    d.constraints && typeof d.constraints === "object"
      ? (d.constraints as Record<string, unknown>)
      : undefined;
  const uiHints =
    d.uiHints && typeof d.uiHints === "object"
      ? (d.uiHints as Record<string, unknown>)
      : undefined;
  const options = resolvePropertyOptions(d);
  return {
    slug: String(d.slug),
    displayName: resolvePropertyLabel(d),
    type: String(d.valueType),
    ...(options?.length ? { options } : {}),
    required: d.required === true,
    ...(d.defaultValue !== undefined && d.defaultValue !== null
      ? { defaultValue: d.defaultValue }
      : {}),
    ...(constraints ? { constraints } : {}),
    ...(typeof uiHints?.linkedProfileSlug === "string"
      ? { targetProfileSlug: uiHints.linkedProfileSlug }
      : typeof constraints?.targetProfileSlug === "string"
        ? { targetProfileSlug: constraints.targetProfileSlug }
        : {}),
    schemaScope: (d.workspaceId ? "workspace" : "base") as "workspace" | "base",
    workspaceId: typeof d.workspaceId === "string" ? d.workspaceId : null,
    // RESTORED 2026-09-21. `displayOrder` and most of `uiHints` were resolved
    // by `getEffectiveProperties` and then dropped here — measured: 0 of 458
    // projected properties carried `displayOrder`. Without it a consumer has no
    // field order and no input hints, so no schema-derived form or projection
    // could be built from this door at all. Emitted WHOLE rather than
    // cherry-picked: a per-key allowlist is how they went missing.
    ...(typeof d.displayOrder === "number"
      ? { displayOrder: d.displayOrder }
      : {}),
    ...(uiHints && Object.keys(uiHints).length > 0 ? { uiHints } : {}),
    ...(fill ? { fill } : {}),
  };
}

/** What the profile schema door returns for one identifier. */
export type RowSchemaFetchResult = {
  profile?: { id?: unknown } | null;
  effectiveProperties?: Array<Record<string, unknown>>;
};

export type RowSchema =
  | {
      status: "resolved";
      effectiveProperties: Array<Record<string, unknown>>;
      /**
       * Set when this row's SLUG resolves to ANOTHER row at this lens, so it
       * was read by its own id. Its schema is honest — but a write naming the
       * type by slug (capture `profileSlug`, `create --profile`) lands on, and
       * is validated against, this other row. Measured live 2026-09-13: the
       * system `knowledge` row showed `knowledgeForm` required while a lens-less
       * capture validated against the Pod Admin twin's lone `knowledgeform`.
       */
      slugResolvesToProfileId?: string;
    }
  | { status: "unavailable"; resolvedProfileId: string };

/**
 * Resolve ONE listed profile row's schema by that row's OWN identity.
 *
 * ── The defect (measured live, 2026-09-12) ──────────────────────────────────
 * This handler used to fetch every row's schema BY SLUG and cache it BY ID.
 * Slugs are not unique (migration 0052: `unique(slug)` only for system+shared,
 * `unique(slug, workspace_id)` for workspace rows), and at the workspace-less
 * lens `getBySlug` ranks USER < WORKSPACE < SHARED < SYSTEM — so a workspace
 * twin OUTRANKS the system row. On the founder's pod, 5 of 122 listed slugs
 * are carried by two rows, and the system `knowledge` row was reported with
 * its twin's single property instead of its own six — under the system row's
 * own id and `visibility: "system"`. A caller could not tell it was being lied
 * to. (Every workspace lens was fine; only the unscoped lens was wrong.)
 *
 * ── Why slug first, then id — not id first ─────────────────────────────────
 * `resolveProfile` DOES accept an id, but its id path is STRICTER than its
 * slug path: `isAccessible` refuses `scope: "shared"` when there is no
 * workspace lens, while the slug path admits SHARED unconditionally. The same
 * pod lists 21 shared profiles at that lens, so switching to id-first would
 * have turned a wrong answer for 5 rows into a 500 for the whole request.
 * Slug-then-verify keeps every row that already resolved to itself (117 of
 * 122) on the path it was on, and pays the id lookup only for a twin.
 *
 * ── Why "unavailable" is a value, not an empty schema ──────────────────────
 * When the slug lands on another row AND the id path refuses this one, the
 * honest answer is "this door cannot describe this row at this lens" — never
 * the twin's properties under this row's identity, and never a silent `[]`
 * that reads as "this type has no properties". Only NOT_FOUND is classified;
 * any other failure propagates — including an answer that carries NO profile
 * identity, which is a broken door, not a twin (see `identityOf`).
 *
 * The id-path asymmetry itself lives in `profile-resolution-service.ts` and is
 * deliberately NOT changed here — it is an access decision owned elsewhere.
 */
/**
 * The id of the row the door actually resolved. An answer with no identity is a
 * CONTRACT VIOLATION, not a twin: classifying it as "another row won" would
 * withhold a schema for a reason that never happened and print a false hint.
 */
function identityOf(result: RowSchemaFetchResult, identifier: string): string {
  const id = result.profile?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `profiles.getProfile returned no profile identity for "${identifier}"`
    );
  }
  return id;
}

export async function resolveRowSchema(
  row: { id: string; slug: string },
  fetchProfile: (identifier: string) => Promise<RowSchemaFetchResult>
): Promise<RowSchema> {
  const bySlug = await fetchProfile(row.slug);
  const resolvedProfileId = identityOf(bySlug, row.slug);
  if (resolvedProfileId === row.id) {
    return {
      status: "resolved",
      effectiveProperties: bySlug.effectiveProperties ?? [],
    };
  }

  try {
    const byId = await fetchProfile(row.id);
    if (identityOf(byId, row.id) === row.id) {
      return {
        status: "resolved",
        effectiveProperties: byId.effectiveProperties ?? [],
        slugResolvesToProfileId: resolvedProfileId,
      };
    }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "NOT_FOUND") throw error;
  }
  return { status: "unavailable", resolvedProfileId };
}

/** Kind + Facets discriminator, surfaced on every profile-listing read. */
const ProfileKindSchema = z
  .enum(["kind", "role"])
  .describe(
    "kind = primary entity type (an entity IS one); role = attachable facet (an entity HAS one, via entity_facets)"
  );
const ApplicableKindsSchema = z
  .array(z.string())
  .nullable()
  .optional()
  .describe(
    "For profileKind='role': the kind slugs this role may attach to (null/absent = any kind)."
  );

const ProfileSlugListSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value
        .split(",")
        .map((slug) => slug.trim())
        .every((slug) => /^[a-z0-9][a-z0-9-]*$/.test(slug)),
    "profileSlugs must be a comma-separated list of profile slugs"
  )
  .refine(
    (value) => value.split(",").filter(Boolean).length <= 50,
    "profileSlugs supports at most 50 profiles per request"
  )
  .describe(
    "Comma-separated profile slugs to return with property schemas, e.g. task,person. Omit to load every profile schema."
  );

const DiscoverQuerySchema = z.object({
  userId: z.string().min(1),
  /** Omitted intentionally means the pod/base schema, never a default workspace. */
  workspaceId: z.string().uuid().optional(),
  summary: z.enum(["true", "false"]).optional(),
  profileSlugs: ProfileSlugListSchema.optional(),
  /**
   * Summary-tier row order. `usage` (default) = blended usage rank; `name` =
   * alphabetical by displayName. The full tier ignores it (listing order).
   */
  sort: z.enum(["usage", "name"]).optional(),
  /**
   * Opt-in: `origin` adds top-level `groups` (used / core / shared / per
   * workspace). Off by default — the summary tier is read straight into model
   * context (Raycast), and the rows already carry `rank` and `origin`.
   */
  groups: z.enum(["origin"]).optional(),
  /**
   * Opt-in: `true` measures how many entities of each kind carry a value for
   * each property, and emits `fill: { filled, sampleSize }` per property in the
   * full tier. Off by default — it is an extra aggregate per profile, and a
   * caller that does not ask must get ABSENCE (= unmeasured), never zeros.
   */
  fill: z.enum(["true", "false"]).optional(),
});

const ProfileOriginSchema = z
  .object({
    origin: z
      .enum(PROFILE_ORIGINS)
      .describe(
        "Stored provenance (profiles.origin): core | template | authored | agent | probe | unknown. `unknown` = not recorded; never guessed."
      ),
    group: z
      .enum(["core", "shared", "workspace", "unknown"])
      .describe(
        "Where discover lists it: core type, shared across workspaces, defined in `workspaceId`, or unknown."
      ),
    workspaceId: z.string().optional(),
    templateId: z.string().optional(),
    packageSlug: z.string().optional(),
  })
  .describe(
    "Provenance + placement. `templateId` / `packageSlug` = what the owning workspace was installed from, when recorded."
  );

const ProfileGroupSchema = z.object({
  key: z
    .string()
    .describe("`used`, `core`, `shared`, `workspace:<id>`, or `unknown`."),
  label: z.string(),
  profileIds: z
    .array(z.string())
    .describe("References `profiles[].id`; rows are never nested here."),
});

/**
 * Usage fields, added to every summary row. Absent together when the usage read
 * failed — the response then carries `usageError`, never zero counts.
 */
const DiscoverUsageFields = {
  entityCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Entities of this profile row you can see (the lens's workspaces + pod-scoped). Absent = not measured (see `usageError`), never 0."
    ),
  lastActivityAt: z.string().nullable().optional(),
  rank: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "1 = most used. One blended rank (entity count, recency, what you open) — the same one orient's startHere.topKinds uses."
    ),
  origin: ProfileOriginSchema.optional(),
};

/** Summary tier — lightweight, no property schemas; usage + origin per row. */
export const DiscoverProfileSummarySchema = z.object({
  ...DiscoverUsageFields,
  id: z
    .string()
    .describe(
      "This profile row's id. A slug can be held by more than one row, so the id is what tells two same-slug rows apart."
    ),
  slug: z.string(),
  displayName: z.string(),
  scope: z
    .enum(["pod", "workspace"])
    .describe(
      "PLACEMENT (from entityScope): pod = entities visible in all workspaces; workspace = scoped to one. NOTE: this is placement, not visibility — the who-can-see axis is `visibility`."
    ),
  visibility: z
    .enum(["system", "shared", "workspace", "user"])
    .optional()
    .describe(
      "VISIBILITY (from the profile's scope column): who can use this profile type. Distinct from `scope` above, which is placement."
    ),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  profileKind: ProfileKindSchema.optional(),
  applicableKinds: ApplicableKindsSchema,
});

/** Full tier — includes property schemas + create command. */
const DiscoverProfileSchema = z.object({
  id: z
    .string()
    .describe(
      "This profile row's id. A slug can be held by more than one row, so the id is what tells two same-slug rows apart."
    ),
  slug: z.string(),
  displayName: z.string(),
  scope: z
    .enum(["pod", "workspace"])
    .describe(
      "PLACEMENT (from entityScope): pod = entities visible in all workspaces; workspace = scoped to one. NOTE: this is placement, not visibility — the who-can-see axis is `visibility`."
    ),
  visibility: z
    .enum(["system", "shared", "workspace", "user"])
    .optional()
    .describe(
      "VISIBILITY (from the profile's scope column): who can use this profile type. Distinct from `scope` above, which is placement."
    ),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  profileKind: ProfileKindSchema.optional(),
  applicableKinds: ApplicableKindsSchema,
  properties: z.array(DiscoverPropertySchema),
  schemaUnavailable: z
    .object({
      reason: z.literal("slug-resolves-to-another-row"),
      resolvedProfileId: z.string(),
      hint: z.string(),
    })
    .optional()
    .describe(
      "Present when this row's schema could not be read by its own identity at this lens. `properties` is then EMPTY BY WITHHOLDING, not because the type has none."
    ),
  slugWritesTo: z
    .object({
      reason: z.literal("slug-resolves-to-another-row"),
      profileId: z.string(),
      hint: z.string(),
    })
    .optional()
    .describe(
      "Present when `properties` is this row's own schema but a write that names this slug at this lens lands on ANOTHER row (`profileId`) and is validated against that row's schema instead."
    ),
  createCommand: z
    .string()
    .optional()
    .describe(
      "Ready-to-run CLI command template for this profile. ABSENT when `schemaUnavailable` or `slugWritesTo` is set: a create command for a type whose schema this response could not show — or whose slug writes to another row — invites exactly the blind write those markers exist to prevent."
    ),
  /**
   * NOT populated on this FULL tier — the usage fields (`entityCount`,
   * `lastActivityAt`, `rank`, `origin`) ride on the SUMMARY tier, read through
   * the one aggregate (`services/discover/usage-aggregate.ts`). The full tier
   * is the per-write schema read (Raycast create/update call it with
   * `profileSlugs` before every write), so it does not pay for the aggregate.
   * Absent here means "not measured", never "0 entities".
   */
  entityCount: z.number().int().nonnegative().optional(),
});

/**
 * The relation types that resolve under the request's lens — the SAME read
 * `relations.create` rejects an unknown slug against, so `create_relation`
 * below can be filled from this list. Base layer (`workspaceId: null`) plus the
 * requested workspace's own defs.
 */
const DiscoverRelationTypeSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  isDirectional: z.boolean(),
  inverseLabel: z.string().nullable(),
  workspaceId: z.string().nullable(),
});

const DiscoverRelationTypeFields = {
  relationTypes: z.array(DiscoverRelationTypeSchema).optional(),
  /** Present INSTEAD of `relationTypes` when the read failed — never an empty list. */
  relationTypesError: z.string().optional(),
};

const DiscoverResponseSchema = z
  .object({
    ...DiscoverRelationTypeFields,
    profiles: z.array(DiscoverProfileSchema),
    commands: z.record(z.string(), z.string()),
    hint: z.string(),
  })
  .openapi("DiscoverResponse");

export const DiscoverSummaryResponseSchema = z
  .object({
    ...DiscoverRelationTypeFields,
    profiles: z.array(DiscoverProfileSummarySchema),
    /** The order `profiles` is in: `usage` (default) or `name`. */
    sort: z.enum(["usage", "name"]),
    groups: z.array(ProfileGroupSchema).optional(),
    /**
     * Present INSTEAD of the usage fields + `groups` when the usage read
     * failed. Rows are then in `name` order — never ranked on zero counts.
     */
    usageError: z.string().optional(),
    commands: z.record(z.string(), z.string()),
    hint: z.string(),
  })
  .openapi("DiscoverSummaryResponse");

export function registerDiscoverRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/discover",
    tags: ["System"],
    summary: "Runtime discovery — profiles + command tree",
    description:
      "Returns entity profiles with property schemas and the CLI command tree. " +
      "AI agents call this once at session start for ground-truth schema instead of relying on static skill descriptions. " +
      "Pass ?summary=true for a lighter tier (no property schemas; rows ranked by usage with entityCount / lastActivityAt / rank / origin; ?sort=name for alphabetical; ?groups=origin adds top-level groups), then pass ?profileSlugs=task,person to load schemas only for the profiles you need.",
    request: { query: DiscoverQuerySchema },
    responses: {
      200: { description: "Discovery payload", schema: DiscoverResponseSchema },
      400: { description: "Invalid query param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/discover", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const query = DiscoverQuerySchema.safeParse({
      userId: c.req.query("userId"),
      workspaceId: c.req.query("workspaceId"),
      summary: c.req.query("summary"),
      profileSlugs: c.req.query("profileSlugs"),
      sort: c.req.query("sort"),
      groups: c.req.query("groups"),
      fill: c.req.query("fill"),
    });
    if (!query.success) {
      return c.json(
        {
          error:
            "userId is required; workspaceId is optional, profileSlugs must be a comma-separated list of profile slugs when supplied, sort must be usage or name, and groups must be origin",
        },
        400
      );
    }
    const { userId, workspaceId, profileSlugs } = query.data;
    const summary = query.data.summary === "true";
    const wantsFill = query.data.fill === "true";
    const selectedSlugs = profileSlugs
      ? [...new Set(profileSlugs.split(",").map((slug) => slug.trim()))]
      : undefined;

    try {
      const caller = await getCaller(c, { userId, workspaceId });

      const profilesRaw = await caller.profiles.listProfiles({
        userId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(selectedSlugs ? { profileSlugs: selectedSlugs } : {}),
      });

      // tRPC returns wrapped shapes: { profiles: [...] } and { propertyDefs: [...] }
      const profiles = (Array.isArray(profilesRaw)
        ? profilesRaw
        : ((profilesRaw as unknown as { profiles: unknown[] }).profiles ??
          [])) as unknown as {
        id: string;
        slug: string;
        displayName: string;
        description?: string | null;
        entityScope?: string;
        // Visibility axis (who can use the type) — distinct from entityScope
        // (placement), which feeds discover's `scope` field.
        scope?: string | null;
        // The owning workspace for a workspace-scoped row — what `origin` names.
        workspaceId?: string | null;
        // Stored provenance (`profiles.origin`, PROFILE_ORIGINS).
        origin?: string | null;
        icon?: string | null;
        uiHints?: unknown;
        profileKind?: "kind" | "role";
        applicableKinds?: string[] | null;
      }[];

      const selectedProfiles = selectedSlugs
        ? profiles.filter((profile) => selectedSlugs.includes(profile.slug))
        : profiles;

      // Relation vocabulary for this lens. A failed read is surfaced as
      // `relationTypesError`, never folded into an empty list.
      const relationTypes = await getDb()
        .then((database) =>
          listEffectiveRelationTypes(database, workspaceId ?? null)
        )
        .then(
          (types) => ({ relationTypes: types }),
          (err: unknown) => {
            logger.error({ err }, "discover: relation types read failed");
            return {
              relationTypesError: `Relation types could not be read: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        );

      // ── Summary tier: slugs + displayNames + scopes + description + icon +
      // usage (entityCount / lastActivityAt / rank) + origin, no property
      // schemas. Rows are ranked by usage unless ?sort=name. ──
      if (summary) {
        const sort = query.data.sort ?? "usage";
        const baseRow = (p: (typeof selectedProfiles)[number]) => ({
          id: p.id,
          slug: p.slug,
          displayName: p.displayName,
          scope: (p.entityScope === "workspace" ? "workspace" : "pod") as
            "pod" | "workspace",
          visibility: (p.scope ?? undefined) as
            "system" | "shared" | "workspace" | "user" | undefined,
          description: resolveProfileDescription(p),
          icon: resolveProfileIcon(p),
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
        });
        const byName = (
          a: { displayName: string },
          b: { displayName: string }
        ) => a.displayName.localeCompare(b.displayName);

        // Usage is floored on the AUTHENTICATED owner — `c.get("userId")`, the
        // same identity `getCaller` lists profiles as — never the query's
        // legacy `userId`, which would let a key rank another user's data.
        // A failed read is reported as `usageError`; rows then fall back to
        // name order WITHOUT usage fields, never ranked on invented zeros.
        let ranking:
          Awaited<ReturnType<typeof rankProfilesByUsage>> | undefined;
        let usageError: string | undefined;
        try {
          ranking = await rankProfilesByUsage({
            userId: c.get("userId") as string,
            workspaceId,
            profiles: selectedProfiles,
          });
        } catch (err) {
          logger.error({ err }, "discover: usage read failed");
          // The cause is logged above; the client gets a stable, non-leaking message.
          usageError = "Usage could not be read; rows are in name order.";
        }

        const summaryProfiles = ranking
          ? ranking.ranked.map((r) => ({
              ...baseRow(r.profile as (typeof selectedProfiles)[number]),
              entityCount: r.entityCount,
              // Compact: omitted when the kind has no activity at all.
              ...(r.lastActivityAt ? { lastActivityAt: r.lastActivityAt } : {}),
              rank: r.rank,
              origin: r.origin,
            }))
          : selectedProfiles.map(baseRow);
        if (!ranking || sort === "name") summaryProfiles.sort(byName);

        return c.json({
          profiles: summaryProfiles,
          sort: ranking ? sort : "name",
          ...(!ranking
            ? { usageError }
            : query.data.groups === "origin"
              ? { groups: ranking.groups }
              : {}),
          ...relationTypes,
          commands: {
            discover: "synap discover --json",
            orient: "synap orient --json",
          },
          hint: "Summary tier — no property schemas; rows ranked by use (rank 1 = most used; ?sort=name for alphabetical; ?groups=origin adds groups that reference rows by id). Call /discover?profileSlugs=task,person for full property detail + create commands only for the profiles you intend to use.",
        });
      }

      // ── Full tier: effective schemas + create commands ──
      // Read each selected profile through the SAME resolution service used by
      // validation. This includes inherited required/default metadata and only
      // the explicit workspace's overlays. An absent workspace is the base
      // lens, not an unfiltered/admin read.
      const schemaByProfileId = new Map<string, RowSchema>();
      await Promise.all(
        selectedProfiles.map(async (profile) => {
          schemaByProfileId.set(
            profile.id,
            await resolveRowSchema(
              profile,
              async (identifier) =>
                (await caller.profiles.getProfile({
                  userId,
                  ...(workspaceId ? { workspaceId } : {}),
                  identifier,
                })) as unknown as RowSchemaFetchResult
            )
          );
        })
      );

      // Opt-in fill, measured through THE aggregate (`loadProfileFill` →
      // `loadEntityUsage` + `loadPropertyFill`, one owner-private floor).
      // A FAILED read leaves the profile OUT of this map, so its properties
      // carry no `fill` key at all — unmeasured, never a fabricated zero.
      const fillByProfileId = new Map<string, ProfileFill>();
      if (wantsFill) {
        const accessible = await getUserAccessibleWorkspaceIds(userId);
        const lens = workspaceId
          ? accessible.filter((id) => id === workspaceId)
          : accessible;
        await Promise.all(
          selectedProfiles.map(async (p) => {
            try {
              fillByProfileId.set(
                p.id,
                await loadProfileFill({
                  userId,
                  profileId: p.id,
                  ...(workspaceId ? { workspaceId } : {}),
                  workspaceIds: lens,
                })
              );
            } catch (err) {
              logger.error(
                { err, profileId: p.id },
                "discover: property fill read failed"
              );
            }
          })
        );
      }

      const discoveredProfiles = selectedProfiles.map((p) => {
        const rowSchema = schemaByProfileId.get(p.id);
        const defs =
          rowSchema?.status === "resolved" ? rowSchema.effectiveProperties : [];
        const profileFill = fillByProfileId.get(p.id);
        const properties = defs.map((d) =>
          toDiscoverProperty(
            d,
            profileFill
              ? {
                  // A key nobody has filled has no group in the lateral — read
                  // as 0, which is only safe because sampleSize is independent.
                  filled: profileFill.filledBySlug.get(String(d.slug)) ?? 0,
                  sampleSize: profileFill.sampleSize,
                }
              : undefined
          )
        );

        const propExample =
          properties.length > 0
            ? ` --props '{"${properties[0].slug}":"value"}'`
            : "";
        const slugWritesToProfileId =
          rowSchema?.status === "resolved"
            ? rowSchema.slugResolvesToProfileId
            : undefined;
        return {
          id: p.id,
          slug: p.slug,
          displayName: p.displayName,
          scope: (p.entityScope === "workspace" ? "workspace" : "pod") as
            "pod" | "workspace",
          visibility: (p.scope ?? undefined) as
            "system" | "shared" | "workspace" | "user" | undefined,
          description: resolveProfileDescription(p),
          icon: resolveProfileIcon(p),
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
          properties,
          ...(rowSchema?.status === "unavailable"
            ? {
                schemaUnavailable: {
                  reason: "slug-resolves-to-another-row" as const,
                  resolvedProfileId: rowSchema.resolvedProfileId,
                  hint: "Another profile row (resolvedProfileId) wins this slug at this lens, and this row could not be read by its own id here, so its properties are withheld instead of being shown from that other row. Do not create entities of this type from this response. If this profile is shared with a workspace, a request with that workspaceId may be able to read it.",
                },
              }
            : {}),
          ...(slugWritesToProfileId
            ? {
                slugWritesTo: {
                  reason: "slug-resolves-to-another-row" as const,
                  profileId: slugWritesToProfileId,
                  hint: "These properties are this row's own, but a write that names this slug at this lens (capture `profileSlug`, `synap create entity --profile`) lands on profile `profileId` and is validated against ITS schema. Pass a workspaceId whose lens resolves this slug to this row before writing this type.",
                },
              }
            : {}),
          // Withheld row, or a slug that writes elsewhere ⇒ no create command:
          // handing an agent a ready-to-run create that cannot land on the
          // schema shown is the blind write both markers exist to prevent.
          ...(rowSchema?.status === "unavailable" || slugWritesToProfileId
            ? {}
            : {
                createCommand: `synap create entity --profile ${p.slug} --name "<title>"${propExample} --json`,
              }),
        };
      });

      return c.json({
        profiles: discoveredProfiles,
        ...relationTypes,
        commands: {
          discover: "synap discover --json",
          orient: "synap orient --json",
          create_entity:
            'synap create entity --profile <slug> --name <title> [--props \'{"key":"value"}\'] --json',
          get_entity: "synap get entity <id> --json",
          list_entities:
            "synap list entities [--profile <slug>] [--workspace <id>] --json",
          update_entity:
            'synap set entity <id> --props \'{"key":"value"}\' --json',
          search:
            "synap search <query> [--type entity|doc] [--workspace <id>] --json",
          remember: "synap remember <fact> --json",
          recall:
            "synap recall <query> [--structured] [--type gotcha|lesson|decision|reference] --json",
          capture:
            "synap capture --type <gotcha|lesson|decision|reference> --claim <text> [--why <text>] [--tags <csv>] --json",
          list_workspaces: "synap list workspaces --json",
          create_relation:
            "synap create relation --source <id> --target <id> --type <relationTypes[].slug> --json",
        },
        hint: "Use `createCommand` per profile as a template. Start with `summary=true`, then pass `profileSlugs` for only the schemas you need. Call `synap discover --profiles` to see only profiles, `--commands` for only the command tree.",
      });
    } catch (err) {
      logger.error({ err }, "discover failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
