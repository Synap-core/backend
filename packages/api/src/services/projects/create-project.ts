/**
 * `createProjectGoverned` — the ONE governed path a project is created through.
 *
 * Two doors used to carry their own copy of this: the tRPC `projects.create`
 * (browser, relay, MCP `synap_create_project` via `door: "mcp"`, the
 * `project/create` approval replay) and the Hub REST `POST /projects` (CLI
 * `synap project new`, Raycast `create-project`). The REST copy re-implemented
 * the guardrails and then STOPPED at the insert — no subject binding, no audit
 * row, no `project.create` side effects — so a project made from the CLI was
 * invisible to everything that listens for creates (W5c). Both doors now call
 * this; each only maps the outcome onto its own wire (tRPC result vs HTTP
 * status + body). Same pattern as `services/rules/create.ts`.
 *
 * Order, and why it is load-bearing:
 *   1. subject visibility — BEFORE anything is written; failing inside the
 *      bind would leave a project inserted and a caller told it failed;
 *   2. agent guardrails (exact-name reuse, evidence gravity, near-duplicate
 *      refusal) — BEFORE governance, so an agent is told to reuse instead of
 *      filing a duplicate proposal. Humans skip them;
 *   3. governance (`checkPermissionOrPropose`) with the FULL payload;
 *   4. insert → subject bind → audit → side effects. A repo-level dedup
 *      (exact-name reuse inside `ProjectRepository.create`) emits nothing.
 */

