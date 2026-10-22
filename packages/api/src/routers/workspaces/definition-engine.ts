/**
 * Workspaces router — the workspace-definition engine: `createFromDefinition`,
 * `reconcileFromDefinition`, `applyDefinition`, and `resetEntities`. Extracted
 * verbatim from `workspaces.ts` during router-decomposition Wave 6 (the
 * dominant mass of that file) — no logic changed. Composed back into
 * `workspacesRouter` by the barrel so the generated `workspaces:` type stays
 * byte-identical.
 *
 * The template doors here (`createFromDefinition`, `reconcileFromDefinition`,
 * `applyDefinition` create) are thin wrappers over the ONE template apply,
 * through `template-door.ts` (APPLY-ONE-DOOR-PLAN W3).
 */

import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import { z } from "zod";
import { validateTriggerFilters } from "@synap-core/types/automations/filter-operators";
import { profilePresentationSchema } from "./profile-presentation-schema.js";
import {
  protectedProcedure,
  credentialProcedure,
} from "../../trpc.js";
import {
  db,
  eq,
  and,
  inArray,
  workspaces,
  workspaceMembers,
  entities,
  getDb,
  eventRepository,
  RelationRepository,
  RelationDefRepository,
  preflightWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  readTemplateState,
  type WorkspaceDefinitionInput,
  workspaceIntentDefinitionSchema,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { resolvePreflightComposeTarget } from "../../services/preflight-compose-target.js";
import { assertPackageTierAccess } from "../../utils/tier-check.js";
import { resolveWorkspaceExtends } from "../../services/workspace-composition.js";
import type { LayerTwoBody } from "../../services/template-apply/index.js";
import { applyDefinitionSeeds } from "../../services/definition-seeds.js";
import { workspacePrimarySurfaceSchema } from "../../schemas/workspace-primary-surface.js";
import { playbookDefinitionSchema } from "../../schemas/playbook-definition.js";
import {
  buildPostWorkspaceBodyFromDefinition,
  type CreateDefinitionPostWorkspaceSlice,
} from "./helpers.js";
import {
  applyTemplateForTrpc,
  installTarget,
  templateDoorReply,
  templateLayerReports,
} from "./template-door.js";

/**
 * `triggerConfig` shape for a definition-seeded flow automation.
 *
 * FOURTH CREATE DOOR. `createFromDefinition` / `applyDefinition` reach
 * `reconcileWorkspaceFromDefinition` (@synap/database), which inserts the
 * definition's automations `status: "active"` — so a package/template can seed
 * an event automation whose `filters` the matcher cannot evaluate, landing the
 * same permanently-unreachable-but-healthy-looking row the tRPC door now
 * rejects. The validator cannot be applied inside `@synap/database` itself:
 * `@synap-core/types` depends on `@synap/database`, so importing it there would
 * close a dependency cycle. Validating at the DEFINITION PARSE boundary (here,
 * in `@synap/api`) is the honest fix — it is where the untrusted payload enters.
 *
 * Zero shipped capability/workspace JSON carries a trigger `filters` key today
 * (verified by a full JSON walk over both repos), so this cannot reject any
 * template that installs now.
 */
const flowAutomationTriggerConfigSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .superRefine((config, ctx) => {
    if (!config) return;
    const result = validateTriggerFilters(config.filters);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    }
  });

/**
 * `profiles[].lifecycle` (work model L1) — carried, not judged: the profile
 * objects below are NOT passthrough, so an undeclared key is stripped, and the
 * one install door (`installFromCatalog` → `createFromDefinition`) used to
 * drop every catalog lifecycle here. The options are parsed by the apply's own
 * door (`withLifecycleOptions` → `parseLifecycleOptions`).
 */
const templateLifecycleSchema = z.object({
  property: z.string(),
  options: z.array(z.record(z.string(), z.unknown())),
});

/**
 * The layer-2 body of a tRPC definition, keyed by the space it lands on (its
 * loop). The ONE builder, so loop-style `automations` never reach the
 * graph-automation applier.
 */
function trpcLayerTwoBody(
  definition: CreateDefinitionPostWorkspaceSlice,
  workspaceId: string
): LayerTwoBody {
  return buildPostWorkspaceBodyFromDefinition(
    definition,
    workspaceId
  ) as LayerTwoBody;
}

