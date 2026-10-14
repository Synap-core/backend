/**
 * Hub Protocol REST — POST /pod/adopt
 *
 * Adopt an orphan/ad-hoc workspace into a known template through the ONE
 * template apply (`applyTemplate`, adopt mode): the space takes the template
 * identity (slug + key, the one writer), layer 1 re-syncs it additively from
 * the catalog (`resolveWorkspaceTemplate`, cache-first; its own capabilities
 * merged, not replaced), layer 2 runs, and the version is stamped only on
 * convergence — never destructive, never a second workspace. The approve
 * executor `workspace/adopt` runs the same apply.
 *
 * Governed via `checkPermissionOrPropose` (subjectType:"workspace",
 * action:"adopt") — RBAC (`verifyPermission`) enforces the same editor+ floor
 * `ADOPT_WRITE_ROLES` (workspace-creation-service.ts) uses for the analogous
 * legacy-identity adopt, then the agent-governance ladder decides
 * grant-vs-propose. Never widens a floor beyond what that existing path grants.
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  eq,
  workspaces,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { resolveWorkspaceTemplate } from "../../../services/capabilities/resolve-workspace-template.js";
import {
  applyTemplate,
  type TemplateApplyResult,
} from "../../../services/template-apply/index.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";

const PodAdoptSchema = z.object({
  workspaceId: z.string().uuid(),
  templateSlug: z.string().min(1),
});

/**
 * The adopt reply, from the one apply's result. `outcome` is "reconciled"
 * (adopted / re-synced) or "unchanged" (already this template's at this
 * version) — never "created": adopt only operates on an existing space.
 */
export function adoptReply(
  applied: TemplateApplyResult,
  templateSlug: string,
  version: string | null | undefined
): Record<string, unknown> {
  const report = applied.layerOne?.reconciled;
  return {
    status: "adopted",
    outcome: applied.outcome,
    workspaceId: applied.workspaceId,
    templateSlug,
    packageVersion: version ?? null,
    ...(applied.finished && applied.outcome !== "unchanged"
      ? { versionStamped: applied.finished.versionStamped }
      : {}),
    ...(applied.finished?.templateApply
      ? { templateApply: applied.finished.templateApply }
      : {}),
    ...(report
      ? {
          reconcile: {
            profilesAdded: report.profiles.added.length,
            propertiesAdded: report.properties.added.length,
            viewsAdded: report.views.added.length,
            entityLinksAdded: report.entityLinks.added.length,
            propertyConflicts: report.properties.conflicts,
          },
        }
      : {}),
    ...(applied.layer2.status === "failed"
      ? {
          layer2: {
            status: "failed",
            message:
              "The space is adopted, but applying its package layers failed. Run `synap templates update` to finish it.",
          },
        }
      : {}),
    ...(applied.warning ? { templateApplyWarning: applied.warning } : {}),
  };
}

export function registerPodAdoptRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/pod/adopt",
    tags: ["System"],
    summary: "Adopt an orphan/existing workspace into a known template",
    description:
      "Stamps the workspace's marketplace identity (packageSlug/packageVersion) " +
      "and additively reconciles it to the template's definition — never " +
      "destructive, never a second workspace. Governed: owner/editor floor + " +
      "agent-governance ladder (grant or propose).",
    request: {
      body: PodAdoptSchema,
    },
    responses: {
      200: {
        description: "Adopted",
        schema: z.record(z.string(), z.unknown()),
      },
      202: {
        description: "Proposed for review",
        schema: z.record(z.string(), z.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: {
        description: "Workspace or template not found",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/pod/adopt", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const agentUserId = c.get("agentUserId") as string | undefined;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = PodAdoptSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }
    const { workspaceId, templateSlug } = parsed.data;

    try {
      // ── Resolve the template (cache-first; frozen-bundle fallback) ────────
      const resolved = await resolveWorkspaceTemplate(templateSlug);
      if (!resolved) {
        return c.json({ error: `Unknown template: ${templateSlug}` }, 404);
      }

      // ── The workspace must already exist — adopt never creates one ────────
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { id: true },
      });
      if (!ws) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      // ── Governed write: RBAC floor (editor+) + agent-governance ladder ────
      // `workspaceId` is stored in `data` (not just relied on via
      // `proposal.workspaceId`) so the `workspace/adopt` approve executor
      // (approve-executors.ts) can re-run this exact operation from the stored
      // payload alone, independent of how the proposal row's own column is
      // threaded.
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "workspace",
        action: "adopt",
        data: {
          workspaceId,
          templateSlug,
          packageVersion: resolved.version ?? null,
        },
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm && perm.proposalId) {
        return jsonGoverned(c, {
          status: "proposed",
          workspaceId,
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      // ── The ONE template apply, in adopt mode: the space takes the
      // identity, layer 1 re-syncs it from the catalog (its own capabilities
      // kept), layer 2 runs (founder decision 1), and the version is stamped
      // only on convergence. Already this template's at this version →
      // "unchanged" (the plan's answer). A layer-2 failure is recorded on the
      // space and reported, never a 500.
      const applied = await applyTemplate({
        definition: resolved.workspaceDefinition as WorkspaceDefinitionInput,
        actor: {
          userId,
          agentUserId,
          scopes: (c.get("scopes") as string[]) ?? [],
        },
        source: "hub.pod.adopt",
        adoptWorkspaceId: workspaceId,
        identity: {
          packageSlug: templateSlug,
          packageVersion: resolved.version ?? undefined,
          proposalId: templateSlug,
        },
      });
      return c.json(adoptReply(applied, templateSlug, resolved.version));
    } catch (err) {
      logger.error(
        { err, userId, workspaceId, templateSlug },
        "POST /pod/adopt failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
