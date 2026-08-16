/**
 * Workspaces router — the workspace-definition engine: `createFromDefinition`,
 * `reconcileFromDefinition`, `applyDefinition`, and `resetEntities`. Extracted
 * verbatim from `workspaces.ts` during router-decomposition Wave 6 (the
 * dominant mass of that file) — no logic changed. Composed back into
 * `workspacesRouter` by the barrel so the generated `workspaces:` type stays
 * byte-identical.
 */

import { z } from "zod";
import { validateTriggerFilters } from "@synap-core/types/automations/filter-operators";
import { protectedProcedure } from "../../trpc.js";
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
  EntityBodyService,
  EntityRepository,
  RelationRepository,
  RelationDefRepository,
  drizzleSql,
  createWorkspaceFromDefinition,
  reconcileWorkspaceFromDefinition,
  ONBOARDING_SCAFFOLD_SYSTEM_DATA,
  type WorkspaceDefinitionInput,
  type ReconcileReport,
} from "@synap/database";
import type { WorkspaceSettings } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { materializePodAdminsIntoWorkspace } from "../../utils/workspace-role.js";
import { inheritRelationWorkspaceId } from "../../lib/relation-workspace-inherit.js";
import { auditLog } from "../../utils/audit-log.js";
import { assertPackageTierAccess } from "../../utils/tier-check.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import {
  withWorkspaceProposalIdLock,
  reconcileWorkspaceIfStale,
} from "../../services/workspace-creation-service.js";
import { resolveWorkspaceExtends } from "../../services/workspace-composition.js";
import type { ResolvedPackageDependency } from "../../services/package-dependency-resolver.js";
import {
  materializeWorkspaceCore,
  type MaterializeCoreResult,
  ComposeBaseUnavailableError,
  DependencyResolutionError,
  ComposeBaseNotFoundError,
} from "../../services/workspace-materialization-service.js";
import { applyPackagePostWorkspace } from "../../services/package-apply-post-workspace.js";
import { workspacePrimarySurfaceSchema } from "../../schemas/workspace-primary-surface.js";
import {
  logger,
  isPodReadableWorkspace,
  buildPostWorkspaceBodyFromDefinition,
  type CreateDefinitionPostWorkspaceSlice,
} from "./helpers.js";

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

