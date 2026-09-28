/**
 * FILE existing records into a project — and take them back out.
 *
 * Before this door, `belongs_to_project` could only be written at CREATE time
 * (materializer, capture, import, package apply). An EXISTING record had no way
 * in: `link_entities type=belongs_to_project` is refused as an exposure edge,
 * and the one path that did write it (a `projectId` property through
 * `syncPropertyToRelations`) was a guard gap, now closed.
 *
 * ONE governed path, shared by tRPC `projects.fileEntities`, Hub REST
 * `POST /projects/:projectId/file` and MCP `synap_file_into_project`:
 *
 *   1. FLOOR (before the gate, on the caller): the project must be visible
 *      (`loadVisibleProject`), and EVERY record must exist, be live and be
 *      WRITABLE by the caller (`assertWorkspaceWrite` on the loaded row — a
 *      member with a write role, or the owner of a pod-wide record). Filing
 *      exposes a record to every project member, so reading it is not enough.
 *      A record that fails reads "not found or not writable" — the refusal does
 *      not say which, so it is no existence oracle.
 *   2. GATE: `checkPermissionOrPropose` —
 *        file   → `project/file_entities`, `forcePropose` (an ACCESS decision:
 *                 an agent ALWAYS proposes; rules cannot widen rung 2.1);
 *        unfile → `link/delete` (DESTRUCTIVE floor: an agent always proposes).
 *      One proposal for the whole batch.
 *   3. APPLY (`applyProjectFiling`, also the approval half): re-floors on the
 *      OWNER now (a proposal can sit for days), then writes in ONE transaction
 *      through `linkEntityToProject` (keeps its existence + visibility check) /
 *      `unlinkEntitiesFromProject`. All-or-nothing: one record that no longer
 *      passes refuses the batch rather than filing a silent subset.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  and,
  eq,
  inArray,
  isNull,
  entities,
  relations,
  linkEntityToProject,
  unlinkEntitiesFromProject,
} from "@synap/database";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import { loadVisibleProject } from "./load-visible-project.js";

/** Batch bound — same order as `entities.moveToWorkspace`. */
export const FILE_ENTITIES_MAX = 500;

export interface ProjectFilingPlan {
  project: { id: string; name: string; workspaceId: string | null };
  entities: Array<{
    id: string;
    title: string | null;
    type: string;
    workspaceId: string | null;
  }>;
}

type Database = Awaited<ReturnType<typeof getDb>>;

/**
 * The floor, on `userId`: visible project + every record live and writable.
 * Throws NOT_FOUND / BAD_REQUEST; never returns a partial plan.
 */
export async function loadProjectFilingPlan(
  database: Database,
  params: { userId: string; projectId: string; entityIds: readonly string[] }
): Promise<ProjectFilingPlan> {
  const ids = [...new Set(params.entityIds)];
  if (ids.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "entityIds must name at least one record",
    });
  }
  if (ids.length > FILE_ENTITIES_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `At most ${FILE_ENTITIES_MAX} records per filing`,
    });
  }

  const project = await loadVisibleProject(
    database,
    params.projectId,
    params.userId
  );
  if (!project) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Project not found: ${params.projectId}`,
    });
  }

  const rows = await database
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      workspaceId: entities.workspaceId,
      userId: entities.userId,
    })
    .from(entities)
    .where(and(inArray(entities.id, ids), isNull(entities.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const refused: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      refused.push(id);
      continue;
    }
    try {
      await assertWorkspaceWrite(database, params.userId, {
        workspaceId: row.workspaceId,
        ownerId: row.userId,
      });
    } catch {
      refused.push(id);
    }
  }
  if (refused.length > 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${refused.length} record(s) not found or not writable by you — nothing was filed: ${refused.join(", ")}`,
    });
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      workspaceId: project.workspaceId,
    },
    entities: ids.map((id) => {
      const r = byId.get(id)!;
      return {
        id: r.id,
        title: r.title,
        type: r.type,
        workspaceId: r.workspaceId,
      };
    }),
  };
}