export const definitionEngineProcedures = {
  /**
   * PREFLIGHT the create path — write-free. The missing half of this door.
   *
   * DOOR-PARITY FIX. `createFromDefinition` (below) has always been the HUMAN
   * door for materializing a package definition, but its preview half existed
   * only on the AGENT door (`POST /api/hub/packages/preflight`). A browser
   * client authenticates with a Kratos COOKIE, and the Hub auth middleware
   * reads `Authorization: Bearer` / `X-Session-Token` only — it never looks at
   * the cookie (`hub-protocol-rest.ts`, and `getSession()` supports cookies but
   * is handed a fresh Headers containing just the token). So a human surface
   * could APPLY a template but could not PREVIEW one: it had to either install
   * blind or fake a preview from the package file. That asymmetry is this
   * repo's dominant defect class, not a missing feature.
   *
   * There is no second engine here. `preflightWorkspaceFromDefinition` is the
   * SAME shared core the Hub endpoint wraps — it applies the create door's own
   * field-alias normalization, so what it reports is what `createFromDefinition`
   * would do, and the two can never drift apart.
   *
   * INPUT IS DELIBERATELY PERMISSIVE. A typed mirror of `createFromDefinition`'s
   * definition schema would be a second hand-maintained projection of the same
   * shape — the exact thing that makes a preview lie once the two fall out of
   * step. Nothing is written, and the core reads only `profiles`, `views` and
   * `entityLinks` (all declared on the create door), so a permissive record is
   * both safe and drift-free.
   *
   * A MUTATION, not a query, purely for transport: a package definition is tens
   * of kilobytes and a tRPC query serializes its input into the URL. Same
   * reason `reconcileFromDefinition` carries its own `dryRun`. It writes
   * nothing — `preflightWorkspaceFromDefinition` returns `dryRun: true`.
   *
   * Scoped to the caller: the pod catalog is read through `ctx.userId`, so the
   * report describes what THIS user's install would resolve to. No workspace is
   * touched and none is named, so there is no row to gate a write on.
   */
  preflightFromDefinition: protectedProcedure
    .input(z.object({ definition: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      return preflightWorkspaceFromDefinition({
        definition: input.definition as unknown as WorkspaceDefinitionInput,
        userId: ctx.userId,
        // Same compose resolution the Hub doors use (a declared compose base).
        composeTarget: await resolvePreflightComposeTarget({
          definition: input.definition as {
            dependencies?: Array<{
              slug: string;
              kind?: string;
              relation?: string;
            }>;
          },
          userId: ctx.userId,
        }),
      });
    }),

  /**
   * Create a complete workspace from a PackageDefinition in a single call.
   *
   * Server-side equivalent of the frontend's 9-step useCreateWorkspaceFromProposal.
   * Preferred path for template-based workspace creation (packages from registry).
   */
  createFromDefinition: credentialProcedure
    .input(
      z.object({
        definition: z
          .object({
            workspaceName: z.string().optional(),
            description: z.string().optional(),
            /**
             * Workspace composition (north star §10): import/extend bricks
             * (profiles + views) from another SHARED/PUBLIC/SYSTEM workspace.
             * Resolved + merged (COPY semantics) by `resolveWorkspaceExtends`
             * before materialization. Each `source` is a workspaceId or a
             * systemSlug; omit `import`/a key to import all. Reads are
             * access-gated — a caller can only import from a workspace they can
             * see (member / pod_visible / pod_joinable / system).
             */
            extends: z
              .array(
                z.object({
                  source: z.string().min(1),
                  import: z
                    .object({
                      profiles: z.array(z.string()).optional(),
                      views: z.array(z.string()).optional(),
                    })
                    .optional(),
                })
              )
              .optional(),
            profiles: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  // Proposal format: direct fields
                  icon: z.string().optional(),
                  color: z.string().optional(),
                  description: z.string().optional(),
                  scope: z.string().optional(),
                  entityScope: z.enum(["pod", "workspace"]).optional(),
                  semanticSlug: z.string().nullable().optional(),
                  // Profiles are either entity kinds (person, company) or
                  // attachable roles (lead, client). Keep this generic: the
                  // definition author, not the workspace router, owns the
                  // domain vocabulary.
                  profileKind: z.enum(["kind", "role"]).optional(),
                  applicableKinds: z.array(z.string()).optional(),
                  // The profile's ONE lifecycle (work model L1). Validated by
                  // the apply's own door (`withLifecycleOptions`), not here.
                  lifecycle: templateLifecycleSchema.optional(),
                  presentation: profilePresentationSchema.optional(),
                  // Proposal format: flat property list
                  properties: z
                    .array(
                      z.object({
                        slug: z.string(),
                        label: z.string().optional(),
                        valueType: z.string(),
                        inputType: z.string().optional(),
                        placeholder: z.string().optional(),
                        enumValues: z.array(z.string()).optional(),
                        constraints: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        // entity_id properties: which profile this field links to
                        targetProfileSlug: z.string().optional(),
                      })
                    )
                    .optional(),
                  // Registry format: nested uiHints (alternative to direct fields)
                  uiHints: z
                    .object({
                      icon: z.string().optional(),
                      color: z.string().optional(),
                      description: z.string().optional(),
                      presentation: profilePresentationSchema.optional(),
                    })
                    .optional(),
                  // Registry format: propertyDefs with nested uiHints (alternative to properties[])
                  propertyDefs: z
                    .array(
                      z.object({
                        slug: z.string(),
                        valueType: z.string(),
                        required: z.boolean().optional(),
                        constraints: z
                          .object({
                            enum: z.array(z.string()).optional(),
                          })
                          .passthrough()
                          .optional(),
                        uiHints: z
                          .object({
                            label: z.string().optional(),
                            inputType: z.string().optional(),
                            placeholder: z.string().optional(),
                          })
                          .optional(),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            views: z
              .array(
                z.object({
                  // Accept both "name" (proposal format) and "displayName" (registry format)
                  name: z.string().optional(),
                  displayName: z.string().optional(),
                  slug: z.string().optional(),
                  type: z.string(),
                  scopeProfileSlug: z.string().optional(),
                  scopeProfileSlugs: z.array(z.string()).optional(),
                  config: z.record(z.string(), z.unknown()).optional(),
                  // View configuration fields (merged into config during processing)
                  groupBy: z.string().optional(),
                  sortBy: z.string().optional(),
                  sortOrder: z.enum(["asc", "desc"]).optional(),
                  filterBy: z.record(z.string(), z.unknown()).optional(),
                  description: z.string().optional(),
                  defaultView: z.boolean().optional(),
                  hierarchyEdges: z
                    .array(
                      z.object({
                        parent: z.string(),
                        child: z.string(),
                        via: z.string().optional(),
                      })
                    )
                    .optional(),
                  startField: z.string().optional(),
                  endField: z.string().optional(),
                  colorBy: z.string().optional(),
                })
              )
              .optional(),
            /** Override the default "Home" name for the workspace home bento view */
            bentoViewName: z.string().optional(),
            bentoLayout: z
              .array(
                z.object({
                  widgetType: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  config: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            bentoViewBlocks: z
              .array(
                z.object({
                  kind: z.literal("view").default("view"),
                  viewName: z.string(),
                  pos: z.object({
                    x: z.number(),
                    y: z.number(),
                    w: z.number(),
                    h: z.number(),
                  }),
                  overrides: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            suggestedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            /** Alias for suggestedEntities (used by some template authors). Normalized server-side. */
            seedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                })
              )
              .optional(),
            suggestedRelations: z
              .array(
                z.object({
                  sourceRef: z.string(),
                  targetRef: z.string(),
                  type: z.string(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            displayTemplates: z
              .array(
                z.object({
                  name: z.string(),
                  description: z.string().optional(),
                  entityType: z.string().optional(),
                  targetType: z.string().optional(),
                  isDefault: z.boolean().optional(),
                  config: z.record(z.string(), z.unknown()),
                })
              )
              .optional(),
            layoutConfig: z
              .object({
                pinnedApps: z.array(z.string()).optional(),
                primarySurface: workspacePrimarySurfaceSchema.nullish(),
                /** Legacy compatibility input. New definitions author
                 *  `primarySurface`; null remains an explicit home fallback. */
                defaultApp: z.string().nullable().optional(),
                defaultView: z
                  .string()
                  .nullish()
                  .transform((v) => v ?? undefined),
                theme: z
                  .string()
                  .nullish()
                  .transform((v) => v ?? undefined),
                sidebarItems: z
                  .array(
                    z
                      .object({
                        // "profile" = navigate to profile bento view (new)
                        // "external" = third-party URL (legacy)
                        // "cell" = legacy side-panel shorthand; rich targets use surface.
                        kind: z.enum([
                          "app",
                          "view",
                          "profile",
                          "external",
                          "cell",
                        ]),
                        appId: z.string().optional(),
                        viewName: z.string().optional(),
                        viewId: z.string().optional(),
                        profileSlug: z.string().optional(),
                        url: z.string().optional(),
                        cellKey: z.string().optional(),
                        cellProps: z.record(z.string(), z.unknown()).optional(),
                        label: z.string().optional(),
                        icon: z.string().optional(),
                        section: z.string().optional(),
                        matchUrls: z.array(z.string()).optional(),
                        surface: z
                          .object({
                            kind: z.enum([
                              "cell",
                              "view",
                              "entity",
                              "document",
                              "channel",
                              "app",
                              "url",
                            ]),
                            cellKey: z.string().optional(),
                            viewId: z.string().optional(),
                            viewName: z.string().optional(),
                            entityId: z.string().optional(),
                            documentId: z.string().optional(),
                            channelId: z.string().optional(),
                            appId: z.string().optional(),
                            url: z.string().optional(),
                            srcdoc: z.string().optional(),
                            rendererType: z
                              .enum(["native", "external", "iframe-srcdoc"])
                              .optional(),
                            external: z.boolean().optional(),
                            placement: z
                              .enum([
                                "main",
                                "side",
                                "floating",
                                "modal",
                                "popover",
                                "embed",
                              ])
                              .optional(),
                            displayMode: z
                              .enum(["compact", "medium", "full"])
                              .optional(),
                            props: z.record(z.string(), z.unknown()).optional(),
                            title: z.string().optional(),
                            workspaceId: z.string().nullable().optional(),
                            meta: z.record(z.string(), z.unknown()).optional(),
                          })
                          .passthrough()
                          .optional(),
                      })
                      .passthrough()
                  )
                  .optional(),
              })
              .optional(),
            /** Per-profile default entity bento layout; stored in workspace.settings */
            profileEntityBentoTemplates: z
              .record(
                z.string(),
                z.object({ blocks: z.array(z.record(z.string(), z.unknown())) })
              )
              .optional(),
            workspaceSubtype: z.string().optional(),
            workspaceVisibility: z
              .enum([
                "private",
                "members",
                "pod_visible",
                "pod_joinable",
                "public_link",
              ])
              .optional(),
            workspaceCapabilities: z.array(z.string()).optional(),
            sourceRoles: z
              .record(
                z.string(),
                z.enum(["provider", "consumer", "provider-consumer"])
              )
              .optional(),
            defaultSources: z
              .record(
                z.string(),
                z.object({
                  workspaceId: z.string().uuid(),
                  capability: z.string().optional(),
                  profileSlug: z.string().optional(),
                  label: z.string().optional(),
                })
              )
              .optional(),
            entityLinks: z
              .array(
                z.object({
                  sourceProfileSlug: z.string(),
                  targetProfileSlug: z.string(),
                  type: z.string(),
                  label: z.string().optional(),
                })
              )
              .optional(),
            /**
             * Playbook templates — the ONE playbook definition schema
             * (schemas/playbook-definition.ts). The local z.object it replaces
             * had no `scope` / `stages` / `criteria` / `metadata`, so a browser
             * install landed every project method as a stageless session
             * template. Extended only with this door's grant shape.
             */
            playbooks: z
              .array(
                playbookDefinitionSchema.extend({
                  /**
                   * Workspace templates author grants as BARE NAMES
                   * (`grants: [exa_search, entity.create]`) — the same form the
                   * Hub door already accepts (`PackagePostWorkspaceBody
                   * .playbooks[].grants: string[]`). Requiring only the
                   * `{kind, ref}` object form made this door REJECT the whole
                   * mutation for any template carrying playbook grants, so a
                   * browser install 400'd outright. Accept both shapes here;
                   * `buildPostWorkspaceBodyFromDefinition` narrows them.
                   */
                  grants: z
                    .array(
                      z.union([
                        z.string(),
                        z.object({
                          kind: z.enum(["tool", "skill", "command"]),
                          ref: z.string(),
                        }),
                      ])
                    )
                    .optional(),
                })
              )
              .optional(),
            /** Automation templates (event/cron/manual triggers for playbook runs) */
            automations: z
              .array(
                z.object({
                  key: z.string().min(1).optional(),
                  name: z.string().min(1),
                  description: z.string().optional(),
                  trigger: z.object({
                    type: z.enum(["cron", "event", "manual"]),
                    cron: z.string().optional(),
                    eventType: z.string().optional(),
                  }),
                  action: z.object({
                    type: z.literal("playbook_run"),
                    playbookSlug: z.string(),
                    params: z.record(z.string(), z.unknown()).optional(),
                  }),
                })
              )
              .optional(),
            /**
             * Graph-flow template automations. This is deliberately not the
             * legacy `automations` field above, which seeds LOOP playbook
             * triggers with a different schema.
             */
            flowAutomations: z
              .array(
                z.object({
                  key: z.string().min(1).optional(),
                  name: z.string().min(1),
                  description: z.string().optional(),
                  triggerType: z.enum(["event", "cron", "webhook", "manual"]),
                  triggerConfig: flowAutomationTriggerConfigSchema,
                  flowDefinition: z
                    .object({
                      nodes: z.array(z.unknown()),
                      edges: z.array(z.unknown()),
                      precondition: z.string().optional(),
                    })
                    .optional(),
                  status: z.enum(["draft", "active", "paused"]).optional(),
                })
              )
              .optional(),
            /** Tool templates (registered integrations available to AI agents) */
            tools: z
              .array(
                z.object({
                  name: z.string().min(1),
                  kind: z.enum([
                    "api",
                    "mcp",
                    "provider",
                    "external",
                    "script",
                    "builtin",
                  ]),
                  description: z.string().optional(),
                  credentialRequired: z.boolean().optional(),
                  inputSchema: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /**
             * Capability integrations (→ tools + skills + vault + capability-
             * embedded automations/playbooks). This is the operational bundle:
             * `toPackageDefinition` emits it from a template's `integrations:`
             * list. Installed via the SHARED `applyPackagePostWorkspace` door
             * (same as Hub `/packages/apply`) so the browser install path carries
             * capabilities too — before this it installed none.
             */
            capabilities: z
              .array(
                z.object({
                  templateKey: z.string().optional(),
                  definition: z.record(z.string(), z.unknown()).optional(),
                  params: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /**
             * Template-composition dependencies — resolved BEFORE the workspace
             * step, mirroring PackageApplySchema in the Hub packages route
             * (`POST /packages/apply`). A `compose` dependency layers this
             * package ADDITIVELY onto its base workspace (no second workspace
             * is created); `require` deps are installed/surfaced. The browser
             * marketplace forwards these verbatim in `options.definition`.
             */
            dependencies: z
              .array(
                z.object({
                  slug: z.string().min(1),
                  // Locked to the CP `dependencies[].kind` enum (7 literals),
                  // matching @synap/database `PackageDependencyKind` + the hub
                  // door. cell installs; skill/workflow/view/automation surface.
                  kind: z
                    .enum([
                      "workspace",
                      "capability",
                      "skill",
                      "workflow",
                      "view",
                      "cell",
                      "automation",
                    ])
                    .default("workspace"),
                  relation: z.enum(["compose", "require"]).default("require"),
                  reason: z.string().optional(),
                })
              )
              .optional(),
            /**
             * Entity-detail action placements → merged into
             * `settings.actionPlacements` by the shared
             * `applyPackagePostWorkspace` door (Phase 4 GAP C). A plain
             * `z.object` would STRIP this even under `.passthrough()` typing, so
             * declare it to carry it typed through to the applier.
             */
            actionPlacements: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  surface: z.string(),
                  kind: z.enum(["capability", "playbook", "automation"]),
                  ref: z.string(),
                  label: z.string(),
                  when: z
                    .object({
                      requiredFacetSlugs: z
                        .array(z.string().min(1))
                        .min(1)
                        .optional(),
                      propertyEquals: z
                        .record(z.string(), z.unknown())
                        .optional(),
                      propertyAnyEquals: z
                        .record(z.string(), z.array(z.unknown()).min(1))
                        .optional(),
                      propertyNotEquals: z
                        .record(z.string(), z.unknown())
                        .optional(),
                    })
                    .optional(),
                  confirmation: z
                    .object({
                      title: z.string().min(1),
                      description: z.string().optional(),
                      confirmLabel: z.string().min(1).optional(),
                    })
                    .optional(),
                })
              )
              .optional(),
            /**
             * Template rules (package `rules[]`) → `applyTemplateRules` via the
             * shared applier. Declared so the typed body carries them;
             * untrusted — `readTemplateRules` is the one parser.
             */
            /** What the space produces → `settings.intent` (object-first homes). */
            intent: workspaceIntentDefinitionSchema.optional(),
            rules: z.array(z.unknown()).optional(),
            /**
             * Declared skills (package `skills[]`) → `applyTemplateSkills`:
             * each links to the space's brief. Untrusted like `rules`.
             */
            skills: z.array(z.unknown()).optional(),
          })
          .passthrough(),
        packageSlug: z.string().optional(),
        packageVersion: z.string().optional(),
        /** ID of the template from the control plane registry (stored in workspace settings). */
        templateId: z.string().optional(),
        /** Human-readable name of the template (for workspace-init + settings). */
        templateName: z.string().optional(),
        workspaceName: z.string().optional(),
        workspaceType: z
          .enum(["personal", "agent", "project", "operational"])
          .optional(),
        linkedAgentId: z.string().optional(),
        /**
         * Optional: install ONTO this existing workspace instead of creating a
         * new one (the Marketplace "Add to workspace", the profile-pack
         * browser, a readiness backfill). Additive (compose): a space with its
         * own template keeps it and records this package as a pack; an
         * unidentified space takes the package as its template.
         */
        workspaceId: z.string().uuid().optional(),
        /**
         * Optional: caller-supplied stable identifier for idempotent re-creates.
         * A space already holding this key is found (never a second one) and
         * planned like any re-hit: unchanged, re-synced or resumed. Stamped
         * into `provisioning_proposal_id` / `settings.proposalId`.
         * Used by Eve (Builder Workspace = "builder-workspace-v1") and DevPlane.
         */
        proposalId: z.string().optional(),
        /**
         * Optional: app identifier stamped into `settings.appId`.
         * Enables filtering workspaces.list by app (e.g. "crm", "studio", "canvas").
         * Separates the app-ownership concern from the proposalId idempotency key.
         */
        appId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Template identity (0308): a catalog definition's `_meta.slug` IS its
      // identity (installed once per pod) — adopt it when the caller did not
      // pass `packageSlug`. A template input (`templateId`/`templateName`/
      // `_meta`) with no slug, no explicit `proposalId` and no target
      // `workspaceId` has no identity and would mint a second space on every
      // call (incident 2026-10-06), so it is refused.
      const meta = (input.definition as { _meta?: { slug?: unknown } })._meta;
      if (
        !input.packageSlug &&
        typeof meta?.slug === "string" &&
        meta.slug.trim()
      ) {
        input.packageSlug = meta.slug.trim();
      }
      if (
        (input.templateId || input.templateName || meta) &&
        !input.packageSlug &&
        !input.proposalId &&
        !input.workspaceId
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This template definition has no package slug (`packageSlug` or `_meta.slug`), no `proposalId` and no target `workspaceId`, so it cannot be installed idempotently.",
        });
      }

      // CRM workspace creation is an explicit Pod-owner action. The frontend
      // also hides the action for members, but this server gate is the source
      // of truth and prevents direct API calls from bypassing that policy.
      if (input.appId === "crm" && !input.workspaceId) {
        const podAdminWorkspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.systemSlug, "pod-admin"),
          columns: { id: true },
        });
        const podAdminMembership = podAdminWorkspace
          ? await db.query.workspaceMembers.findFirst({
              where: and(
                eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                eq(workspaceMembers.userId, ctx.userId),
                inArray(workspaceMembers.role, ["owner", "admin"])
              ),
              columns: { id: true },
            })
          : null;
        if (!podAdminMembership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only a Pod owner can create a CRM workspace.",
          });
        }
      }

      // Enforce tier access before creating. Self-hosted pods (no CP configured)
      // are always allowed. Throws FORBIDDEN if tier is insufficient.
      if (input.packageSlug) {
        await assertPackageTierAccess(ctx.userId, input.packageSlug);
      }

      // THE ONE template apply (APPLY-ONE-DOOR-PLAN, W3). It finds the space
      // (key → pod-wide holder → legacy match), plans (create · resume ·
      // re-sync · unchanged), builds or re-syncs layer 1, applies layer 2 from
      // the same source and stamps only on convergence. This door adds only
      // what is its own: the human governance above, `extends`, the progress
      // events, `appId` / `composedFrom`, and the seed bodies. A `workspaceId`
      // installs ONTO that space (compose: it keeps its own template identity,
      // a pack is recorded in its ledger).
      const { definition: composedDefinition, provenance: composedFrom } =
        await resolveWorkspaceExtends(input.definition, ctx.userId);
      const applied = await applyTemplateForTrpc({
        userId: ctx.userId,
        agentUserId: (ctx as { agentUserId?: string }).agentUserId,
        source: "trpc.createFromDefinition",
        definition: composedDefinition as unknown as WorkspaceDefinitionInput,
        layerTwoBody: (workspaceId) =>
          trpcLayerTwoBody(
            input.definition as CreateDefinitionPostWorkspaceSlice,
            workspaceId
          ),
        targetWorkspaceId: await installTarget(
          input.workspaceId,
          input.packageSlug
        ),
        identity: {
          packageSlug: input.packageSlug,
          packageVersion: input.packageVersion,
          proposalId: input.proposalId,
          workspaceName: input.workspaceName,
          templateId: input.templateId,
          templateName: input.templateName,
          workspaceType: input.workspaceType,
          linkedAgentId: input.linkedAgentId,
          createdBy: "user",
        },
        // A `packageVersion` asks for a stamp; the stamp is the version of
        // the definition sent, never the label (`applyTemplate`).
        sentDefinition: input.definition as Record<string, unknown>,
        settingsFill: {
          ...(input.appId ? { appId: input.appId } : {}),
        },
        createdFill: composedFrom.length > 0 ? { composedFrom } : undefined,
        seeds: input.definition.suggestedEntities,
      });
      return templateDoorReply(applied);
    }),

  /**
   * Reconcile an EXISTING workspace's definition to a template — non-destructively.
   * Counterpart to createFromDefinition: adds missing profiles, property-defs
   * (as overlays for reused pod-wide profiles), and views (find-or-create);
   * merges capabilities/subtype. NEVER deletes or mutates a property-def type
   * (type conflicts are reported, not changed). `dryRun` previews the diff.
   * Owner/admin only. The caller resolves the template → definition (e.g.
   * toWorkspaceDefinition('crm')) and passes it, mirroring createFromDefinition.
   */
  reconcileFromDefinition: credentialProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        dryRun: z.boolean().optional(),
        definition: z.object({
          workspaceSubtype: z.string().optional(),
          workspaceVisibility: z.string().optional(),
          workspaceCapabilities: z.array(z.string()).optional(),
          profiles: z
            .array(
              z.object({
                slug: z.string(),
                displayName: z.string(),
                icon: z.string().optional(),
                color: z.string().optional(),
                description: z.string().optional(),
                scope: z.string().optional(),
                entityScope: z.enum(["pod", "workspace"]).optional(),
                semanticSlug: z.string().nullable().optional(),
                // Preserve generic kind/role metadata for reconciled
                // definitions. The materializer validates the combination.
                profileKind: z.enum(["kind", "role"]).optional(),
                applicableKinds: z.array(z.string()).optional(),
                lifecycle: templateLifecycleSchema.optional(),
                presentation: profilePresentationSchema.optional(),
                properties: z
                  .array(
                    z.object({
                      slug: z.string(),
                      label: z.string().optional(),
                      valueType: z.string(),
                      inputType: z.string().optional(),
                      placeholder: z.string().optional(),
                      enumValues: z.array(z.string()).optional(),
                      constraints: z.record(z.string(), z.unknown()).optional(),
                      targetProfileSlug: z.string().optional(),
                    })
                  )
                  .optional(),
                uiHints: z
                  .object({
                    icon: z.string().optional(),
                    color: z.string().optional(),
                    description: z.string().optional(),
                    presentation: profilePresentationSchema.optional(),
                  })
                  .optional(),
                propertyDefs: z
                  .array(
                    z.object({
                      slug: z.string(),
                      valueType: z.string(),
                      constraints: z
                        .object({ enum: z.array(z.string()).optional() })
                        .passthrough()
                        .optional(),
                      uiHints: z
                        .object({
                          label: z.string().optional(),
                          inputType: z.string().optional(),
                          placeholder: z.string().optional(),
                        })
                        .optional(),
                    })
                  )
                  .optional(),
              })
            )
            .optional(),
          views: z
            .array(
              z.object({
                name: z.string().optional(),
                displayName: z.string().optional(),
                slug: z.string().optional(),
                type: z.string(),
                scopeProfileSlug: z.string().optional(),
                scopeProfileSlugs: z.array(z.string()).optional(),
                config: z.record(z.string(), z.unknown()).optional(),
                groupBy: z.string().optional(),
                sortBy: z.string().optional(),
                sortOrder: z.enum(["asc", "desc"]).optional(),
                filterBy: z.record(z.string(), z.unknown()).optional(),
                description: z.string().optional(),
                defaultView: z.boolean().optional(),
                colorBy: z.string().optional(),
              })
            )
            .optional(),
          entityLinks: z
            .array(
              z.object({
                sourceProfileSlug: z.string(),
                targetProfileSlug: z.string(),
                type: z.string(),
                label: z.string().optional(),
              })
            )
            .optional(),
          /** Post-workspace layers are reconciled through the same generic door. */
          capabilities: z.array(z.record(z.string(), z.unknown())).optional(),
          playbooks: z.array(z.record(z.string(), z.unknown())).optional(),
          /** Graph-flow templates, routed to the shared post-workspace applier. */
          flowAutomations: z
            .array(
              z.object({
                key: z.string().min(1).optional(),
                name: z.string().min(1),
                description: z.string().optional(),
                triggerType: z.enum(["event", "cron", "webhook", "manual"]),
                triggerConfig: flowAutomationTriggerConfigSchema,
                flowDefinition: z
                  .object({
                    nodes: z.array(z.unknown()),
                    edges: z.array(z.unknown()),
                    precondition: z.string().optional(),
                  })
                  .optional(),
                status: z.enum(["draft", "active", "paused"]).optional(),
              })
            )
            .optional(),
          /**
           * Entity-detail action placements → re-asserted into
           * `settings.actionPlacements` via the shared
           * `buildPostWorkspaceBodyFromDefinition` builder (which reads
           * `definition.actionPlacements`). Without this zod field the placements
           * are STRIPPED before the builder sees them, so a reconcile could never
           * re-assert them. Mirrors the createFromDefinition shape (line 2904).
           */
          actionPlacements: z
            .array(
              z.object({
                profileSlug: z.string(),
                surface: z.string(),
                kind: z.enum(["capability", "playbook", "automation"]),
                ref: z.string(),
                label: z.string(),
                when: z
                  .object({
                    requiredFacetSlugs: z
                      .array(z.string().min(1))
                      .min(1)
                      .optional(),
                    propertyEquals: z
                      .record(z.string(), z.unknown())
                      .optional(),
                    propertyAnyEquals: z
                      .record(z.string(), z.array(z.unknown()).min(1))
                      .optional(),
                    propertyNotEquals: z
                      .record(z.string(), z.unknown())
                      .optional(),
                  })
                  .optional(),
                confirmation: z
                  .object({
                    title: z.string().min(1),
                    description: z.string().optional(),
                    confirmLabel: z.string().min(1).optional(),
                  })
                  .optional(),
              })
            )
            .optional(),
          /**
           * Template rules — without this field zod STRIPS them (this object
           * is not passthrough), so a reconcile could never converge rules.
           */
          /**
           * What the space produces → `settings.intent` — stripped by zod
           * without this (this object is not passthrough).
           */
          intent: workspaceIntentDefinitionSchema.optional(),
          rules: z.array(z.unknown()).optional(),
          /**
           * Declared skills — stripped by zod without this, exactly like rules.
           */
          skills: z.array(z.unknown()).optional(),
        }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Owner/admin only — this is a structural workspace change, not a data
      // mutation, so it runs directly (never proposed). Reuse the same RBAC gate
      // as workspaces.update; if it would only be granted via a proposal, the
      // caller isn't an owner/admin → reject.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "workspaces",
        action: "update",
        data: { id: input.workspaceId },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("granted" in perm && !perm.granted) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Reconciling a workspace definition requires owner/admin access.",
        });
      }

      // A dry run previews the layer-1 diff: a read, not an apply.
      if (input.dryRun)
        return reconcileWorkspaceFromDefinition({
          validateFlow: unfilteredAiFanoutError,
          workspaceId: input.workspaceId,
          userId: ctx.userId,
          definition: input.definition as unknown as WorkspaceDefinitionInput,
          dryRun: true,
        });

      // Re-sync THIS space against the caller's definition through the ONE
      // apply (W3; fixes F: this door never reached the finisher, so nothing
      // recorded what it did or whether layer 2 landed). The space's own
      // template identity is passed, so the definition lands as its template
      // (an overlay pack would have its shell stripped); no version is
      // passed, so nothing is stamped. A layer-2 failure is recorded on the
      // space and reported in `layers`, never thrown (decision 3).
      const [target] = await db
        .select({
          settings: workspaces.settings,
          packageSlug: workspaces.packageSlug,
        })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .limit(1);
      if (!target)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      const applied = await applyTemplateForTrpc({
        userId: ctx.userId,
        agentUserId: (ctx as { agentUserId?: string }).agentUserId,
        source: "trpc.reconcileFromDefinition",
        definition: input.definition as unknown as WorkspaceDefinitionInput,
        layerTwoBody: (workspaceId) =>
          trpcLayerTwoBody(
            input.definition as unknown as CreateDefinitionPostWorkspaceSlice,
            workspaceId
          ),
        targetWorkspaceId: input.workspaceId,
        identity: {
          packageSlug:
            readTemplateState(target.settings, {
              packageSlug: target.packageSlug,
            })?.slug ?? undefined,
        },
      });
      if (!applied.compose)
        throw new Error(
          "reconcileFromDefinition: an apply onto a space did not compose"
        );
      const layers = templateLayerReports(applied);
      return layers.length > 0
        ? { ...applied.compose.report, layers }
        : applied.compose.report;
    }),

  /**
   * Apply a comprehensive workspace definition in a single call.
   *
   * Orchestrates:
   * 1. Profiles + views via createWorkspaceFromDefinition
   * 2. Relation definitions (auto-created from relation defs in definition)
   * 3. Entities (batch create with auto-profile creation)
   * 4. Relations (batch create with auto-relationDef creation)
   *
   * Supports two modes:
   * - "create": the ONE template apply (idempotent on `proposalId`)
   * - "update": populates/updates an existing workspace (skips workspace/profiles/views creation)
   *
   * Idempotent: entities and relations are upserted by their natural keys.
   */
  applyDefinition: credentialProcedure
    .input(
      z.object({
        /** Reuse the full WorkspaceDefinitionInput schema */
        definition: z
          .object({
            workspaceName: z.string().optional(),
            description: z.string().optional(),
            profiles: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  icon: z.string().optional(),
                  color: z.string().optional(),
                  description: z.string().optional(),
                  scope: z.string().optional(),
                  presentation: profilePresentationSchema.optional(),
                  properties: z
                    .array(
                      z.object({
                        slug: z.string(),
                        label: z.string().optional(),
                        valueType: z.string(),
                        inputType: z.string().optional(),
                        placeholder: z.string().optional(),
                        enumValues: z.array(z.string()).optional(),
                        constraints: z
                          .record(z.string(), z.unknown())
                          .optional(),
                        targetProfileSlug: z.string().optional(),
                      })
                    )
                    .optional(),
                  uiHints: z
                    .object({
                      icon: z.string().optional(),
                      color: z.string().optional(),
                      description: z.string().optional(),
                      presentation: profilePresentationSchema.optional(),
                    })
                    .optional(),
                  propertyDefs: z
                    .array(
                      z.object({
                        slug: z.string(),
                        valueType: z.string(),
                        required: z.boolean().optional(),
                        constraints: z
                          .object({ enum: z.array(z.string()).optional() })
                          .passthrough()
                          .optional(),
                        uiHints: z
                          .object({
                            label: z.string().optional(),
                            inputType: z.string().optional(),
                            placeholder: z.string().optional(),
                          })
                          .optional(),
                      })
                    )
                    .optional(),
                })
              )
              .optional(),
            views: z.array(z.record(z.string(), z.unknown())).optional(),
            bentoLayout: z.array(z.record(z.string(), z.unknown())).optional(),
            bentoViewBlocks: z
              .array(z.record(z.string(), z.unknown()))
              .optional(),
            bentoViewName: z.string().optional(),
            suggestedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                  refKey: z.string().optional(), // stable reference for relations
                })
              )
              .optional(),
            seedEntities: z
              .array(
                z.object({
                  profileSlug: z.string(),
                  title: z.string(),
                  properties: z.record(z.string(), z.unknown()).optional(),
                  content: z.string().optional(),
                  refKey: z.string().optional(),
                })
              )
              .optional(),
            suggestedRelations: z
              .array(
                z.object({
                  sourceRef: z.string(), // refKey or "profileSlug:title"
                  targetRef: z.string(),
                  type: z.string(),
                  metadata: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            /** Additional relation definitions to ensure exist */
            relationDefs: z
              .array(
                z.object({
                  slug: z.string(),
                  displayName: z.string(),
                  description: z.string().optional(),
                  isDirectional: z.boolean().optional(),
                  uiHints: z.record(z.string(), z.unknown()).optional(),
                })
              )
              .optional(),
            entityLinks: z.array(z.record(z.string(), z.unknown())).optional(),
            displayTemplates: z
              .array(z.record(z.string(), z.unknown()))
              .optional(),
            layoutConfig: z
              .object({
                primarySurface: workspacePrimarySurfaceSchema.nullish(),
              })
              .catchall(z.unknown())
              .optional(),
            profileEntityBentoTemplates: z
              .record(z.string(), z.unknown())
              .optional(),
          })
          .passthrough(),
        /** "create" = new workspace, "update" = populate existing workspace */
        mode: z.enum(["create", "update"]).default("update"),
        /** Required for "update" mode: which workspace to populate */
        workspaceId: z.string().uuid().optional(),
        /** Optional: stable idempotency key for "create" mode */
        proposalId: z.string().optional(),
        /** Optional: app identifier for workspace filtering */
        appId: z.string().optional(),
      })
    )
    .output(
      z.object({
        workspaceId: z.string(),
        profilesCreated: z.number(),
        entitiesCreated: z.number(),
        entitiesSkipped: z.number(),
        relationsCreated: z.number(),
        relationsSkipped: z.number(),
        relationDefsCreated: z.number(),
        entityIds: z.record(z.string(), z.string()),
        errors: z.array(
          z.object({
            stage: z.string(),
            refKey: z.string().optional(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const errors: Array<{ stage: string; refKey?: string; error: string }> =
        [];

      // ── UPDATE mode: populate existing workspace ────────────────────────
      if (input.mode === "update") {
        if (!input.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "workspaceId is required for update mode",
          });
        }

        // Verify membership
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }

        const database = await getDb();
        // Shared singleton — a fresh EventRepository has no registered hooks, so
        // its emitCompleted() append would silently never reach the
        // realtime/materialization/sync hooks.
        const eventRepo = eventRepository;

        // 1. Ensure relation definitions exist
        const relDefRepo = new RelationDefRepository(database);
        let relationDefsCreated = 0;
        const existingDefs = await relDefRepo.list(input.workspaceId);
        const existingDefSlugs = new Set(existingDefs.map((d) => d.slug));

        for (const rd of input.definition.relationDefs ?? []) {
          if (existingDefSlugs.has(rd.slug)) continue;
          try {
            await relDefRepo.create({
              slug: rd.slug,
              displayName: rd.displayName,
              description: rd.description,
              workspaceId: input.workspaceId,
              userId: ctx.userId,
              uiHints: rd.uiHints,
              isDirectional: rd.isDirectional ?? true,
            });
            existingDefSlugs.add(rd.slug);
            relationDefsCreated++;
          } catch (err) {
            errors.push({
              stage: "relationDefs",
              refKey: rd.slug,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 2. Batch create entities
        const { ProfileRepository, isProfileKindTwinError } =
          await import("@synap/database");
        const profileRepo = new ProfileRepository(database);
        const profileCache = new Map<string, string>();

        // Pre-load existing profiles
        const existingProfiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          input.workspaceId
        );
        for (const p of existingProfiles) {
          profileCache.set(p.slug, p.id);
        }

        // Auto-create missing profiles
        let profilesCreated = 0;
        const profileHintsMap = new Map<
          string,
          {
            displayName?: string;
            icon?: string;
            color?: string;
            description?: string;
          }
        >();
        const allEntities =
          input.definition.suggestedEntities ??
          input.definition.seedEntities ??
          [];
        for (const e of allEntities) {
          const profileDef = input.definition.profiles?.find(
            (p) => p.slug === e.profileSlug
          );
          if (profileDef && !profileHintsMap.has(e.profileSlug)) {
            profileHintsMap.set(e.profileSlug, {
              displayName:
                profileDef.displayName ??
                (profileDef.uiHints as any)?.displayName,
              icon: profileDef.icon ?? (profileDef.uiHints as any)?.icon,
              color: profileDef.color ?? (profileDef.uiHints as any)?.color,
              description:
                profileDef.description ??
                (profileDef.uiHints as any)?.description,
            });
          }
        }

        for (const e of allEntities) {
          if (profileCache.has(e.profileSlug)) continue;
          const hints = profileHintsMap.get(e.profileSlug) ?? {};
          try {
            const newProfile = await profileRepo.create({
              slug: e.profileSlug,
              displayName: hints.displayName ?? e.profileSlug,
              // Seeded by a workspace definition apply; the workspace owns it.
              origin: "template",
              ownerKind: "workspace",
              ownerId: input.workspaceId,
              uiHints: {
                icon: hints.icon,
                color: hints.color,
                description: hints.description,
              },
              scope: "workspace" as any,
              workspaceId: input.workspaceId,
              userId: ctx.userId,
            });
            profileCache.set(e.profileSlug, newProfile.id);
            profilesCreated++;
          } catch (err) {
            // The kind already lives pod-wide (a SHARED row this workspace was
            // never granted): reuse it, as `resolveProfileForApply` does —
            // never a twin.
            if (isProfileKindTwinError(err)) {
              await profileRepo.grantAccess(err.holder.id, input.workspaceId);
              profileCache.set(e.profileSlug, err.holder.id);
              continue;
            }
            errors.push({
              stage: "profiles",
              refKey: e.profileSlug,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 3. Seed entities + seeded relations — the ONE seed door, shared
        // with every overlay install (composeOntoBaseWorkspace): adopt by
        // (kind, title) in this workspace or pod-wide, create only what is
        // missing, dedupe edges.
        const seeded = await applyDefinitionSeeds({
          database,
          eventRepo,
          userId: ctx.userId,
          workspaceId: input.workspaceId,
          seeds: allEntities,
          relations: input.definition.suggestedRelations,
          profileIds: profileCache,
        });
        errors.push(...seeded.errors);
        const entityIds = seeded.entityIds;
        const entitiesCreated = seeded.entitiesCreated;
        const entitiesSkipped = seeded.entitiesAdopted;
        const relationsCreated = seeded.relationsCreated;
        const relationsSkipped = seeded.relationsSkipped;

        return {
          workspaceId: input.workspaceId,
          profilesCreated,
          entitiesCreated,
          entitiesSkipped,
          relationsCreated,
          relationsSkipped,
          relationDefsCreated,
          entityIds,
          errors,
        };
      }

      // ── CREATE mode — the ONE template apply (W3; fixes F: the idempotency
      // key was ignored, so a retry built a second space). The apply finds
      // the space (key → identity holder), resolves `dependencies` / composes
      // an overlay onto its base, builds or re-syncs layer 1, runs any layer 2
      // the definition declares and records the result.
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const applied = await applyTemplateForTrpc({
        userId: ctx.userId,
        agentUserId: (ctx as { agentUserId?: string }).agentUserId,
        source: "trpc.applyDefinition",
        definition: input.definition as unknown as WorkspaceDefinitionInput,
        layerTwoBody: (workspaceId) =>
          trpcLayerTwoBody(
            input.definition as unknown as CreateDefinitionPostWorkspaceSlice,
            workspaceId
          ),
        identity: {
          proposalId: input.proposalId,
          workspaceName: input.definition.workspaceName,
          workspaceType: "personal",
          createdBy: "user",
        },
        settingsFill: input.appId ? { appId: input.appId } : undefined,
      });
      const workspaceId = applied.workspaceId;
      const composedTarget =
        applied.outcome === "composed" ? applied.workspaceId : null;
      // The compose door already adopted/created the seeds (W4b).
      const composeSeeds = applied.compose?.report.seeds;
      // Built just now: the create core's entities, in the definition's order.
      // A re-hit of an existing space (same key) seeds nothing again.
      const built = applied.layerOne?.built;

      // After workspace is created/composed, apply entities and relations
      const relationRepo = new RelationRepository(database, eventRepo);
      const relDefRepo = new RelationDefRepository(database);

      // Entity IDs. On the create path they come back positionally from
      // the create core. On the compose path the ONE compose door
      // (composeOntoBaseWorkspace) already landed the seeds + seeded edges
      // through the shared seed helper — adopting by (kind, title), never
      // duplicating (W4b: this branch used to create them again, unkeyed).
      const entityIds: Record<string, string> = {};
      const allEntities =
        input.definition.suggestedEntities ??
        input.definition.seedEntities ??
        [];
      if (composedTarget) {
        Object.assign(entityIds, composeSeeds?.entityIds ?? {});
        errors.push(...(composeSeeds?.errors ?? []));
      } else {
        const createEntityIds = built?.entityIds ?? [];
        for (
          let i = 0;
          i < allEntities.length && i < createEntityIds.length;
          i++
        ) {
          const e = allEntities[i];
          const refKey = e.refKey ?? `${e.profileSlug}:${e.title}`;
          entityIds[refKey] = createEntityIds[i];
        }
      }

      // Create relation definitions
      let relationDefsCreated = 0;
      const existingDefs = await relDefRepo.list(workspaceId);
      const existingDefSlugs = new Set(existingDefs.map((d) => d.slug));
      for (const rd of input.definition.relationDefs ?? []) {
        if (existingDefSlugs.has(rd.slug)) continue;
        await relDefRepo.create({
          slug: rd.slug,
          displayName: rd.displayName,
          description: rd.description,
          workspaceId,
          userId: ctx.userId,
          uiHints: rd.uiHints,
          isDirectional: rd.isDirectional ?? true,
        });
        relationDefsCreated++;
      }

      // Create relations (the compose path's edges came from the seed door).
      let relationsCreated = composeSeeds?.relationsCreated ?? 0;
      let relationsSkipped = composeSeeds?.relationsSkipped ?? 0;
      for (const rel of composedTarget
        ? []
        : (input.definition.suggestedRelations ?? [])) {
        const sourceId = entityIds[rel.sourceRef];
        const targetId = entityIds[rel.targetRef];
        if (!sourceId || !targetId) continue;
        try {
          await relationRepo.create(
            {
              sourceEntityId: sourceId,
              targetEntityId: targetId,
              type: rel.type,
              workspaceId,
              userId: ctx.userId,
              metadata: rel.metadata,
            },
            ctx.userId
          );
          relationsCreated++;
        } catch {
          relationsSkipped++;
        }
      }

      return {
        workspaceId,
        profilesCreated: 0,
        entitiesCreated: composedTarget
          ? (composeSeeds?.entitiesCreated ?? 0)
          : built
            ? allEntities.length
            : 0,
        entitiesSkipped: composeSeeds?.entitiesAdopted ?? 0,
        relationsCreated,
        relationsSkipped,
        relationDefsCreated,
        entityIds,
        errors,
      };
    }),

  // Delete all entities (and their relations via CASCADE) for a workspace.
  // Workspace itself, its metadata, profiles, views, and property_defs are preserved.
  resetEntities: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const dbConn = await getDb();

      // Verify caller is a member of this workspace
      const membership = await dbConn
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          )
        )
        .limit(1);

      if (!membership.length) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Not a member of this workspace",
        });
      }

      // Hard-delete all entities for the workspace.
      // relations rows cascade automatically (ON DELETE CASCADE on both FK columns).
      const deleted = await dbConn
        .delete(entities)
        .where(eq(entities.workspaceId, input.workspaceId))
        .returning({ id: entities.id });

      return { deletedCount: deleted.length };
    }),
};
