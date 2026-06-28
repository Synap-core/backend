/**
 * Hub REST — Packages (unified template provisioning)
 *
 * ONE endpoint that provisions a complete workspace from a PackageDefinition.
 * Phase 1: workspace (profiles, views, entities, relations, sidebar, bento).
 * Phase 2+: capabilities, automations, playbooks, loops, agents, channels.
 *
 * Composes the existing createWorkspaceFromDefinitionIdempotent — no duplication.
 */

import { z } from "zod";
import type { HubHono } from "./_shared.js";
import { createWorkspaceFromDefinitionIdempotent } from "../../../services/workspace-creation-service.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { auditLog } from "../../../utils/audit-log.js";

const PackageApplySchema = z.object({
  _meta: z
    .object({
      slug: z.string().optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      tags: z.array(z.string()).optional(),
      requiredTier: z.string().nullable().optional(),
      isPublic: z.boolean().optional(),
      version: z.string().optional(),
    })
    .optional(),
  // Workspace fields — passthrough to WorkspaceDefinitionInput
  workspaceName: z.string().optional(),
  description: z.string().optional(),
  workspacePurpose: z
    .enum(["personal", "project", "agent", "library", "operational"])
    .optional(),
  workspaceSubtype: z.string().optional(),
  workspaceVisibility: z
    .enum(["private", "members", "pod_visible", "pod_joinable", "public_link"])
    .optional(),
  workspaceCapabilities: z.array(z.string()).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  profiles: z.array(z.record(z.string(), z.unknown())).optional(),
  views: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedEntities: z.array(z.record(z.string(), z.unknown())).optional(),
  suggestedRelations: z.array(z.record(z.string(), z.unknown())).optional(),
  displayTemplates: z.array(z.record(z.string(), z.unknown())).optional(),
  entityLinks: z.array(z.record(z.string(), z.unknown())).optional(),
  bentoLayout: z.array(z.record(z.string(), z.unknown())).optional(),
  profileEntityBentoTemplates: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional(),
  layoutConfig: z.record(z.string(), z.unknown()).optional(),
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
  // Future layers (Phase 2+) — accepted but not yet provisioned
  capabilities: z.array(z.record(z.string(), z.unknown())).optional(),
  automations: z.array(z.record(z.string(), z.unknown())).optional(),
  playbooks: z.array(z.record(z.string(), z.unknown())).optional(),
  loops: z.array(z.record(z.string(), z.unknown())).optional(),
  agents: z.array(z.record(z.string(), z.unknown())).optional(),
  channels: z.array(z.record(z.string(), z.unknown())).optional(),
});

export function registerPackagesRoutes(app: HubHono): void {
  /**
   * POST /api/hub/packages/apply
   *
   * Provisions a complete workspace from a PackageDefinition. Phase 1 handles
   * the workspace layer (profiles, views, entities, relations, sidebar, bento).
   * Future layers (capabilities, automations, playbooks, etc.) are accepted in
   * the schema but return `{ status: "skipped" }` until implemented.
   */
  app.post("/api/hub/packages/apply", async (c) => {
    const userId = c.get("userId");
    const body = PackageApplySchema.parse(await c.req.json());

    // ── Permission check ──────────────────────────────────────────────────
    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "workspace",
      action: "create",
      data: { name: body.workspaceName ?? body._meta?.slug ?? "untitled" },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    // ── Step 1: Create workspace ──────────────────────────────────────────
    const result: Record<string, unknown> = {};

    try {
      const workspace = await createWorkspaceFromDefinitionIdempotent({
        definition: body as any,
        userId,
        proposalId: body._meta?.slug ?? undefined,
        workspaceName: body.workspaceName,
        templateId: body._meta?.slug ?? undefined,
        packageSlug: body._meta?.slug,
      });

      result.workspace = {
        status: "created",
        workspaceId: workspace.workspaceId,
      };

      auditLog({
        subjectType: "workspace",
        subjectId: workspace.workspaceId,
        action: "create",
        phase: "completed",
        userId,
        data: {
          templateSlug: body._meta?.slug,
          profiles: body.profiles?.length ?? 0,
          views: body.views?.length ?? 0,
        },
      });
    } catch (e) {
      return c.json(
        { error: "Workspace creation failed", detail: (e as Error).message },
        500
      );
    }

    // ── Future layers: report skipped until Phase 2+ ──────────────────────
    const futureLayers = [
      "capabilities",
      "automations",
      "playbooks",
      "loops",
      "agents",
      "channels",
    ] as const;

    for (const layer of futureLayers) {
      const items = (body as any)[layer];
      if (items?.length) {
        result[layer] = {
          status: "skipped",
          count: items.length,
          reason: `${layer} provisioning not yet implemented (Phase 2+)`,
        };
      }
    }

    return c.json(result, 201);
  });
}
