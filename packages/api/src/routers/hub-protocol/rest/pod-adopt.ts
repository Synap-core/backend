/**
 * Hub Protocol REST — POST /pod/adopt
 *
 * Adopt an orphan/ad-hoc workspace into a known template: stamp its
 * marketplace identity (`packageSlug`/`packageVersion`/`provisioningProposalId`)
 * then run the SAME additive reconcile every other install/reconcile door
 * uses (`reconcileWorkspaceFromDefinition`) — never destructive, never a
 * second workspace.
 *
 * Reuses:
 *   - `resolveWorkspaceTemplate` (cache-first CP template resolution, frozen-
 *     bundle fallback) — the same resolver `createWorkspaceFromDefinitionIdempotent`
 *     / `reconcileWorkspaceIfStale` use, instead of a raw
 *     `toWorkspaceDefinition()` call that would freeze to the bundle only.
 *   - `WorkspaceRepository.mergeSettings` — the ONE atomic, non-clobbering
 *     settings-merge door (same one `workspace-edge-service.ts` uses), which
 *     also lifts `packageSlug`/`proposalId` into their promoted columns.
 *   - `reconcileWorkspaceFromDefinition({ mergeCapabilities: true })` — the
 *     ONE additive-sync door `composeOntoBaseWorkspace` / `reconcileWorkspaceIfStale`
 *     already drive.
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
  getDb,
  eventRepository,
  WorkspaceRepository,
  reconcileWorkspaceFromDefinition,
  type WorkspaceSettings,
  type ReconcileReport,
} from "@synap/database";
import { resolveWorkspaceTemplate } from "../../../services/capabilities/resolve-workspace-template.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const PodAdoptSchema = z.object({
  workspaceId: z.string().uuid(),
  templateSlug: z.string().min(1),
});

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
        columns: { id: true, settings: true },
      });
      if (!ws) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const currentSettings = (ws.settings ?? null) as WorkspaceSettings | null;

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
        return c.json(
          {
            status: "proposed",
            workspaceId,
            proposalId: perm.proposalId,
            summary: perm.summary,
            reviewPath: perm.reviewPath,
            reviewUrl: perm.reviewUrl,
          },
          202
        );
      }

      // ── Already adopted at this exact version — no-op (mirrors
      // `reconcileWorkspaceIfStale`'s "checked, in sync" short-circuit) ──────
      const alreadyCurrent =
        currentSettings?.packageSlug === templateSlug &&
        (!resolved.version ||
          currentSettings?.packageVersion === resolved.version);
      if (alreadyCurrent) {
        return c.json({
          status: "adopted",
          outcome: "unchanged" as const,
          workspaceId,
          templateSlug,
          packageVersion:
            resolved.version ?? currentSettings?.packageVersion ?? null,
        });
      }

      // ── Stamp identity (atomic JSONB merge — lifts packageSlug/proposalId
      // into their promoted columns too), then additively reconcile. ────────
      const actingUserId = agentUserId ?? userId;
      const settingsPatch: Partial<WorkspaceSettings> = {
        packageSlug: templateSlug,
        proposalId: templateSlug,
        ...(resolved.version ? { packageVersion: resolved.version } : {}),
      };
      const dbConn = await getDb();
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepository);
      await workspaceRepo.mergeSettings(
        workspaceId,
        settingsPatch,
        actingUserId
      );

      const report: ReconcileReport = await reconcileWorkspaceFromDefinition({
        workspaceId,
        userId: actingUserId,
        // Cross-package boundary cast — same one `resolve-workspace-template.ts`
        // and every other `createWorkspaceFromDefinitionIdempotent` call site
        // performs: `@synap-core/workspace-templates`' WorkspaceDefinitionInput
        // is structurally the create/reconcile input, just a separately
        // published type (its `workspaceVisibility` is `string` where
        // `@synap/database`'s is a narrower union).
        definition: resolved.workspaceDefinition as unknown as Parameters<
          typeof reconcileWorkspaceFromDefinition
        >[0]["definition"],
        mergeCapabilities: true,
      });

      // Always "reconciled" here, never "created" — adopt only ever operates
      // on a pre-existing workspace (the `outcome` field mirrors
      // `CreateWorkspaceFromDefinitionResult.outcome`'s vocabulary for the
      // CLI's benefit, but this door can't hit "created" by construction).
      return c.json({
        status: "adopted",
        outcome: "reconciled" as const,
        workspaceId,
        templateSlug,
        packageVersion: resolved.version ?? null,
        reconcile: {
          profilesAdded: report.profiles.added.length,
          propertiesAdded: report.properties.added.length,
          viewsAdded: report.views.added.length,
          entityLinksAdded: report.entityLinks.added.length,
          propertyConflicts: report.properties.conflicts,
        },
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId, templateSlug },
        "POST /pod/adopt failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
