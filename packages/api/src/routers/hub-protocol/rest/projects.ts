/**
 * Hub REST — Projects (projects TABLE, NOT entities)
 *
 * CRUD for first-class project rows in the `projects` pgTable.
 * Auth: Hub Protocol API key (Bearer). All writes go through governance.
 */

import { z } from "zod";
import {
  db,
  projects,
  entities,
  workspaces,
  relations,
  documents,
  documentVersions,
  eq,
  ne,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  desc,
  drizzleSql,
  ProjectRepository,
  EventRepository,
  sql,
  findProjectDedupCandidates,
  assessEvidenceGravity,
  buildNearMatchMessage,
  buildProjectProvenance,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { storage } from "@synap/storage";
import {
  buildDigestSummary,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import {
  accessScopeWhere,
  projectLensWhere,
} from "../../../utils/project-scope.js";

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  status: z.enum(["active", "archived", "completed"]).default("active"),
  settings: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid().optional(),
  /**
   * Agent gravity evidence: existing entity ids that would belong to this
   * project. Required (≥5, caller-visible) for AGENT-initiated creates; ignored
   * for human/operator creators.
   */
  evidenceEntityIds: z.array(z.string().uuid()).max(500).optional(),
});

/**
 * Count how many `entityIds` exist and are visible to `userId` via the canonical
 * entity access floor — backs the agent evidence-gravity check on this door.
 */
async function countVisibleEntities(
  userId: string,
  entityIds: string[]
): Promise<number> {
  if (entityIds.length === 0) return 0;
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        inArray(entities.id, entityIds),
        isNull(entities.deletedAt),
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
        })
      )
    );
  return new Set(rows.map((r) => r.id)).size;
}

