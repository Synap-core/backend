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
 *   5. the PLACE's parts (2026-10-14): an explicit home is stamped as a `uses`
 *      domain, and each `usedWorkspaceIds` entry is linked through the ONE
 *      governed `uses` writer (`setProjectWorkspaceMembershipGoverned`, the
 *      same rules as `projects.setWorkspaceMembership`). Checked BEFORE step 1
 *      (every used space must be reachable, so nothing is written for a
 *      refused one) and reported per space after — never thrown, because the
 *      project already exists.
 */

import { TRPCError } from "@trpc/server";
import type { DuplicateCheck } from "@synap-core/types/proposals";
import { findDuplicateCandidates } from "../duplicates/find-duplicate-candidates.js";
import { decodeHtmlEntities } from "@synap-core/types/text";
import { isProjectColorSlot, isProjectIcon } from "@synap-core/types/projects";
import {
  entities,
  and,
  isNull,
  inArray,
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
  assessEvidenceGravity,
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
import { checkLinkEndpointVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import {
  resolveProjectHomeChange,
  stampProjectHomeUse,
} from "./project-home.js";
import { setProjectWorkspaceMembershipGoverned } from "./project-workspace-membership.js";

type Db = Awaited<ReturnType<typeof getDb>>;
type ProjectStatus = "active" | "archived" | "completed";
type CreatedRow = Awaited<ReturnType<ProjectRepository["create"]>>;

export interface CreateProjectGovernedInput {
  userId: string;
  /** Present ⇒ an AGENT authored this: guardrails run and the gate proposes. */
  agentUserId?: string | null;
  /** The project's home. `null`/absent ⇒ a POD-PERSONAL project. */
  workspaceId?: string | null;
  /**
   * An EXPLICITLY chosen home (the setup page's "parts of the job"). Wins
   * over `workspaceId`, must be live and writable by the caller (checked
   * before the gate, same helper as `projects.update`), and is stamped as a
   * `uses` domain once the project exists.
   */
  homeWorkspaceId?: string;
  /** The spaces the project uses — each linked through the governed door. */
  usedWorkspaceIds?: string[];
  /** Identity-palette slot 1–12 (`isProjectColorSlot`). */
  colorSlot?: number | null;
  /** One emoji or `glyph:<lucide-name>` (`isProjectIcon`). */
  icon?: string | null;
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

/** What became of one requested used space, after the project was created. */
export type UsedWorkspaceOutcome =
  | { workspaceId: string; status: "linked" }
  | { workspaceId: string; status: "proposed"; proposalId: string }
  | { workspaceId: string; status: "failed"; error: string };

/**
 * The create hit a project the caller ALREADY has (exact-normalized name).
 * Nothing was written — not the name, the look, the home nor the spaces.
 * `existing: true` + the existing project's own `name` let a door say "You
 * already have <name>" and open it, never treat it as a fresh project to set
 * up (places review M2).
 */
export interface DedupedProjectOutcome {
  status: "deduped";
  existing: true;
  projectId: string;
  reusedProjectId: string;
  /** The EXISTING project's name (it may differ from the typed one in case/spacing). */
  name: string;
}

export type CreateProjectGovernedOutcome =
  | DedupedProjectOutcome
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
      duplicateCheck?: DuplicateCheck;
    }
  | {
      status: "created";
      projectId: string;
      /** The inserted row, as `ProjectRepository.create` returned it. */
      row: CreatedRow;
      /** Present ONLY when a subject was requested; `false` = bind did not land. */
      subjectBound?: boolean;
      /** Present ONLY when used spaces were requested — one entry each. */
      usedWorkspaces?: UsedWorkspaceOutcome[];
    };

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
  // Decode an agent's XML-escaped name once, here, for every door — see
  // `entities/create.ts` for the full rationale.
  const name = decodeHtmlEntities(input.name);

  // 0. The place's look and parts — refused before anything is read or
  // written. The doors' schemas check the same rules; this holds the line for
  // every caller (the `project/create` replay, pack installs).
  if (input.icon != null && !isProjectIcon(input.icon)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "icon must be one emoji or glyph:<lucide-name>",
    });
  }
  if (input.colorSlot != null && !isProjectColorSlot(input.colorSlot)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "colorSlot must be an integer from 1 to 12",
    });
  }
  // An explicit home must be live and writable (NOT_FOUND / FORBIDDEN).
  const homeWorkspaceId = input.homeWorkspaceId
    ? await resolveProjectHomeChange(db, userId, null, input.homeWorkspaceId)
    : undefined;
  const workspaceId = homeWorkspaceId ?? input.workspaceId ?? null;
  const usedWorkspaceIds = [...new Set(input.usedWorkspaceIds ?? [])];
  // Every used space must be reachable BEFORE anything is written — the same
  // endpoint floor the membership door applies, so a refused space never
  // leaves a half-made project behind.
  for (const usedId of usedWorkspaceIds) {
    const refusal = await checkLinkEndpointVisible(
      "workspace",
      usedId,
      userId,
      usedId
    );
    if (refusal) {
      throw new TRPCError({ code: "FORBIDDEN", message: refusal.error });
    }
  }

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

  // 2. Agent guardrails (P1) + the one duplicate door (B2).
  let duplicateCheck: DuplicateCheck | undefined;
  if (isAgent) {
    const answer = await findDuplicateCandidates(db, {
      subject: "project",
      userId,
      name,
    });
    duplicateCheck = answer.check;

    // Exact-normalized name IS a project's identity → reuse it; never a second.
    if (answer.sameIdentity) {
      return {
        status: "deduped",
        existing: true,
        projectId: answer.sameIdentity.id,
        reusedProjectId: answer.sameIdentity.id,
        name: answer.sameIdentity.name,
      };
    }
    const near = answer.check.candidates
      .filter((c) => c.ref === "record")
      .map((c) => ({ id: c.id, name: c.title ?? "", score: 1 }));

    // Gravity: a project is a commitment. Require ≥5 caller-visible entities.
    const evidence = input.evidenceEntityIds ?? [];
    const visibleCount = await countVisibleEntities(db, userId, evidence);
    const gravity = assessEvidenceGravity({
      providedCount: evidence.length,
      visibleCount,
      near,
    });
    if (!gravity.ok) {
      throw new TRPCError({ code: "BAD_REQUEST", message: gravity.message });
    }

    // A near name (or the same project still waiting for review) no longer
    // refuses (B2a): the create is FILED for review, with "looks like X".
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
    ...(duplicateCheck
      ? {
          duplicateCheck,
          possibleDuplicate: duplicateCheck.status === "possible",
        }
      : {}),
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
      ...(input.colorSlot !== undefined ? { colorSlot: input.colorSlot } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(homeWorkspaceId !== undefined ? { homeWorkspaceId } : {}),
      ...(usedWorkspaceIds.length > 0 ? { usedWorkspaceIds } : {}),
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
      // Why it waits, when the duplicate door is why.
      ...(duplicateCheck && duplicateCheck.status !== "clear"
        ? { duplicateCheck }
        : {}),
    };
  }

  // 4. Write.
  const written = await writeGovernedProject(db, {
    userId,
    agentUserId,
    workspaceId,
    door: input.door,
    name,
    description: input.description,
    status: input.status,
    phase: input.phase,
    targetDate: input.targetDate,
    settings: input.settings,
    metadata: input.metadata,
    colorSlot: input.colorSlot,
    icon: input.icon,
    evidenceEntityIds: input.evidenceEntityIds,
    subjectEntityId: input.subjectEntityId,
  });
  // A deduped create is somebody's EXISTING project: never re-home it or add
  // spaces to it from this payload (same rule as the subject bind).
  if (written.status === "deduped") {
    return {
      status: "deduped",
      existing: true,
      projectId: written.projectId,
      reusedProjectId: written.projectId,
      name: written.row.name,
    };
  }

  // 5. The place's parts.
  if (homeWorkspaceId) {
    await stampProjectHomeUse(db, {
      projectId: written.projectId,
      homeWorkspaceId,
      userId,
    });
  }
  if (usedWorkspaceIds.length === 0) return written;
  const usedWorkspaces: UsedWorkspaceOutcome[] = [];
  for (const usedId of usedWorkspaceIds) {
    try {
      const linked = await setProjectWorkspaceMembershipGoverned({
        userId,
        agentUserId,
        projectId: written.projectId,
        workspaceId: usedId,
        member: true,
        door: `projects.create:${input.door}`,
      });
      usedWorkspaces.push(
        linked.status === "proposed"
          ? {
              workspaceId: usedId,
              status: "proposed",
              proposalId: linked.proposalId,
            }
          : { workspaceId: usedId, status: "linked" }
      );
    } catch (err) {
      usedWorkspaces.push({
        workspaceId: usedId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ...written, usedWorkspaces };
}

export interface WriteGovernedProjectInput {
  userId: string;
  agentUserId?: string;
  workspaceId: string | null;
  door: CreateProjectGovernedInput["door"];
  name: string;
  description?: string;
  status?: ProjectStatus;
  phase?: string;
  targetDate?: Date | null;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  colorSlot?: number | null;
  icon?: string | null;
  evidenceEntityIds?: string[];
  subjectEntityId?: string;
}

/**
 * Step 4 of `createProjectGoverned` on its own: insert → subject bind → audit →
 * `project.create` side effects. The ONE project write.
 *
 * ONLY for a caller that has ALREADY cleared governance for this create — the
 * `project.spawn_from_session` door gates on its own verb and replays through
 * its own executor, so running the `project.create` gate again would
 * re-propose an approved spawn. Every other caller uses `createProjectGoverned`.
 */
export async function writeGovernedProject(
  db: Db,
  input: WriteGovernedProjectInput
): Promise<
  | { status: "deduped"; projectId: string; row: CreatedRow }
  | {
      status: "created";
      projectId: string;
      row: CreatedRow;
      subjectBound?: boolean;
    }
> {
  const { userId, workspaceId } = input;
  const repo = new ProjectRepository(db, new EventRepository(sql));
  const row = await repo.create(
    {
      name: input.name,
      description: input.description,
      status: input.status,
      phase: input.phase ?? null,
      targetDate: input.targetDate ?? null,
      colorSlot: input.colorSlot ?? null,
      icon: input.icon ?? null,
      settings: input.settings,
      metadata: input.metadata,
      userId,
      workspaceId,
      provenance: buildProjectProvenance({
        door: input.door,
        agentUserId: input.agentUserId,
        evidenceEntityIds: input.evidenceEntityIds,
      }),
    },
    userId
  );

  // Idempotent reuse (exact-name match inside the repo) emits no create
  // side effects.
  if (row.deduped) {
    return { status: "deduped", projectId: row.id, row };
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