/** The display fields a filing proposal carries (read by its title). */
function filingPayload(plan: ProjectFilingPlan): Record<string, unknown> {
  const kinds = new Set(plan.entities.map((e) => e.type));
  const only = plan.entities.length === 1 ? plan.entities[0] : undefined;
  return {
    id: plan.project.id,
    projectId: plan.project.id,
    projectName: plan.project.name,
    entityIds: plan.entities.map((e) => e.id),
    // One kind across the batch names it ("9 questions"); mixed reads "records".
    entityKind: kinds.size === 1 ? [...kinds][0] : null,
    ...(only?.title ? { entityName: only.title } : {}),
  };
}

export type ProjectFilingApplied =
  | {
      status: "filed";
      projectId: string;
      /** Edges THIS call wrote (insert RETURNING), and the ones already there. */
      filed: string[];
      alreadyFiled: string[];
    }
  | {
      status: "unfiled";
      projectId: string;
      /** Relation rows the DELETE returned. `[]` = none were filed. */
      removedRelationIds: string[];
    };

/**
 * APPLY — the direct path AND the approval half. Re-floors on `ownerUserId`
 * (never the approver), then writes in one transaction.
 */
export async function applyProjectFiling(params: {
  ownerUserId: string;
  projectId: string;
  entityIds: readonly string[];
  remove: boolean;
}): Promise<ProjectFilingApplied> {
  const database = await getDb();
  const plan = await loadProjectFilingPlan(database, {
    userId: params.ownerUserId,
    projectId: params.projectId,
    entityIds: params.entityIds,
  });
  const ids = plan.entities.map((e) => e.id);

  if (params.remove) {
    const { removedIds } = await unlinkEntitiesFromProject(database, {
      entityIds: ids,
      projectId: plan.project.id,
    });
    return {
      status: "unfiled",
      projectId: plan.project.id,
      removedRelationIds: removedIds,
    };
  }

  return database.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    // Already-filed records are skipped explicitly: the partial unique index
    // dedupes on a real pod, but the receipt must say "already there" rather
    // than count a no-op as a filing.
    const existing = await txDb
      .select({ id: relations.sourceEntityId })
      .from(relations)
      .where(
        and(
          eq(relations.type, BELONGS_TO_PROJECT),
          eq(relations.targetEntityId, plan.project.id),
          inArray(relations.sourceEntityId, ids)
        )
      );
    const already = new Set(existing.map((r) => r.id));
    const filed: string[] = [];
    for (const e of plan.entities) {
      if (already.has(e.id)) continue;
      const res = await linkEntityToProject(txDb, {
        entityId: e.id,
        projectId: plan.project.id,
        userId: params.ownerUserId,
        workspaceId: e.workspaceId,
      });
      if (!res.linked) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Project not found or not visible: ${plan.project.id} — nothing was filed`,
        });
      }
      if (res.created) filed.push(e.id);
      else already.add(e.id);
    }
    return {
      status: "filed" as const,
      projectId: plan.project.id,
      filed,
      alreadyFiled: ids.filter((id) => already.has(id)),
    };
  });
}

export type FileEntitiesResult =
  | ProjectFilingApplied
  | { status: "proposed"; proposalId: string; reviewUrl?: string };

/** The ONE governed door (see file header). */
export async function fileEntitiesGoverned(params: {
  userId: string;
  agentUserId?: string | null;
  projectId: string;
  entityIds: readonly string[];
  remove?: boolean;
  reasoning?: string;
  sessionId?: string | null;
}): Promise<FileEntitiesResult> {
  const remove = params.remove === true;
  const plan = await loadProjectFilingPlan(await getDb(), {
    userId: params.userId,
    projectId: params.projectId,
    entityIds: params.entityIds,
  });

  const payload = filingPayload(plan);
  const common = {
    userId: params.userId,
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
    workspaceId: plan.project.workspaceId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
  };
  const perm = remove
    ? await checkPermissionOrPropose({
        ...common,
        subjectType: "link",
        action: "delete",
        data: {
          ...payload,
          linkType: BELONGS_TO_PROJECT,
          fromType: "entity",
          toType: "project",
          toId: plan.project.id,
        },
      })
    : await checkPermissionOrPropose({
        ...common,
        subjectType: "project",
        action: "file_entities",
        // An ACCESS decision (exposes each record to the project's members):
        // an agent always proposes, whatever rule or ownership says.
        forcePropose: true,
        data: payload,
      });

  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
    };
  }

  return applyProjectFiling({
    ownerUserId: params.userId,
    projectId: plan.project.id,
    entityIds: plan.entities.map((e) => e.id),
    remove,
  });
}
