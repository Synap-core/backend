/**
 * Hub Protocol REST — /discover
 *
 * Single endpoint for AI agent session bootstrap. Returns entity profiles with
 * their property schemas, plus the canonical CLI command tree.
 *
 * Agents call this once per session instead of relying on static skill file
 * descriptions, which drift as custom profiles are added or changed.
 *
 * Tiers:
 *   ?summary=true  — slugs + displayNames + scopes + entityCounts. ~2KB. Call first.
 *   ?profileSlugs=task,person — full schemas only for named profiles. Use this
 *                     after the summary tier instead of loading every schema.
 *   (default)       — full property schemas + create commands for every profile.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

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
});

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
  workspaceId: z.string().uuid(),
  summary: z.enum(["true", "false"]).optional(),
  profileSlugs: ProfileSlugListSchema.optional(),
});

/** Summary tier — lightweight, no property schemas, no entity counts. */
export const DiscoverProfileSummarySchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  scope: z
    .enum(["pod", "workspace"])
    .describe("pod = visible in all workspaces; workspace = scoped to one"),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  profileKind: ProfileKindSchema.optional(),
  applicableKinds: ApplicableKindsSchema,
});

/** Full tier — includes property schemas + create command. */
const DiscoverProfileSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  scope: z
    .enum(["pod", "workspace"])
    .describe("pod = visible in all workspaces; workspace = scoped to one"),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  profileKind: ProfileKindSchema.optional(),
  applicableKinds: ApplicableKindsSchema,
  properties: z.array(DiscoverPropertySchema),
  createCommand: z
    .string()
    .describe("Ready-to-run CLI command template for this profile"),
  entityCount: z.number().int().nonnegative().optional(),
});

const DiscoverResponseSchema = z
  .object({
    profiles: z.array(DiscoverProfileSchema),
    commands: z.record(z.string(), z.string()),
    hint: z.string(),
  })
  .openapi("DiscoverResponse");

export const DiscoverSummaryResponseSchema = z
  .object({
    profiles: z.array(DiscoverProfileSummarySchema),
    commands: z.record(z.string(), z.string()),
    hint: z.string(),
  })
  .openapi("DiscoverSummaryResponse");

type PropertyDef = {
  id: string;
  profileId?: string | null;
  slug: string;
  valueType: string;
  constraints?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
};

export function registerDiscoverRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/discover",
    tags: ["System"],
    summary: "Runtime discovery — profiles + command tree",
    description:
      "Returns entity profiles with property schemas and the CLI command tree. " +
      "AI agents call this once at session start for ground-truth schema instead of relying on static skill descriptions. " +
      "Pass ?summary=true for a lightweight (~2KB) tier with no property schemas, then pass ?profileSlugs=task,person to load schemas only for the profiles you need.",
    request: { query: DiscoverQuerySchema },
    responses: {
      200: { description: "Discovery payload", schema: DiscoverResponseSchema },
      400: { description: "Missing required query param", schema: ErrorSchema },
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
            "userId and workspaceId are required; profileSlugs must be a comma-separated list of profile slugs when supplied",
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
        workspaceId,
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
        icon?: string | null;
        profileKind?: "kind" | "role";
        applicableKinds?: string[] | null;
      }[];

      const selectedProfiles = selectedSlugs
        ? profiles.filter((profile) => selectedSlugs.includes(profile.slug))
        : profiles;

      // ── Summary tier: slugs + displayNames + scopes only (~2KB) ──
      if (summary) {
        const summaryProfiles = selectedProfiles.map((p) => ({
          slug: p.slug,
          displayName: p.displayName,
          scope: (p.entityScope ?? "workspace") as "pod" | "workspace",
          description: p.description ?? null,
          icon: p.icon ?? null,
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
        }));

        return c.json({
          profiles: summaryProfiles,
          commands: {
            discover: "synap discover --json",
            orient: "synap orient --json",
          },
          hint: "Summary tier — no property schemas. Call /discover?profileSlugs=task,person for full property detail + create commands only for the profiles you intend to use.",
        });
      }

      // ── Full tier: property schemas + create commands ──
      // A selected schema read must not fan out into every profile's property
      // definitions. The hub caller delegates the filter to the repository.
      const defsRaw =
        selectedSlugs && selectedProfiles.length === 0
          ? { propertyDefs: [] }
          : await caller.profiles.listPropertyDefs({
              userId,
              workspaceId,
              ...(selectedSlugs
                ? { profileIds: selectedProfiles.map((profile) => profile.id) }
                : {}),
            });
      const allDefs = (Array.isArray(defsRaw)
        ? defsRaw
        : ((defsRaw as unknown as { propertyDefs: unknown[] }).propertyDefs ??
          [])) as unknown as PropertyDef[];

      // Group property defs by profileId
      const defsByProfileId = new Map<string, PropertyDef[]>();
      for (const def of allDefs) {
        if (!def.profileId) continue;
        if (!defsByProfileId.has(def.profileId))
          defsByProfileId.set(def.profileId, []);
        defsByProfileId.get(def.profileId)!.push(def);
      }

      const discoveredProfiles = selectedProfiles.map((p) => {
        const defs = defsByProfileId.get(p.id) ?? [];
        const properties = defs.map((d) => {
          const options =
            (d.constraints?.options as string[] | undefined) ??
            (d.uiHints?.options as string[] | undefined);
          return {
            slug: d.slug,
            displayName:
              (d.uiHints?.displayName as string | undefined) ?? d.slug,
            type: d.valueType,
            ...(options?.length ? { options } : {}),
          };
        });

        const propExample =
          properties.length > 0
            ? ` --props '{"${properties[0].slug}":"value"}'`
            : "";
        return {
          slug: p.slug,
          displayName: p.displayName,
          scope: (p.entityScope ?? "workspace") as "pod" | "workspace",
          description: p.description ?? null,
          icon: p.icon ?? null,
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
          properties,
          createCommand: `synap create entity --profile ${p.slug} --name "<title>"${propExample} --json`,
        };
      });

      return c.json({
        profiles: discoveredProfiles,
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
            "synap create relation --source <id> --target <id> --type <type> --json",
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
