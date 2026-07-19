/**
 * Hub REST — Packages (unified template provisioning)
 *
 * ONE endpoint that provisions a complete workspace from a PackageDefinition:
 * workspace (Phase 1) + capabilities, automations, playbooks, loops (Phase 2).
 * Each layer delegates to its existing canonical service — pure composition.
 */

import { z } from "zod";
import type { HubHono } from "./_shared.js";
import {
  materializeWorkspaceCore,
  ComposeBaseUnavailableError,
  DependencyResolutionError,
  ComposeBaseNotFoundError,
  ComposeOverlayError,
} from "../../../services/workspace-materialization-service.js";
import { applyPackagePostWorkspace } from "../../../services/package-apply-post-workspace.js";
import type { DependencySeedOutcome } from "../../../services/package-dependency-resolver.js";
import type { WorkspaceDefinitionInput } from "@synap/database";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { auditLog } from "../../../utils/audit-log.js";

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const ParamSpecSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "number", "entity", "choice", "boolean"]),
  label: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
});

const CapabilitySchema = z.object({
  templateKey: z.string().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const AutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  triggerType: z.enum(["event", "cron", "webhook", "manual"]),
  triggerConfig: z.record(z.string(), z.unknown()).default({}),
  flowDefinition: z
    .object({
      nodes: z.array(z.record(z.string(), z.unknown())),
      edges: z.array(z.record(z.string(), z.unknown())),
    })
    .optional(),
  status: z.enum(["draft", "active", "paused"]).default("active"),
});