export const definitionEngineProcedures = {
  /**
   * Create a complete workspace from a PackageDefinition in a single call.
   *
   * Server-side equivalent of the frontend's 9-step useCreateWorkspaceFromProposal.
   * Preferred path for template-based workspace creation (packages from registry).
   */
  createFromDefinition: protectedProcedure
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
            /** Playbook templates (session templates with goal + capabilities) */
            playbooks: z
              .array(
                z.object({
                  name: z.string().min(1).max(500),
                  goalTemplate: z.string().min(1).max(5000),
                  description: z.string().optional(),
                  params: z
                    .array(
                      z.object({
                        name: z.string(),
                        type: z.enum(["string", "number", "boolean"]),
                        default: z
                          .union([z.string(), z.number(), z.boolean()])
                          .optional(),
                        description: z.string().optional(),
                      })
                    )
                    .optional(),
                  executor: z
                    .enum(["is-agent", "external-agent", "hybrid"])
                    .optional(),
                  /**
                   * Scheduled cadence (`{cron, enabled}`) — e.g. a radar's
                   * weekly scan. Undeclared here, zod STRIPPED it and the
                   * template's schedule never reached the DB on this door.
                   */
                  schedule: z
                    .object({
                      cron: z.string(),
                      enabled: z.boolean().optional(),
                    })
                    .nullable()
                    .optional(),
                  /**
                   * Entity kind the playbook operates over → persisted to
                   * `playbooks.subject_profile`, making it matchable by
                   * `playbooks.matchForEntity`. Forwarded into the LoopDefinition
                   * below and materialized by `createLoopFromDefinition`.
                   */
                  subjectProfile: z
                    .object({
                      profileSlug: z.string(),
                      filter: z.record(z.string(), z.unknown()).optional(),
                    })
                    .optional(),
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
                  expectedOutputs: z
                    .array(
                      z.object({
                        description: z.string(),
                        type: z.enum(["document", "entities", "csv", "report"]),
                      })
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
         * Optional: populate an existing workspace instead of creating a new one.
         * Used by the chat-first onboarding flow where a minimal workspace is
         * created first, then the AI proposes a definition to populate it.
         */
        workspaceId: z.string().uuid().optional(),
        /**
         * Optional: caller-supplied stable identifier for idempotent re-creates.
         * If a workspace with this proposalId already exists for the user, it
         * is returned untouched. Stamped into `settings.proposalId`.
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

      // Additive template sync for an ALREADY-provisioned workspace. When a
      // caller re-runs createFromDefinition and hits the idempotent "already
      // exists" path, bring the live workspace up to the CURRENT template
      // NON-DESTRUCTIVELY: add missing profiles / property-defs / entityLinks
      // (e.g. an older CRM workspace gaining the `partner` profile + its links),
      // never delete or mutate existing data. This is the automatic re-apply
      // trigger — every consumer that provisions on launch/signup picks up
      // template drift for free. Best-effort: a reconcile failure must never
      // break the (successful) idempotent return, so it is caught + logged.
      //
      // VERSION-AWARE (W2b): the actual compare-and-reconcile lives in the ONE
      // shared `reconcileWorkspaceIfStale` (workspace-creation-service.ts) —
      // the SAME entry point the Hub-door idempotent-create path
      // (`createWorkspaceFromDefinitionIdempotent`) now also calls, so neither
      // door reimplements the hash compare. When it can't compare (no
      // `packageSlug`, or the resolved template carries no version signal —
      // e.g. bundle fallback), fall back to the prior unconditional behavior
      // (reconcile against the caller-supplied `input.definition`) — no
      // regression for that edge.
      const reconcileExisting = async (
        workspaceId: string,
        currentSettings: WorkspaceSettings | null
      ) => {
        // ── 1. Additive profiles / property-defs / views / entityLinks sync.
        const outcome = await reconcileWorkspaceIfStale({
          workspaceId,
          packageSlug: input.packageSlug,
          currentSettings,
          userId: ctx.userId,
        });
        let report: ReconcileReport | undefined;
        // Sync the post-workspace layers only when the template ACTUALLY drifted
        // (a fresh reconcile happened) or when we couldn't version-compare —
        // never on an in-sync no-op, so a reconnect re-trigger stays cheap.
        let syncLayers: boolean;
        if (outcome.checked) {
          report = outcome.report; // in sync (undefined) or freshly reconciled
          // Read the field that MEANS "a reconcile write happened" rather than
          // inferring it from the report's presence (equivalent today, but the
          // report is a payload, not the signal).
          syncLayers = outcome.reconciled;
        } else {
          try {
            report = await reconcileWorkspaceFromDefinition({
              workspaceId,
              userId: ctx.userId,
              definition:
                input.definition as unknown as WorkspaceDefinitionInput,
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId },
              "createFromDefinition: additive template reconcile failed (non-fatal)"
            );
          }
          syncLayers = true;
        }
        // ── 2. Additive playbooks / capabilities / automations / actionPlacements
        // sync — the post-workspace layers reconcileWorkspaceFromDefinition does
        // NOT cover (it only touches profiles/views/entityLinks). The applier is
        // idempotent by (name, workspaceId), so a re-install ADDS playbooks the
        // template gained since first install (e.g. radars) WITHOUT duplicating
        // existing ones. Mirrors the compose-overlay branch; non-fatal.
        //
        // SOURCE MUST MATCH LAYER 1: when the version-aware path resolved a
        // fresh template server-side, build from THAT — not the caller's
        // `input.definition`, which may be a stale cached copy missing exactly
        // the playbook the new version added.
        //
        // ADAPT, DON'T CAST: the resolved value is a PackageDefinitionOutput,
        // whose wire shape differs from the WorkspaceDefinitionOutput this door
        // otherwise receives — graph automations are `automations` there but
        // `flowAutomations` here. Casting silently (a) dropped every
        // template-authored graph automation, and (b) fed flow-shaped rows into
        // the LOOP-trigger mapping, where `auto.trigger` is undefined → TypeError
        // → the whole layer-2 sync (playbooks + capabilities + placements) was
        // swallowed by the catch below. Map the fields explicitly instead.
        if (syncLayers) {
          try {
            const pkg = outcome.packageDefinition;
            const postWorkspaceSource: CreateDefinitionPostWorkspaceSlice = pkg
              ? {
                  playbooks:
                    pkg.playbooks as CreateDefinitionPostWorkspaceSlice["playbooks"],
                  capabilities:
                    pkg.capabilities as CreateDefinitionPostWorkspaceSlice["capabilities"],
                  actionPlacements:
                    pkg.actionPlacements as CreateDefinitionPostWorkspaceSlice["actionPlacements"],
                  // The rename the old cast erased.
                  flowAutomations:
                    pkg.automations as CreateDefinitionPostWorkspaceSlice["flowAutomations"],
                }
              : (input.definition as CreateDefinitionPostWorkspaceSlice);
            await applyPackagePostWorkspace({
              workspaceId,
              body: buildPostWorkspaceBodyFromDefinition(
                postWorkspaceSource,
                workspaceId
              ),
              userId: ctx.userId,
              agentUserId: (ctx as { agentUserId?: string }).agentUserId,
              scopes: [],
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId },
              "createFromDefinition: post-workspace layer reconcile failed (non-fatal)"
            );
          }
        }
        return report;
      };

      // Serialise concurrent calls with the same (userId, proposalId) so a
      // hung retry can't race the original. No-op when proposalId is missing.
      return withWorkspaceProposalIdLock(
        ctx.userId,
        input.proposalId,
        async () => {
          // Idempotency by proposalId — caller-supplied stable key. If a workspace
          // with this proposalId already exists for the user → return it. Mirrors
          // the Hub REST path so DevPlane and Eve see the same row when they ask
          // for "builder-workspace-v1".
          if (input.proposalId) {
            const existingByProposal =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, ctx.userId),
                  drizzleSql`EXISTS (
              SELECT 1 FROM workspaces w
              WHERE w.id = ${workspaceMembers.workspaceId}
                AND w.provisioning_proposal_id = ${input.proposalId}
            )`
                ),
                with: { workspace: true },
              });
            if (existingByProposal?.workspace) {
              const ws = existingByProposal.workspace;
              const wsSettings = ws.settings as WorkspaceSettings | null;
              const provStatus = wsSettings?.provisioningStatus;

              if (provStatus === "failed") {
                logger.warn(
                  {
                    userId: ctx.userId,
                    proposalId: input.proposalId,
                    workspaceId: ws.id,
                    failedStep: wsSettings?.failedStep,
                    completedSteps: wsSettings?.completedSteps,
                  },
                  "createFromDefinition: resuming failed workspace (by proposalId)"
                );
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: {
                    step: "resume",
                    pct: 5,
                    label: `Resuming from step '${wsSettings?.failedStep ?? "unknown"}'`,
                    status: "progress",
                  },
                  userId: ctx.userId,
                });
                const resumeResult = await createWorkspaceFromDefinition({
                  definition: input.definition,
                  userId: ctx.userId,
                  workspaceName: input.workspaceName,
                  createdBy: "user",
                  workspaceType: input.workspaceType,
                  linkedAgentId: input.linkedAgentId,
                  resumeFrom: {
                    workspaceId: ws.id,
                    completedSteps: wsSettings?.completedSteps ?? [],
                  },
                  onProgress: (step, pct, label) => {
                    emitChatEvent({
                      event: "workspace:creation_progress",
                      data: { step, pct, label, status: "progress" },
                      userId: ctx.userId,
                    });
                  },
                });
                return {
                  status: "created" as const,
                  outcome: "created" as const,
                  workspaceId: resumeResult.workspaceId,
                  profileIds: resumeResult.profileIds,
                  viewIds: resumeResult.viewIds,
                };
              }

              logger.info(
                {
                  userId: ctx.userId,
                  proposalId: input.proposalId,
                  workspaceId: ws.id,
                },
                "createFromDefinition: returning existing workspace by proposalId"
              );
              // Opportunistically stamp appId if the caller provides one and
              // the workspace doesn't have it yet (migration path for pre-Phase-1 workspaces).
              if (input.appId && !wsSettings?.appId) {
                try {
                  await db
                    .update(workspaces)
                    .set({
                      settings: {
                        ...(wsSettings ?? {}),
                        appId: input.appId,
                      } satisfies WorkspaceSettings,
                    })
                    .where(eq(workspaces.id, ws.id));
                } catch {
                  /* non-fatal */
                }
              }
              // Active workspace already exists → additively sync it to the
              // current template (add-only). Skipped for non-active (pending)
              // workspaces to avoid racing an in-flight provisioning build.
              const reconciled =
                provStatus === "active"
                  ? await reconcileExisting(ws.id, wsSettings)
                  : undefined;
              return {
                workspaceId: ws.id,
                entityIds: [],
                reconciled,
                // E4 fix: explicit discriminator alongside `reconciled` so a
                // caller doesn't have to infer "reused vs freshly reconciled"
                // from presence/absence of the report.
                outcome: reconciled
                  ? ("reconciled" as const)
                  : ("unchanged" as const),
              };
            }
          }

          // Idempotency: if the user already has a workspace with this packageSlug, return it.
          // "pending" workspaces (creation in progress) are returned as-is so the client can
          // subscribe to progress events. "failed" workspaces are returned with status "failed"
          // so the client can offer a retry button.
          // Prevents duplicate workspaces when the browser re-triggers onboarding on reconnect.
          if (input.packageSlug) {
            const existingMembership =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, ctx.userId),
                  drizzleSql`EXISTS (
              SELECT 1 FROM workspaces w
              WHERE w.id = ${workspaceMembers.workspaceId}
                AND w.package_slug = ${input.packageSlug}
            )`
                ),
                with: { workspace: true },
              });
            if (existingMembership?.workspace) {
              const ws = existingMembership.workspace;
              const wsSettings = ws.settings as WorkspaceSettings | null;
              const provStatus = wsSettings?.provisioningStatus;

              if (provStatus === "failed") {
                // Automatically resume from where the previous attempt failed.
                logger.warn(
                  {
                    userId: ctx.userId,
                    packageSlug: input.packageSlug,
                    workspaceId: ws.id,
                    failedStep: wsSettings?.failedStep,
                    completedSteps: wsSettings?.completedSteps,
                  },
                  "createFromDefinition: resuming failed workspace"
                );
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: {
                    step: "resume",
                    pct: 5,
                    label: `Resuming from step '${wsSettings?.failedStep ?? "unknown"}'`,
                    status: "progress",
                  },
                  userId: ctx.userId,
                });
                // Fall through to createWorkspaceFromDefinition with resumeFrom set
                const resumeResult = await createWorkspaceFromDefinition({
                  definition: input.definition,
                  userId: ctx.userId,
                  packageSlug: input.packageSlug,
                  packageVersion: input.packageVersion,
                  templateId: input.templateId,
                  templateName: input.templateName,
                  workspaceName: input.workspaceName,
                  createdBy: "user",
                  workspaceType: input.workspaceType,
                  linkedAgentId: input.linkedAgentId,
                  resumeFrom: {
                    workspaceId: ws.id,
                    completedSteps: wsSettings?.completedSteps ?? [],
                  },
                  onProgress: (step, pct, label) => {
                    emitChatEvent({
                      event: "workspace:creation_progress",
                      data: { step, pct, label, status: "progress" },
                      userId: ctx.userId,
                    });
                  },
                });
                return {
                  status: "created" as const,
                  outcome: "created" as const,
                  workspaceId: resumeResult.workspaceId,
                  profileIds: resumeResult.profileIds,
                  viewIds: resumeResult.viewIds,
                };
              }

              logger.info(
                {
                  userId: ctx.userId,
                  packageSlug: input.packageSlug,
                  workspaceId: ws.id,
                  provisioningStatus: provStatus,
                },
                "createFromDefinition: returning existing workspace (idempotent)"
              );
              // Active workspace already exists → additively sync it to the
              // current template (add-only). Skipped for pending workspaces to
              // avoid racing an in-flight provisioning build.
              const reconciled =
                provStatus === "active"
                  ? await reconcileExisting(ws.id, wsSettings)
                  : undefined;
              return {
                status:
                  provStatus === "active"
                    ? ("created" as const)
                    : ("pending" as const),
                workspaceId: ws.id,
                reconciled,
                // E4 fix: `status:"created"` above is the pre-existing
                // (overloaded) field, kept for backward-compat. `outcome` is
                // the honest discriminator: this branch is ALWAYS an
                // idempotent re-hit of an already-existing workspace, never a
                // fresh materialization — "reconciled" when drift was synced,
                // "unchanged" when already current OR still pending (no
                // version check was run for a pending workspace).
                outcome: reconciled
                  ? ("reconciled" as const)
                  : ("unchanged" as const),
              };
            }
          }

          // ── Steps 0-0b: Resolve dependencies + compose overlay (shared core)
          // The SAME `materializeWorkspaceCore` the Hub `POST /packages/apply`
          // door drives — so the BROWSER install path composes overlays exactly
          // like the CLI/agent path. Placed AFTER both idempotency short-circuits
          // above (a proposalId/packageSlug re-install returns the existing
          // workspace WITHOUT re-resolving) and BEFORE resolveWorkspaceExtends +
          // the normal create below. `deferCreate:true` keeps THIS door's own
          // richer create path (onProgress/resumeFrom/seed-docs) for the
          // no-compose case — the shared core only resolves + (maybe) composes.
          // The compose reconcile intentionally receives the PRE-extends
          // `input.definition`, preserving the pre-refactor behavior (extends is
          // resolved only for the create path below).
          let resolvedDependencies: ResolvedPackageDependency[] = [];
          if (input.definition.dependencies?.length) {
            let core: MaterializeCoreResult;
            try {
              core = await materializeWorkspaceCore({
                definition:
                  input.definition as unknown as WorkspaceDefinitionInput,
                userId: ctx.userId,
                // The package's own identity for the cycle guard — NOT its
                // subtype (overlays set subtype = base slug). tRPC input carries
                // no `_meta`, so pass the packageSlug explicitly.
                selfSlug: input.packageSlug,
                deferCreate: true,
              });
            } catch (err) {
              // A compose was requested but its base could not be resolved. Do
              // NOT fall through to creating a rogue standalone overlay workspace
              // — surface the reason (mirrors the Hub 422).
              if (err instanceof ComposeBaseUnavailableError) {
                const unresolved = err.dependencies.find(
                  (d) => d.relation === "compose"
                );
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message:
                    unresolved?.message ??
                    "compose base not available — the base template must be installed on the pod first",
                });
              }
              // Resolver failures (cycle, >1 compose dep, wrong-kind) → clean 400.
              if (err instanceof DependencyResolutionError) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `Dependency resolution failed: ${err.message}`,
                });
              }
              // Resolved compose base vanished before load → 404 (as before).
              if (err instanceof ComposeBaseNotFoundError) {
                throw new TRPCError({
                  code: "NOT_FOUND",
                  message: "compose base workspace not found",
                });
              }
              // A compose-overlay reconcile/assert failure → propagate (500),
              // matching the pre-refactor path (which let it throw).
              throw err;
            }
            if (core.status === "composed") {
              // A compose overlay does not create a second workspace, but it
              // still owns post-workspace layers such as playbooks. Apply them
              // to the resolved base before returning; the shared applier is
              // idempotent, so retries and already-installed overlays are safe.
              // Build the body via the SAME converter the normal-create branch
              // uses — the previous `as unknown as PackagePostWorkspaceBody` cast
              // fed loop-style `definition.automations` into the graph-automation
              // applier step, where each threw on an undefined `triggerType` and
              // was silently swallowed (install-path parity bug, Phase 4 4.T1).
              try {
                await applyPackagePostWorkspace({
                  workspaceId: core.composeTargetWorkspaceId,
                  body: buildPostWorkspaceBodyFromDefinition(
                    input.definition as CreateDefinitionPostWorkspaceSlice,
                    core.composeTargetWorkspaceId
                  ),
                  userId: ctx.userId,
                  agentUserId: (ctx as { agentUserId?: string }).agentUserId,
                  scopes: [],
                });
              } catch (err) {
                logger.warn(
                  {
                    err,
                    workspaceId: core.composeTargetWorkspaceId,
                    packageSlug: input.packageSlug,
                  },
                  "compose overlay post-workspace layers failed (non-fatal)"
                );
              }
              auditLog({
                subjectType: "workspaces",
                subjectId: core.composeTargetWorkspaceId,
                action: "update",
                phase: "completed",
                userId: ctx.userId,
                data: { templateSlug: input.packageSlug, composed: true },
              });
              return {
                status: "composed" as const,
                workspaceId: core.composeTargetWorkspaceId,
                composed: true as const,
                dependencies: core.dependencies,
              };
            }
            // status "resolved" — no compose base. Fall through to the normal
            // extends-resolve + create path below with the resolved graph.
            resolvedDependencies = core.dependencies;
          }

          // Workspace composition (north star §10): resolve `definition.extends`
          // into copied profiles/views BEFORE materialization. Cross-workspace
          // reads inside the resolver are access-gated (member / pod_visible /
          // pod_joinable / system) via validateWorkspaceAccess — a caller can
          // only import from a workspace they can see. Best-effort: unreadable
          // or missing sources are skipped, never fatal.
          const { definition: composedDefinition, provenance: composedFrom } =
            await resolveWorkspaceExtends(input.definition, ctx.userId);

          let result: Awaited<ReturnType<typeof createWorkspaceFromDefinition>>;
          try {
            result = await createWorkspaceFromDefinition({
              definition: composedDefinition,
              userId: ctx.userId,
              packageSlug: input.packageSlug,
              packageVersion: input.packageVersion,
              templateId: input.templateId,
              templateName: input.templateName,
              workspaceName: input.workspaceName,
              createdBy: "user",
              workspaceType: input.workspaceType,
              linkedAgentId: input.linkedAgentId,
              // When workspaceId is provided, populate the existing workspace
              // instead of creating a new one (chat-first onboarding flow).
              // "workspace" is in completedSteps to skip the CREATE step.
              ...(input.workspaceId
                ? {
                    resumeFrom: {
                      workspaceId: input.workspaceId,
                      completedSteps: ["workspace"],
                    },
                  }
                : {}),
              onProgress: (step, pct, label) => {
                emitChatEvent({
                  event: "workspace:creation_progress",
                  data: { step, pct, label, status: "progress" },
                  userId: ctx.userId,
                });
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Extract step name from structured error message ("...at step 'X': ...")
            const stepMatch = message.match(/at step '([^']+)'/);
            const failedStep = stepMatch?.[1];
            logger.error(
              {
                err,
                userId: ctx.userId,
                packageSlug: input.packageSlug,
                failedStep,
              },
              "createFromDefinition failed"
            );
            // Emit error progress event so the frontend loading state can show
            // what went wrong instead of spinning indefinitely.
            emitChatEvent({
              event: "workspace:creation_progress",
              data: {
                step: failedStep ?? "error",
                pct: 0,
                label: failedStep
                  ? `Failed at step '${failedStep}': ${message}`
                  : `Creation failed: ${message}`,
                status: "error",
              },
              userId: ctx.userId,
            });
            // Stamp proposalId onto the failed workspace so the next retry can
            // find it via the idempotency check and resume rather than creating
            // a new workspace. Best-effort — a lookup failure here is non-fatal.
            if (input.proposalId) {
              try {
                const failedWs = await db.query.workspaceMembers.findFirst({
                  where: and(
                    eq(workspaceMembers.userId, ctx.userId),
                    drizzleSql`EXISTS (
                      SELECT 1 FROM workspaces w
                      WHERE w.id = ${workspaceMembers.workspaceId}
                        AND w.name = ${input.workspaceName ?? ""}
                        AND w.provisioning_status = 'failed'
                        AND (w.provisioning_proposal_id IS NULL OR w.provisioning_proposal_id = '')
                    )`
                  ),
                  with: { workspace: true },
                });
                if (failedWs?.workspace) {
                  const existingSettings = (failedWs.workspace.settings ??
                    {}) as WorkspaceSettings;
                  await db
                    .update(workspaces)
                    .set({
                      settings: {
                        ...existingSettings,
                        proposalId: input.proposalId,
                        ...(input.appId ? { appId: input.appId } : {}),
                      } satisfies WorkspaceSettings,
                      provisioningProposalId: input.proposalId,
                    })
                    .where(eq(workspaces.id, failedWs.workspace.id));
                }
              } catch {
                // non-fatal
              }
            }

            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: failedStep
                ? `Workspace creation failed at step '${failedStep}': ${message}`
                : `Workspace creation failed: ${message}`,
            });
          }

          // Stamp caller-supplied proposalId/appId + composition provenance into
          // settings. Best-effort: a failure here just means the next call may
          // create a duplicate (proposalId), the workspace won't appear in
          // app-filtered list queries (appId), or imported bricks won't carry a
          // "from <source>" tag (composedFrom).
          if (input.proposalId || input.appId || composedFrom.length > 0) {
            try {
              const ws = await db.query.workspaces.findFirst({
                where: eq(workspaces.id, result.workspaceId),
                columns: { settings: true },
              });
              const existingSettings = (ws?.settings ??
                {}) as WorkspaceSettings;
              await db
                .update(workspaces)
                .set({
                  settings: {
                    ...existingSettings,
                    ...(input.proposalId
                      ? { proposalId: input.proposalId }
                      : {}),
                    ...(input.appId ? { appId: input.appId } : {}),
                    ...(composedFrom.length > 0 ? { composedFrom } : {}),
                  } satisfies WorkspaceSettings,
                  ...(input.proposalId
                    ? { provisioningProposalId: input.proposalId }
                    : {}),
                })
                .where(eq(workspaces.id, result.workspaceId));
            } catch (err) {
              logger.warn(
                {
                  err,
                  workspaceId: result.workspaceId,
                  proposalId: input.proposalId,
                  appId: input.appId,
                },
                "Failed to stamp proposalId/appId/composedFrom into workspace settings (non-fatal)"
              );
            }
          }

          // Seed entity bodies through the canonical body door (EntityBodyService).
          const entitiesWithContent = (input.definition.suggestedEntities ?? [])
            .map((entity, idx) => ({ entity, entityId: result.entityIds[idx] }))
            .filter(
              (e): e is typeof e & { entity: { content: string } } =>
                !!e.entity.content && !!e.entityId
            );

          if (entitiesWithContent.length > 0) {
            const database = await getDb();
            // Shared singleton, not a fresh hookless instance — see note above.
            const evRepo = eventRepository;
            const entityBodyService = new EntityBodyService(database, evRepo);
            const entRepo = new EntityRepository(database, evRepo);

            for (const { entity, entityId } of entitiesWithContent) {
              try {
                // B4 FIX: this loop used to materialize EVERY seed body into a
                // document unconditionally (and never wrote a v1 snapshot). It
                // now runs the SAME heuristic as every other writer — long-form
                // → a versioned document (with a real v1 snapshot), short →
                // inline properties.content. Provisioning write → `system`
                // provenance.
                const body = await entityBodyService.setBody({
                  entityId,
                  userId: ctx.userId,
                  workspaceId: result.workspaceId,
                  title: entity.title,
                  provenance: {
                    createdByKind: "system",
                    createdByUserId: ctx.userId,
                  },
                  text: entity.content,
                });
                if (body.documentId) {
                  // Link entity → document (single direction — no backlink needed)
                  await entRepo.update(
                    entityId,
                    { documentId: body.documentId },
                    ctx.userId
                  );
                } else if (body.inlineContent !== undefined) {
                  // Short seed body stays inline (merged into properties).
                  await entRepo.update(
                    entityId,
                    { properties: { content: body.inlineContent } },
                    ctx.userId
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, entityId, title: entity.title },
                  "Failed to seed body for entity (non-fatal)"
                );
              }
            }
          }

          // ── Post-workspace layers (capabilities + the autonomy loop) ────────────
          // ONE shared door with Hub `POST /packages/apply` — `applyPackagePostWorkspace`.
          // The `{playbooks · automations}` sub-contract IS an autonomy loop, so it is
          // passed as ONE `loops[]` entry (the shared door runs the SAME governed
          // `createLoopFromDefinition` primitive) — preserving the playbook-trigger
          // semantics — while `capabilities` (→ tools + skills + vault + capability-
          // embedded automations/playbooks) install alongside. Before this the tRPC/
          // browser door installed NO capabilities and hand-rolled the loop inline; now
          // both doors converge on the one door. `definition.tools` is intentionally
          // dropped: tools arrive through capabilities (the governed substrate) — the old
          // inline `tools` TODO is retired here.
          // The `{playbooks · automations}` sub-contract is built into the shared
          // body by `buildPostWorkspaceBodyFromDefinition` — the ONE builder the
          // compose-overlay branch uses too, so loop-style automations can never
          // be misrouted into the graph-automation applier step.
          const postBody = buildPostWorkspaceBodyFromDefinition(
            input.definition as CreateDefinitionPostWorkspaceSlice,
            result.workspaceId
          );
          const hasPostWork = Boolean(
            postBody.capabilities?.length ||
            postBody.loops?.length ||
            postBody.automations?.length ||
            postBody.actionPlacements?.length
          );
          if (hasPostWork) {
            try {
              const post = await applyPackagePostWorkspace({
                workspaceId: result.workspaceId,
                body: postBody,
                userId: ctx.userId,
                agentUserId: (ctx as { agentUserId?: string }).agentUserId,
                scopes: [],
              });
              logger.info(
                { workspaceId: result.workspaceId, layers: Object.keys(post) },
                "createFromDefinition: post-workspace layers applied (shared door)"
              );
            } catch (err) {
              logger.error(
                { err, workspaceId: result.workspaceId },
                "Failed to apply declared post-workspace layers"
              );
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message:
                  "Workspace was created but its declared workflow setup could not be completed. Reconcile it before use.",
              });
            }
          }

          // Enqueue workspace-init for default whiteboard/commands
          // (skips default views when packageSlug is set)
          try {
            const boss = getBoss();
            await boss.send("workspace-init", {
              workspaceId: result.workspaceId,
              userId: ctx.userId,
              packageSlug: input.packageSlug,
            });
          } catch (err) {
            logger.warn(
              { err, workspaceId: result.workspaceId },
              "Failed to enqueue workspace-init (non-fatal)"
            );
          }

          auditLog({
            subjectType: "workspaces",
            action: "create",
            phase: "completed",
            subjectId: result.workspaceId,
            userId: ctx.userId,
            data: {
              id: result.workspaceId,
              packageSlug: input.packageSlug,
              createdBy: "user",
            },
          });

          emitSideEffects({
            subjectType: "workspace",
            action: "create",
            subjectId: result.workspaceId,
            userId: ctx.userId,
          });

          // Materialize pod owner/admins into the new workspace when it is
          // pod-visible — same gate + rationale as `workspaces.create`. The
          // created workspace row is the authoritative visibility source (the
          // definition's `workspaceVisibility` was stamped into `settings`).
          // Best-effort/non-fatal.
          try {
            const createdWs = await db.query.workspaces.findFirst({
              where: eq(workspaces.id, result.workspaceId),
              columns: { settings: true },
            });
            if (isPodReadableWorkspace(createdWs?.settings)) {
              await materializePodAdminsIntoWorkspace(result.workspaceId);
            }
          } catch (err) {
            logger.warn(
              { err, workspaceId: result.workspaceId },
              "Failed to materialize pod admins into new pod-visible workspace (non-fatal)"
            );
          }

          return {
            status: "created" as const,
            outcome: "created" as const,
            workspaceId: result.workspaceId,
            profileIds: result.profileIds,
            viewIds: result.viewIds,
            entityIds: result.entityIds,
            // Surface any resolved `require`/non-workspace deps so the browser
            // post-install confirmation can show what was installed alongside.
            dependencies: resolvedDependencies,
          };
        }
      ); // close withWorkspaceProposalIdLock
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
  reconcileFromDefinition: protectedProcedure
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

      const report = await reconcileWorkspaceFromDefinition({
        workspaceId: input.workspaceId,
        userId: ctx.userId,
        definition: input.definition as unknown as WorkspaceDefinitionInput,
        dryRun: input.dryRun,
      });
      if (
        !input.dryRun &&
        (input.definition.capabilities?.length ||
          input.definition.playbooks?.length ||
          input.definition.flowAutomations?.length ||
          input.definition.actionPlacements?.length)
      ) {
        try {
          // Same builder as the create/compose branches — reconcile definitions
          // carry LOOP-style playbooks (grants as {kind, ref}[]), so the raw
          // cast fed them into the graph-shaped applier where grants silently
          // resolved to nothing. One builder = install and reconcile stay in
          // lockstep (same loop routing, same grant materialization).
          await applyPackagePostWorkspace({
            workspaceId: input.workspaceId,
            body: buildPostWorkspaceBodyFromDefinition(
              input.definition as unknown as CreateDefinitionPostWorkspaceSlice,
              input.workspaceId
            ),
            userId: ctx.userId,
            agentUserId: (ctx as { agentUserId?: string }).agentUserId,
            scopes: [],
          });
        } catch (err) {
          logger.error(
            { err, workspaceId: input.workspaceId },
            "reconcileFromDefinition post-workspace layers failed"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "Workflow reconciliation did not complete. Earlier additive layers may have applied; after resolving the error, retry safely to finish the idempotent reconciliation.",
          });
        }
      }
      return report;
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
   * - "create": creates a new workspace (delegates to createFromDefinition)
   * - "update": populates/updates an existing workspace (skips workspace/profiles/views creation)
   *
   * Idempotent: entities and relations are upserted by their natural keys.
   */
  applyDefinition: protectedProcedure
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
        const { ProfileRepository } = await import("@synap/database");
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
            errors.push({
              stage: "profiles",
              refKey: e.profileSlug,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Check existing entities for idempotency
        const existingEntities = await database.query.entities.findMany({
          where: and(
            eq(entities.userId, ctx.userId),
            eq(entities.workspaceId, input.workspaceId)
          ),
          columns: { id: true, type: true, title: true },
        });
        const existingEntityKeys = new Map<string, string>();
        for (const e of existingEntities) {
          existingEntityKeys.set(`${e.type}:${e.title}`, e.id);
        }

        // Create entities
        const entityIds: Record<string, string> = {};
        let entitiesCreated = 0;
        let entitiesSkipped = 0;
        const entityRepo = new EntityRepository(database, eventRepo);

        for (const e of allEntities) {
          const cacheKey = `${e.profileSlug}:${e.title}`;
          const refKey = e.refKey ?? cacheKey;

          if (existingEntityKeys.has(cacheKey)) {
            entityIds[refKey] = existingEntityKeys.get(cacheKey)!;
            entitiesSkipped++;
            continue;
          }

          const profileId = profileCache.get(e.profileSlug);
          if (!profileId) {
            errors.push({
              stage: "entities",
              refKey,
              error: `Profile ${e.profileSlug} not found`,
            });
            continue;
          }

          try {
            const result = await entityRepo.create(
              {
                profileId,
                title: e.title,
                properties: e.properties,
                systemData: ONBOARDING_SCAFFOLD_SYSTEM_DATA,
                workspaceId: input.workspaceId,
                userId: ctx.userId,
                createdByKind: "system",
                skipValidation: true,
              },
              ctx.userId
            );
            entityIds[refKey] = result.id;
            entitiesCreated++;
          } catch (err) {
            errors.push({
              stage: "entities",
              refKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 3. Batch create relations
        const relationRepo = new RelationRepository(database, eventRepo);
        // D4: placement is a function of the endpoints, not the ambient
        // workspace — an idempotency check filtered to this workspace can't
        // see a pod-wide (NULL) duplicate of the same (source,target,type)
        // triple, so it would re-create it. Same fix as relations.batchCreate.
        const seededEntityIds = Object.values(entityIds);
        const endpointRows = seededEntityIds.length
          ? await database.query.entities.findMany({
              where: inArray(entities.id, seededEntityIds),
              columns: { id: true, workspaceId: true },
            })
          : [];
        const endpointWorkspaceById = new Map(
          endpointRows.map((e) => [e.id, e.workspaceId])
        );
        const existingRelations = await database.query.relations.findMany({
          columns: { sourceEntityId: true, targetEntityId: true, type: true },
        });
        const existingRelKeys = new Set<string>();
        for (const r of existingRelations) {
          existingRelKeys.add(
            `${r.sourceEntityId}:${r.targetEntityId}:${r.type}`
          );
        }

        let relationsCreated = 0;
        let relationsSkipped = 0;

        for (const rel of input.definition.suggestedRelations ?? []) {
          const sourceId = entityIds[rel.sourceRef];
          const targetId = entityIds[rel.targetRef];
          if (!sourceId || !targetId) {
            errors.push({
              stage: "relations",
              refKey: `${rel.sourceRef}->${rel.targetRef}`,
              error: `Source or target entity not found: ${rel.sourceRef}=${sourceId}, ${rel.targetRef}=${targetId}`,
            });
            continue;
          }

          const key = `${sourceId}:${targetId}:${rel.type}`;
          if (existingRelKeys.has(key)) {
            relationsSkipped++;
            continue;
          }

          try {
            const relationWorkspaceId = inheritRelationWorkspaceId(
              [
                endpointWorkspaceById.get(sourceId) ?? null,
                endpointWorkspaceById.get(targetId) ?? null,
              ],
              input.workspaceId
            );
            await relationRepo.create(
              {
                sourceEntityId: sourceId,
                targetEntityId: targetId,
                type: rel.type,
                workspaceId: relationWorkspaceId,
                userId: ctx.userId,
                metadata: rel.metadata,
              },
              ctx.userId
            );
            relationsCreated++;
          } catch (err) {
            errors.push({
              stage: "relations",
              refKey: `${rel.sourceRef}->${rel.targetRef}`,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

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

      // ── CREATE mode ─────────────────────────────────────────────────────
      const database = await getDb();
      // Shared singleton — a fresh EventRepository has no registered hooks, so
      // its emitCompleted() append would silently never reach the
      // realtime/materialization/sync hooks.
      const eventRepo = eventRepository;

      // Resolve template-composition dependencies + compose overlays through the
      // SAME shared core the in-app `createFromDefinition` door drives, so a
      // COMPOSED template (`dependencies[]`) applied via this devplane door
      // resolves its deps instead of skipping composition. `deferCreate:true`
      // keeps this door's own create for the no-compose case (whose entity tail
      // below reads `createResult.entityIds`). Only runs when deps are declared —
      // a plain definition skips it and creates byte-for-byte as before.
      let composedTarget: string | null = null;
      if (
        (input.definition as { dependencies?: unknown[] }).dependencies?.length
      ) {
        let core: MaterializeCoreResult;
        try {
          core = await materializeWorkspaceCore({
            definition: input.definition as unknown as WorkspaceDefinitionInput,
            userId: ctx.userId,
            deferCreate: true,
          });
        } catch (err) {
          if (err instanceof ComposeBaseUnavailableError) {
            const unresolved = err.dependencies.find(
              (d) => d.relation === "compose"
            );
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                unresolved?.message ??
                "compose base not available — the base template must be installed on the pod first",
            });
          }
          if (err instanceof DependencyResolutionError) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Dependency resolution failed: ${err.message}`,
            });
          }
          if (err instanceof ComposeBaseNotFoundError) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "compose base workspace not found",
            });
          }
          throw err;
        }
        if (core.status === "composed") {
          composedTarget = core.composeTargetWorkspaceId;
        }
      }

      let workspaceId: string;
      let createResult: Awaited<
        ReturnType<typeof createWorkspaceFromDefinition>
      > | null = null;
      if (composedTarget) {
        // Overlay layered onto its existing base — no new workspace.
        workspaceId = composedTarget;
      } else {
        createResult = await createWorkspaceFromDefinition({
          definition: input.definition as WorkspaceDefinitionInput,
          userId: ctx.userId,
          workspaceName: input.definition.workspaceName,
          createdBy: "user",
          workspaceType: "personal",
          onProgress: () => {},
        });
        workspaceId = createResult.workspaceId;
      }

      // After workspace is created/composed, apply entities and relations
      const relationRepo = new RelationRepository(database, eventRepo);
      const relDefRepo = new RelationDefRepository(database);

      // Entity IDs. On the create path they come back positionally from
      // createFromDefinition. On the compose path the shared reconcile is
      // schema-only (never seeds entity INSTANCES), so seed the definition's
      // entities onto the base workspace here via the canonical EntityRepository.
      const entityIds: Record<string, string> = {};
      const allEntities =
        input.definition.suggestedEntities ??
        input.definition.seedEntities ??
        [];
      if (composedTarget) {
        const { ProfileRepository } = await import("@synap/database");
        const profileRepo = new ProfileRepository(database);
        const entityRepo = new EntityRepository(database, eventRepo);
        const existingProfiles = await profileRepo.getAccessibleProfiles(
          ctx.userId,
          workspaceId
        );
        const profileCache = new Map<string, string>(
          existingProfiles.map((p) => [p.slug, p.id])
        );
        for (const e of allEntities) {
          const refKey = e.refKey ?? `${e.profileSlug}:${e.title}`;
          const profileId = profileCache.get(e.profileSlug);
          if (!profileId) {
            errors.push({
              stage: "entities",
              refKey,
              error: `Profile ${e.profileSlug} not found on compose base`,
            });
            continue;
          }
          try {
            const created = await entityRepo.create(
              {
                profileId,
                title: e.title,
                properties: e.properties,
                systemData: ONBOARDING_SCAFFOLD_SYSTEM_DATA,
                workspaceId,
                userId: ctx.userId,
                createdByKind: "system",
                skipValidation: true,
              },
              ctx.userId
            );
            entityIds[refKey] = created.id;
          } catch (err) {
            errors.push({
              stage: "entities",
              refKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        const createEntityIds = (createResult as any)?.entityIds ?? [];
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

      // Create relations
      let relationsCreated = 0;
      let relationsSkipped = 0;
      for (const rel of input.definition.suggestedRelations ?? []) {
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
        entitiesCreated: allEntities.length,
        entitiesSkipped: 0,
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
