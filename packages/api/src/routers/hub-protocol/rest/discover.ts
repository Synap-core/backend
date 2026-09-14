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
 *   ?summary=true  — slugs + displayNames + scopes + description + icon, NO
 *                     property schemas and NO entityCount (that field is
 *                     declared on the wire but not yet populated by this
 *                     route — see `entityCount` below). ~29.9KB full pod,
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
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";
import {
  resolveProfileDescription,
  resolveProfileIcon,
} from "../../../utils/profile-presentation.js";

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
export function toDiscoverProperty(d: Record<string, unknown>) {
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
});

/** Summary tier — lightweight, no property schemas, no entity counts. */
export const DiscoverProfileSummarySchema = z.object({
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
   * NOT YET POPULATED by this route (measured live 2026-09-14: absent on every
   * profile). Left in the wire schema for the planned P1 consolidation of the
   * three duplicate entity-count GROUP BYs (orient's `discover.ts`, MCP
   * `buildGrounding` in `http-handler.ts`, `diagnose/workspace.ts`) into one
   * source this route can then read. Do not read this field as "0 entities" —
   * it means "not measured", not "empty".
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
      "Pass ?summary=true for a lighter tier (~30KB on a 123-profile pod; no property schemas, no entityCount), then pass ?profileSlugs=task,person to load schemas only for the profiles you need.",
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
    });
    if (!query.success) {
      return c.json(
        {
          error:
            "userId is required; workspaceId is optional and profileSlugs must be a comma-separated list of profile slugs when supplied",
        },
        400
      );
    }
    const { userId, workspaceId, profileSlugs } = query.data;
    const summary = query.data.summary === "true";
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

      // ── Summary tier: slugs + displayNames + scopes + description + icon,
      // no property schemas, no entityCount (~30KB on a 123-profile pod) ──
      if (summary) {
        const summaryProfiles = selectedProfiles.map((p) => ({
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
        }));

        return c.json({
          profiles: summaryProfiles,
          ...relationTypes,
          commands: {
            discover: "synap discover --json",
            orient: "synap orient --json",
          },
          hint: "Summary tier — no property schemas. Call /discover?profileSlugs=task,person for full property detail + create commands only for the profiles you intend to use.",
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

      const discoveredProfiles = selectedProfiles.map((p) => {
        const rowSchema = schemaByProfileId.get(p.id);
        const defs =
          rowSchema?.status === "resolved" ? rowSchema.effectiveProperties : [];
        const properties = defs.map(toDiscoverProperty);

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
        500
      );
    }
  });
}