const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.enum(["active", "archived", "completed"]).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function registerProjectsRoutes(app: HubHono): void {
  // List projects for the authenticated user
  app.get("/projects", async (c) => {
    const userId = c.get("userId");
    const status = c.req.query("status") ?? undefined;
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 100);

    const conditions: ReturnType<typeof eq>[] = [
      // Dual-mode scoping (parity with tRPC projectsRouter):
      // Pod-wide projects (NULL workspace): only visible to their owner
      // Workspace-scoped projects: visible to all workspace members
      or(
        and(isNull(projects.workspaceId), eq(projects.userId, userId)),
        and(
          isNotNull(projects.workspaceId),
          userVisibleWhere(projects.workspaceId, userId)
        )
      )!,
    ];
    if (status) conditions.push(eq(projects.status, status as any));

    const rows = await db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(limit);

    return c.json(rows);
  });

  // Project data digest — deterministic "understand existing data before
  // acting" briefing aggregated across the project's linked workspaces (entities
  // filed into the project via belongs_to_project). Registered BEFORE
  // /projects/:id so the `/:projectId/digest` literal suffix resolves cleanly.
  // Scoping = the canonical entity floor (accessScopeWhere) AND the project lens
  // (projectLensWhere) — the lens only narrows, never widens (no leak).
  app.get("/projects/:projectId/digest", async (c) => {
    const userId = c.get("userId");
    const parsed = z
      .object({ projectId: z.string().uuid() })
      .safeParse({ projectId: c.req.param("projectId") });
    if (!parsed.success) {
      return c.json(
        { error: "Invalid projectId", details: parsed.error.issues },
        400
      );
    }
    const { projectId } = parsed.data;

    // Access gate + name resolution — same visibility predicate as GET /projects/:id.
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      ),
      columns: { id: true, name: true },
    });
    if (!project) return c.json({ error: "Project not found" }, 404);

    const baseWhere = and(
      isNull(entities.deletedAt),
      accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
      }),
      projectLensWhere(entities.id, projectId)
    );

    const [countRows, byWorkspaceRows, recentRows] = await Promise.all([
      db
        .select({
          profileSlug: entities.type,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(baseWhere)
        .groupBy(entities.type),
      db
        .select({
          workspaceId: entities.workspaceId,
          count: drizzleSql<number>`cast(count(*) as integer)`,
        })
        .from(entities)
        .where(baseWhere)
        .groupBy(entities.workspaceId),
      db
        .select({
          id: entities.id,
          title: entities.title,
          profileSlug: entities.type,
          workspaceId: entities.workspaceId,
          updatedAt: entities.updatedAt,
        })
        .from(entities)
        .where(baseWhere)
        .orderBy(desc(entities.updatedAt))
        .limit(10),
    ]);

    const counts: Record<string, number> = {};
    for (const row of countRows) counts[row.profileSlug] = row.count;
    const total = countRows.reduce((sum, r) => sum + r.count, 0);

    // Resolve workspace names for the byWorkspace breakdown (null = pod-wide).
    const wsIds = byWorkspaceRows
      .map((r) => r.workspaceId)
      .filter((id): id is string => id != null);
    const wsNameRows = wsIds.length
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds))
      : [];
    const wsNameById = new Map(wsNameRows.map((w) => [w.id, w.name]));
    const byWorkspace = byWorkspaceRows.map((r) => ({
      workspaceId: r.workspaceId,
      name: r.workspaceId
        ? (wsNameById.get(r.workspaceId) ?? "Unknown")
        : "Pod-wide",
      total: r.count,
    }));

    const keyEntities = recentRows.map((r) => ({
      id: r.id,
      title: r.title,
      profileSlug: r.profileSlug,
      workspaceId: r.workspaceId,
      updatedAt: r.updatedAt,
    }));

    const summary = buildDigestSummary(
      `Project '${project.name}'`,
      total,
      counts,
      keyEntities,
      byWorkspace.length > 0
        ? `spanning ${byWorkspace.length} workspace${
            byWorkspace.length === 1 ? "" : "s"
          }`
        : undefined
    );

    return c.json({
      projectId,
      name: project.name,
      total,
      counts,
      byWorkspace,
      keyEntities,
      summary,
    });
  });

  // POST /projects/:id/purge — DESTRUCTIVE owner teardown.
  //
  // Hard-removes a project plus the POD-WIDE entities filed EXCLUSIVELY into it
  // (those linked to no OTHER project). Workspace-scoped member entities are
  // intentionally left for the workspace purge. This DELIBERATELY bypasses the
  // proposal flow — it is an explicit, confirm-gated owner action and does NOT
  // call checkPermissionOrPropose(), so it never returns { status: "proposed" }.
  //
  // Registered BEFORE /projects/:id (the `/:id/purge` literal suffix is a
  // distinct path so it resolves cleanly ahead of the dynamic catch-all).
  app.post("/projects/:id/purge", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = z.object({ confirm: z.string() }).safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    // 404 — project must exist.
    const exists = await db.query.projects.findFirst({
      where: eq(projects.id, id),
      columns: { id: true, name: true },
    });
    if (!exists) return c.json({ error: "Project not found" }, 404);

    // 403 — ownership. Same visibility predicate as GET /projects/:id:
    // pod-wide projects → owned by their creator; workspace-scoped → member.
    const owned = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, id),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      ),
      columns: { id: true },
    });
    if (!owned) {
      return c.json(
        { error: "Access denied: you do not own this project." },
        403
      );
    }

    // 400 — confirm must equal the project name exactly.
    if (parsed.data.confirm !== exists.name) {
      return c.json(
        { error: "confirm does not match the project name. Purge cancelled." },
        400
      );
    }

    const BELONGS_TO_PROJECT = "belongs_to_project";

    try {
      const result = await db.transaction(async (tx) => {
        // 1) belongs_to_project edges for THIS project → member entity ids.
        //    target_entity_id holds the PROJECT id; source_entity_id is the member.
        const memberRows = await tx
          .select({ sourceEntityId: relations.sourceEntityId })
          .from(relations)
          .where(
            and(
              eq(relations.type, BELONGS_TO_PROJECT),
              eq(relations.targetEntityId, id)
            )
          );
        const memberEntityIds = Array.from(
          new Set(
            memberRows
              .map((r) => r.sourceEntityId)
              .filter((x): x is string => !!x)
          )
        );

        // 2) Of the members, hard-delete ONLY the pod-wide ones
        //    (workspaceId IS NULL) that belong to NO OTHER project.
        let podWideExclusive: Array<{ id: string; documentId: string | null }> =
          [];
        if (memberEntityIds.length) {
          const podWide = await tx
            .select({ id: entities.id, documentId: entities.documentId })
            .from(entities)
            .where(
              and(
                inArray(entities.id, memberEntityIds),
                isNull(entities.workspaceId)
              )
            );

          if (podWide.length) {
            // Which of these pod-wide members are linked to ANOTHER project?
            const sharedRows = await tx
              .select({ sourceEntityId: relations.sourceEntityId })
              .from(relations)
              .where(
                and(
                  eq(relations.type, BELONGS_TO_PROJECT),
                  inArray(
                    relations.sourceEntityId,
                    podWide.map((e) => e.id)
                  ),
                  ne(relations.targetEntityId, id)
                )
              );
            const sharedIds = new Set(sharedRows.map((r) => r.sourceEntityId));
            podWideExclusive = podWide.filter((e) => !sharedIds.has(e.id));
          }
        }
        const deleteEntityIds = podWideExclusive.map((e) => e.id);

        // Collect the deleted entities' linked documents + storage keys
        // (mirror purgeWorkspaceData's blob handling) for post-commit cleanup.
        const linkedDocIds = podWideExclusive
          .map((e) => e.documentId)
          .filter((d): d is string => !!d);
        let docRows: Array<{ id: string; storageKey: string | null }> = [];
        if (linkedDocIds.length) {
          docRows = await tx
            .select({ id: documents.id, storageKey: documents.storageKey })
            .from(documents)
            .where(inArray(documents.id, linkedDocIds));
        }
        const documentIds = Array.from(new Set(docRows.map((d) => d.id)));
        const docStorageKeys = docRows
          .map((d) => d.storageKey)
          .filter((k): k is string => !!k);
        const versionStorageKeys = documentIds.length
          ? (
              await tx
                .select({ storageKey: documentVersions.storageKey })
                .from(documentVersions)
                .where(inArray(documentVersions.documentId, documentIds))
            )
              .map((d: { storageKey: string | null }) => d.storageKey)
              .filter((k: string | null): k is string => !!k)
          : [];
        const storageKeys = Array.from(
          new Set([...docStorageKeys, ...versionStorageKeys])
        );

        // 3) Delete the pod-wide-exclusive entities + ALL relations touching
        //    them (as source OR target) so no dangling edges remain, plus their
        //    now-unreferenced documents.
        if (deleteEntityIds.length) {
          await tx
            .delete(relations)
            .where(
              or(
                inArray(relations.sourceEntityId, deleteEntityIds),
                inArray(relations.targetEntityId, deleteEntityIds)
              )
            );
          await tx
            .delete(entities)
            .where(inArray(entities.id, deleteEntityIds));
          if (documentIds.length) {
            await tx
              .delete(documents)
              .where(inArray(documents.id, documentIds));
          }
        }

        // 4) Delete ALL belongs_to_project edges for this project. (Edges whose
        //    source was a deleted pod-wide entity are already gone via step 3;
        //    this sweeps the rest — e.g. workspace-scoped members left behind.)
        await tx
          .delete(relations)
          .where(
            and(
              eq(relations.type, BELONGS_TO_PROJECT),
              eq(relations.targetEntityId, id)
            )
          );

        // 5) Delete the project row.
        await tx.delete(projects).where(eq(projects.id, id));

        return {
          deleteEntityIds,
          documentIds,
          storageKeys,
          // Every belongs_to_project edge for this project is removed across
          // steps 3 + 4 — the membership count is the exact deleted total.
          relationsDeleted: memberRows.length,
        };
      });

      // Post-commit, best-effort cleanup of out-of-DB state (pod-wide → null ws).
      let blobsDeleted = 0;
      for (const key of result.storageKeys) {
        try {
          await storage.delete(key);
          blobsDeleted++;
        } catch (err) {
          logger.warn({ err, key }, "Project purge: MinIO blob delete failed");
        }
      }
      for (const eid of result.deleteEntityIds) {
        void emitSideEffects({
          subjectType: "entity",
          action: "delete",
          subjectId: eid,
          userId,
          workspaceId: null,
        });
      }
      for (const did of result.documentIds) {
        void emitSideEffects({
          subjectType: "document",
          action: "delete",
          subjectId: did,
          userId,
          workspaceId: null,
        });
      }

      logger.warn(
        {
          projectId: id,
          purgedBy: userId,
          podWideEntities: result.deleteEntityIds.length,
          relations: result.relationsDeleted,
          blobs: blobsDeleted,
        },
        "Project HARD-PURGED via Hub Protocol"
      );

      return c.json({
        purged: true,
        projectId: id,
        podWideEntitiesDeleted: result.deleteEntityIds.length,
        relationsDeleted: result.relationsDeleted,
      });
    } catch (err) {
      logger.error(
        { err, userId, projectId: id },
        "POST /projects/:id/purge failed"
      );
      return c.json({ error: "Failed to purge project" }, 500);
    }
  });

  // Get a single project
  app.get("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    const row = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, id),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, userId)
          )
        )!
      ),
    });

    if (!row) return c.json({ error: "Project not found" }, 404);
    return c.json(row);
  });

  // Create a project
  app.post("/projects", async (c) => {
    const userId = c.get("userId");
    const body = CreateProjectSchema.parse(await c.req.json());
    const agentUserId = c.get("agentUserId") as string | undefined;
    const isAgent = !!agentUserId;
    // Item 3 Part 3: positively pin a bound service key to its workspace.
    // A mismatching bound key throws FORBIDDEN → surface 403 (this handler has
    // no outer try/catch, so map it here).
    let workspaceId: string | null | undefined;
    try {
      workspaceId = getConfinedWorkspace(c, body.workspaceId);
    } catch (err) {
      if ((err as { code?: unknown })?.code === "FORBIDDEN")
        return c.json(
          { error: err instanceof Error ? err.message : "Forbidden" },
          403
        );
      throw err;
    }

    // ── Agent guardrails (P1) — dedup + gravity before the governance gate.
    if (isAgent) {
      const match = await findProjectDedupCandidates(db, {
        userId,
        name: body.name,
      });

      // Exact-normalized match → reuse idempotently; never a second project.
      if (match.exact) {
        return c.json(
          {
            status: "deduped",
            projectId: match.exact.id,
            reusedProjectId: match.exact.id,
          },
          200
        );
      }

      const evidence = body.evidenceEntityIds ?? [];
      const visibleCount = await countVisibleEntities(userId, evidence);
      const gravity = assessEvidenceGravity({
        providedCount: evidence.length,
        visibleCount,
        near: match.near,
      });
      if (!gravity.ok) {
        return c.json({ error: gravity.message }, 400);
      }

      // Gravity satisfied but a near-duplicate exists → surface it, don't create.
      if (match.near.length > 0) {
        return c.json(
          {
            error: buildNearMatchMessage(match.near),
            dedupCandidates: match.near,
          },
          409
        );
      }
    }

    const perm = await checkPermissionOrPropose({
      userId,
      // Bug fix (object-proposal manifest W1): forward the auto-injected agent
      // identity so an agent-authored project create is GOVERNED (routes to a
      // proposal) instead of auto-applying. Undefined for operator requests.
      agentUserId,
      workspaceId: workspaceId ?? undefined,
      subjectType: "project",
      action: "create",
      // Carry the full create payload, matching the tRPC door — the
      // `project/create` executor replays these, and a reviewer cannot judge a
      // create they are shown only the name of.
      data: {
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.settings ? { settings: body.settings } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        ...(isAgent && body.evidenceEntityIds
          ? { evidenceEntityIds: body.evidenceEntityIds }
          : {}),
      },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    const row = await repo.create(
      {
        name: body.name,
        description: body.description,
        status: body.status,
        settings: body.settings,
        metadata: body.metadata,
        userId,
        workspaceId: workspaceId ?? null,
        provenance: buildProjectProvenance({
          door: "hub-rest",
          agentUserId,
          evidenceEntityIds: body.evidenceEntityIds,
        }),
      },
      userId
    );

    if (row.deduped) {
      return c.json(
        { status: "deduped", projectId: row.id, reusedProjectId: row.id },
        200
      );
    }

    return c.json(row, 201);
  });

  // Update a project
  app.patch("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body = UpdateProjectSchema.parse(await c.req.json());

    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "project",
      action: "update",
      // The WHOLE patch, matching the tRPC twin. This gate stored `{ id }`
      // alone, which was survivable only while `project/update` had no approve
      // executor and every such proposal failed loudly with NOT_IMPLEMENTED.
      // Now that the executor exists it would replay `update({ id })` — setting
      // nothing, marking the proposal APPROVED, and turning a visible failure
      // into a silent one.
      data: {
        id,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    try {
      const row = await repo.update(id, body, userId);
      return c.json(row);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // Delete a project
  app.delete("/projects/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    const perm = await checkPermissionOrPropose({
      userId,
      subjectType: "project",
      action: "delete",
      data: { id },
    });

    if ("denied" in perm && perm.denied) {
      return c.json({ error: perm.reason }, 403);
    }
    if ("proposalId" in perm) {
      return c.json({ status: "proposed", proposalId: perm.proposalId }, 202);
    }

    const eventRepo = new EventRepository(sql);
    const repo = new ProjectRepository(db, eventRepo);

    try {
      await repo.delete(id, userId);
      return c.json({ status: "deleted" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });
}