const PlaybookSchema = z.object({
  name: z.string().min(1).max(500),
  description: z.string().optional(),
  goalTemplate: z.string(),
  params: z.array(ParamSpecSchema).optional(),
  executor: z
    .enum(["is-agent", "external-agent", "hybrid"])
    .default("is-agent"),
  inputStrategy: z.record(z.string(), z.unknown()).optional(),
  channelSpec: z.record(z.string(), z.unknown()).optional(),
  schedule: z.unknown().optional(),
  grants: z.array(z.string()).optional(),
  // Which entity kind this playbook operates on. Load-bearing: `subject_profile`
  // is what `playbooks.matchForEntity` keys on to surface a playbook for a
  // captured entity. A plain z.object strips undeclared keys, so this MUST be
  // declared here or template-seeded playbooks reach the DB with subject_profile
  // NULL and never match.
  subjectProfile: z
    .object({
      profileSlug: z.string(),
      filter: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  status: z.enum(["draft", "active", "paused"]).default("active"),
});

const LoopSchema = z.object({
  templateKey: z.string().optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const PackageApplySchema = z.object({
  _meta: z
    .object({
      slug: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      version: z.string().optional(),
    })
    .optional(),
  // Workspace fields — passthrough to WorkspaceDefinitionInput
  workspaceName: z.string().optional(),
  description: z.string().optional(),
  workspaceType: z
    .enum(["personal", "agent", "project", "operational"])
    .optional(),
  workspaceSubtype: z.string().optional(),
  /**
   * Optional project to link this workspace's seed entities to. When provided,
   * every seed entity is stamped `belongs_to_project` so the project lens sees
   * the workspace's data. This is what unifies an Agent OS under one project.
   */
  projectId: z.string().uuid().optional(),
  workspaceVisibility: z
    .enum(["private", "members", "pod_visible", "pod_joinable", "public_link"])
    .optional(),
  workspaceCapabilities: z.array(z.string()).optional(),
  sourceRoles: z
    .record(z.string(), z.enum(["provider", "consumer", "provider-consumer"]))
    .optional(),
  defaultSources: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  profiles: z.array(z.record(z.string(), z.unknown())).optional(),
  views: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedEntities: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedRelations: z.array(z.record(z.string(), z.unknown())).optional(),
  displayTemplates: z.array(z.record(z.string(), z.unknown())).optional(),
  entityLinks: z.array(z.record(z.string(), z.unknown())).optional(),
  // Authored dashboard-view name for the bento. Emitted by BOTH converters
  // (define.ts toWorkspaceDefinition + toPackageDefinition) and consumed by the
  // pod (create-workspace-from-definition.ts: `name: definition.bentoViewName ??
  // "Home"`). A plain z.object STRIPS any undeclared key, so omitting this
  // silently renamed every Hub / `synap launch` / packages-apply install's bento
  // view to "Home" while the tRPC door (which declares it) kept the real name.
  // Sibling field of bentoViewBlocks, one drop away — parity guarded in
  // workspace-templates/scripts/check-converters.mjs (converter half).
  bentoViewName: z.string().optional(),
  bentoLayout: z.array(z.record(z.string(), z.unknown())).optional(),
  // The bento union splits into TWO wire fields (widgets → bentoLayout,
  // views → bentoViewBlocks). This is a plain z.object, so an undeclared field
  // is STRIPPED before the pod sees it. Declaring only bentoLayout silently
  // dropped every view bento-block on the Hub / `synap launch` / packages-apply
  // path (grants authors 2). The tRPC createFromDefinition door already declares
  // it (workspaces.ts:2456) and the pod consumes it
  // (create-workspace-from-definition.ts:1373) — this closes the inbound half of
  // the bento seam whose outbound half shipped in bfdf0700.
  bentoViewBlocks: z.array(z.record(z.string(), z.unknown())).optional(),
  profileEntityBentoTemplates: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  layoutConfig: z.record(z.string(), z.unknown()).optional(),
  onboarding: z.record(z.string(), z.unknown()).optional(),
  extends: z
    .array(
      z.object({
        source: z.string(),
        import: z
          .object({
            profiles: z.array(z.string()).optional(),
            views: z.array(z.string()).optional(),
          })
          .optional(),
      })
    )
    .optional(),
  // Phase 2 layers
  capabilities: z.array(CapabilitySchema).optional(),
  automations: z.array(AutomationSchema).optional(),
  playbooks: z.array(PlaybookSchema).optional(),
  loops: z.array(LoopSchema).optional(),
  // Template-composition dependencies — resolved BEFORE the workspace step.
  // Mirrors TemplateDependency in @synap-core/workspace-templates verbatim.
  dependencies: z
    .array(
      z.object({
        slug: z.string().min(1),
        kind: z
          .enum(["workspace", "capability", "automation"])
          .default("workspace"),
        relation: z.enum(["compose", "require"]).default("require"),
        reason: z.string().optional(),
      })
    )
    .optional(),
});

// ─── Route registration ──────────────────────────────────────────────────────

export function registerPackagesRoutes(app: HubHono): void {
  // The hub app is mounted at /api/hub, so routes are registered RELATIVE
  // (like every sibling: /workspaces, /capabilities). An absolute
  // "/api/hub/packages/apply" here double-prefixes to /api/hub/api/hub/... and 404s.
  app.post("/packages/apply", async (c) => {
    const userId = c.get("userId");
    const agentUserId = c.get("agentUserId") ?? undefined;
    const body = PackageApplySchema.parse(await c.req.json());
    const result: Record<string, unknown> = {};

    // ── Permission check ──────────────────────────────────────────────────
    // Store the FULL package body as `definition` so the workspace/create
    // approve executor can re-run materializeWorkspaceCore on approval.
    // Name-only data was the Phase-0 bug: approve had nothing to materialize.
    const perm = await checkPermissionOrPropose({
      userId,
      agentUserId,
      subjectType: "workspace",
      action: "create",
      data: {
        name: body.workspaceName ?? body._meta?.slug ?? "untitled",
        definition: body,
        workspaceName: body.workspaceName,
        templateId: body._meta?.slug,
        packageSlug: body._meta?.slug,
        workspaceType: body.workspaceType,
        proposalId: body._meta?.slug,
        createdBy: "provisioning",
        source: "packages.apply",
      },
    });
    if ("denied" in perm && perm.denied)
      return c.json({ error: perm.reason }, 403);
    if (
      "proposalId" in perm &&
      perm.proposalId &&
      !("granted" in perm && perm.granted)
    )
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);

    // ── Steps 0-1: Resolve dependencies + create-or-compose (shared core) ──
    // The dependency-resolve + compose-overlay logic is the ONE shared door
    // core (`materializeWorkspaceCore`) that the tRPC `createFromDefinition`
    // path also drives. This door owns only the mapping into `result.workspace`
    // / `result.dependencies`, the audit stamp, and the 4xx/5xx bodies below.
    let workspaceId: string | undefined;
    try {
      const core = await materializeWorkspaceCore({
        definition: body as unknown as WorkspaceDefinitionInput,
        userId,
        agentUserId,
        selfSlug: body._meta?.slug,
        // Idempotent-create passthrough — the EXACT args this door passed to
        // createWorkspaceFromDefinitionIdempotent before (Hub never defers).
        proposalId: body._meta?.slug ?? undefined,
        workspaceName: body.workspaceName,
        templateId: body._meta?.slug ?? undefined,
        packageSlug: body._meta?.slug,
        workspaceType: body.workspaceType,
      });
      // Surface the resolved dependency graph only when deps were declared —
      // matches the pre-refactor response (key omitted for no-dep applies).
      if (body.dependencies?.length) {
        result.dependencies = core.dependencies;
        // Top-level rollup of dependencies[].seedOutcome — the other silent-
        // success gap: a caller previously had to scan the array itself to
        // answer "did everything seed?". `attempted` counts every dependency
        // seeding was actually run for (installed/composed with capabilities
        // or playbooks to seed); a dep with no such layers ("no-layers") is
        // NOT a failure and is excluded from `attempted`. Non-fatal semantics
        // unchanged — this is a read-only summary, not a new failure mode.
        const seedOutcomes = core.dependencies
          .map((d) => d.seedOutcome)
          .filter((o): o is DependencySeedOutcome => !!o);
        result.seedSummary = {
          attempted: seedOutcomes.length,
          seeded: seedOutcomes.filter((o) => o.status === "seeded").length,
          failed: seedOutcomes
            .filter((o) => o.status === "failed")
            .map((o) => ({ slug: o.slug, error: o.error ?? "unknown error" })),
        };
      }
      if (core.status === "composed") {
        workspaceId = core.workspaceId;
        result.workspace = {
          status: "composed",
          workspaceId,
          onto: core.composeTargetWorkspaceId,
          reconcile: {
            profilesAdded: core.reconcile.profiles.added,
            propertiesAdded: core.reconcile.properties.added.length,
            viewsAdded: core.reconcile.views.added,
            entityLinksAdded: core.reconcile.entityLinks.added,
            propertyConflicts: core.reconcile.properties.conflicts,
          },
        };
        auditLog({
          subjectType: "workspace",
          subjectId: workspaceId,
          action: "update",
          phase: "completed",
          userId,
          data: { templateSlug: body._meta?.slug, composed: true },
        });
      } else if (core.status === "created") {
        // Hub never passes deferCreate, so the core never returns "resolved".
        workspaceId = core.workspaceId;
        result.workspace = {
          status: "created",
          workspaceId: core.workspaceId,
          // Explicit discriminator (E4 fix) — `status:"created"` above is kept
          // for backward-compat, but a caller should read `outcome` to tell a
          // genuine new-workspace materialization apart from an idempotent
          // re-hit that was reconciled or left unchanged. See
          // `CreateWorkspaceFromDefinitionResult.outcome` for the derivation.
          outcome: core.created.outcome,
          // Set when an idempotent re-hit was additively synced to a newer
          // template (W2b, `reconcileWorkspaceIfStale`) instead of a silent
          // no-op — lets the CLI/agent caller see drift was picked up.
          ...(core.created.reconciled
            ? { reconciled: core.created.reconciled }
            : {}),
        };
        auditLog({
          subjectType: "workspace",
          subjectId: core.workspaceId,
          action: "create",
          phase: "completed",
          userId,
          data: { templateSlug: body._meta?.slug },
        });
      }
    } catch (e) {
      if (e instanceof ComposeBaseUnavailableError) {
        // A compose was requested but its base could not be resolved (e.g. a
        // private CP-only base with no built-in template). Do NOT fall back to
        // creating a rogue overlay workspace — surface the reason instead.
        const unresolved = e.dependencies.find((d) => d.relation === "compose");
        return c.json(
          {
            error: "compose base not available",
            detail:
              unresolved?.message ??
              "the compose base template must be installed on the pod first",
            dependencies: e.dependencies,
          },
          422
        );
      }
      if (e instanceof DependencyResolutionError) {
        // Cycle, >1 compose dep, or wrong-kind compose → a clear 422.
        return c.json(
          { error: "Dependency resolution failed", detail: e.message },
          422
        );
      }
      if (
        e instanceof ComposeBaseNotFoundError ||
        e instanceof ComposeOverlayError
      ) {
        return c.json(
          { error: "Compose overlay failed", detail: (e as Error).message },
          500
        );
      }
      // The remaining case is an idempotent-create failure.
      return c.json(
        { error: "Workspace creation failed", detail: (e as Error).message },
        500
      );
    }

    // ── Steps 1b–6: enroll agent + capabilities/automations/playbooks/loops
    // + project links — ONE shared door with the workspace/create approve path.
    if (workspaceId) {
      const post = await applyPackagePostWorkspace({
        workspaceId,
        body,
        userId,
        agentUserId,
        scopes: c.get("scopes") ?? [],
      });
      Object.assign(result, post);
    }

    return c.json(result, 201);
  });
}