import { TRPCError } from "@trpc/server";
import { decodeHtmlEntities } from "@synap-core/types/text";
import {
  entities,
  and,
  isNull,
  inArray,
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
  findProjectDedupCandidates,
  assessEvidenceGravity,
  buildNearMatchMessage,
  buildProjectProvenance,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { auditLog } from "../../utils/audit-log.js";
import { accessScopeWhere } from "../../utils/project-scope.js";
import {
  isSubjectEntityVisible,
  setProjectSubject,
} from "../../utils/project-subject.js";

type Db = Awaited<ReturnType<typeof getDb>>;
type ProjectStatus = "active" | "archived" | "completed";
type CreatedRow = Awaited<ReturnType<ProjectRepository["create"]>>;
type NearCandidates = Awaited<
  ReturnType<typeof findProjectDedupCandidates>
>["near"];

export interface CreateProjectGovernedInput {
  userId: string;
  /** Present ⇒ an AGENT authored this: guardrails run and the gate proposes. */
  agentUserId?: string | null;
  /** The project's home. `null`/absent ⇒ a POD-PERSONAL project. */
  workspaceId?: string | null;
  /** Which door originated the create — provenance only. */
  door: "trpc" | "hub-rest" | "mcp";
  name: string;
  description?: string;
  status?: ProjectStatus;
  phase?: string;
  targetDate?: Date | null;
  subjectEntityId?: string;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  evidenceEntityIds?: string[];
  source?: string;
  reasoning?: string;
}

export type CreateProjectGovernedOutcome =
  | { status: "deduped"; projectId: string; reusedProjectId: string }
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | {
      status: "created";
      projectId: string;
      /** The inserted row, as `ProjectRepository.create` returned it. */
      row: CreatedRow;
      /** Present ONLY when a subject was requested; `false` = bind did not land. */
      subjectBound?: boolean;
    };

/**
 * An agent's create refused because a near-duplicate exists. A `CONFLICT`
 * (409 on REST) that also carries the candidates, so the REST door can hand
 * them back as `dedupCandidates` — the shape `HubRestClient.createProject`
 * turns into `{ status: "near_duplicate" }`.
 */
export class ProjectNearDuplicateError extends TRPCError {
  readonly dedupCandidates: NearCandidates;
  constructor(candidates: NearCandidates) {
    super({ code: "CONFLICT", message: buildNearMatchMessage(candidates) });
    this.dedupCandidates = candidates;
  }
}

/**
 * How many of `entityIds` exist and are visible to `userId`, on the canonical
 * entity access floor (`accessScopeWhere`) — never a request-supplied
 * predicate. Backs evidence gravity: an agent cannot claim gravity with ids it
 * cannot see or that do not exist.
 */
export async function countVisibleEntities(
  db: Db,
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

export async function createProjectGoverned(
  input: CreateProjectGovernedInput
): Promise<CreateProjectGovernedOutcome> {
  const db = await getDb();
  const { userId } = input;
  const agentUserId = input.agentUserId ?? undefined;
  const isAgent = !!agentUserId;
  const workspaceId = input.workspaceId ?? null;
  // Decode an agent's XML-escaped name once, here, for every door — see
  // `entities/create.ts` for the full rationale.
  const name = decodeHtmlEntities(input.name);

  // 1. Subject — before anything is created.
  if (input.subjectEntityId) {
    const visible = await isSubjectEntityVisible(
      db,
      input.subjectEntityId,
      userId
    );
    if (!visible) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Subject entity not found",
      });
    }
  }

  // 2. Agent guardrails (P1).
  if (isAgent) {
    const match = await findProjectDedupCandidates(db, { userId, name });

    // Exact-normalized match → reuse idempotently; never a second project.
    if (match.exact) {
      return {
        status: "deduped",
        projectId: match.exact.id,
        reusedProjectId: match.exact.id,
      };
    }

    // Gravity: a project is a commitment. Require ≥5 caller-visible entities.
    const evidence = input.evidenceEntityIds ?? [];
    const visibleCount = await countVisibleEntities(db, userId, evidence);
    const gravity = assessEvidenceGravity({
      providedCount: evidence.length,
      visibleCount,
      near: match.near,
    });
    if (!gravity.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: gravity.message });
    }

    // Gravity satisfied but a near-duplicate exists → surface it, don't create.
    if (match.near.length > 0) {
      throw new ProjectNearDuplicateError(match.near);
    }
  }

  // 3. Governance. The FULL create payload rides the proposal: the
  // `project/create` executor replays it, and a reviewer cannot judge a create
  // they are shown only the name of. `!== undefined`, not truthiness — an
  // empty string is a meant value.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: workspaceId ?? undefined,
    subjectType: "project",
    action: "create",
    ...(input.source ? { source: input.source } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    data: {
      name,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      ...(input.targetDate !== undefined
        ? { targetDate: input.targetDate }
        : {}),
      ...(input.subjectEntityId !== undefined
        ? { subjectEntityId: input.subjectEntityId }
        : {}),
      ...(input.settings !== undefined ? { settings: input.settings } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(isAgent && input.evidenceEntityIds
        ? { evidenceEntityIds: input.evidenceEntityIds }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(perm.reviewPath ? { reviewPath: perm.reviewPath } : {}),
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
    };
  }

  // 4. Write.
  const repo = new ProjectRepository(db, new EventRepository(sql));
  const row = await repo.create(
    {
      name,
      description: input.description,
      status: input.status,
      phase: input.phase ?? null,
      targetDate: input.targetDate ?? null,
      settings: input.settings,
      metadata: input.metadata,
      userId,
      workspaceId,
      provenance: buildProjectProvenance({
        door: input.door,
        agentUserId,
        evidenceEntityIds: input.evidenceEntityIds,
      }),
    },
    userId
  );

  // Idempotent reuse (exact-name match inside the repo) emits no create
  // side effects.
  if (row.deduped) {
    return { status: "deduped", projectId: row.id, reusedProjectId: row.id };
  }

  // Bind the subject only on a REAL create — a deduped create is somebody's
  // existing project, and rebinding it from this payload would retitle it.
  // CHECKED and reported, never thrown: the project exists and its create
  // event has fired, so "failed" would be a lie, and a retry would hit the
  // exact-name dedup that deliberately skips the bind. `subjectBound: false`
  // says exactly what happened; the fix is one `projects.update`.
  let subjectBound: boolean | undefined;
  if (input.subjectEntityId) {
    const bound = await setProjectSubject({
      db,
      projectId: row.id,
      workspaceId,
      entityId: input.subjectEntityId,
      userId,
    });
    subjectBound = bound.ok;
  }

  auditLog({
    subjectType: "project",
    action: "create",
    phase: "completed",
    subjectId: row.id,
    userId,
    workspaceId: workspaceId ?? undefined,
  });

  emitSideEffects({
    subjectType: "project",
    action: "create",
    subjectId: row.id,
    userId,
    workspaceId: workspaceId ?? undefined,
  });

  return {
    status: "created",
    projectId: row.id,
    row,
    ...(subjectBound !== undefined ? { subjectBound } : {}),
  };
}
