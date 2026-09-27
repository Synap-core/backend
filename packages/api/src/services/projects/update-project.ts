/**
 * `updateProjectGoverned` — the ONE governed path a project is updated through.
 *
 * The sibling of `createProjectGoverned`. The tRPC `projects.update` (browser,
 * relay, MCP `synap_update_project`) and the Hub REST `PATCH /projects/:id`
 * (CLI, Raycast) each hand-built the gate payload and the write, and drifted
 * (RV1 S5): the REST gate omitted `colorSlot` / `subjectEntityId`, the REST
 * write fired no audit row and no `project.update` side effects, and its catch
 * answered 404 for ANY error — a 500 read as "not found". Both doors now call
 * this; each only maps the outcome onto its own wire.
 *
 * Order (load-bearing):
 *   1. load on the visibility floor — an invisible project is NOT_FOUND BEFORE
 *      governance, so an agent cannot file a proposal against a foreign id;
 *   2. D6 home change resolved (target must be live + writable) — before the
 *      gate, so no proposal is filed into a workspace the user cannot write;
 *   3. governance with the WHOLE patch (the `project/update` executor replays
 *      it; a gate carrying only `{ id }` made an approved update a no-op);
 *   4. subject visibility — before any write, so a failing subject writes
 *      nothing;
 *   5. patch → home `uses` stamp → subject (re)bind → audit → side effects.
 *
 * Throws `TRPCError` (NOT_FOUND / FORBIDDEN / BAD_REQUEST …); the REST door maps
 * it with `httpStatusForTrpcError`, never a blanket status.
 */

import { TRPCError } from "@trpc/server";
import { decodeHtmlEntities } from "@synap-core/types/text";
import {
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { auditLog } from "../../utils/audit-log.js";
import {
  isSubjectEntityVisible,
  setProjectSubject,
} from "../../utils/project-subject.js";
import { loadVisibleProject } from "./load-visible-project.js";
import {
  resolveProjectHomeChange,
  stampProjectHomeUse,
} from "./project-home.js";

type ProjectStatus = "active" | "archived" | "completed";
type UpdatedRow = Awaited<ReturnType<ProjectRepository["update"]>>;

/** The patchable fields — identical for every door. */
export interface ProjectPatch {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  /** `null` clears it; omitted = untouched. */
  phase?: string | null;
  /** `null` clears it; omitted = untouched. */
  targetDate?: Date | null;
  /** Identity-palette slot (1–12). `null` clears it. */
  colorSlot?: number | null;
  /** `null` unbinds the subject; omitted = untouched. */
  subjectEntityId?: string | null;
  /** D6: move the project's HOME workspace. */
  homeWorkspaceId?: string;
  settings?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectGovernedInput extends ProjectPatch {
  id: string;
  userId: string;
  /** Present ⇒ an AGENT authored this: the gate attributes and may propose. */
  agentUserId?: string | null;
  /** Why — shown to the reviewer; never stored, never replayed. */
  reasoning?: string;
}

export type UpdateProjectGovernedOutcome =
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | { status: "updated"; row: UpdatedRow };

export async function updateProjectGoverned(
  input: UpdateProjectGovernedInput
): Promise<UpdateProjectGovernedOutcome> {
  const db = await getDb();
  const { id, userId, reasoning } = input;
  const agentUserId = input.agentUserId ?? undefined;
  const name =
    input.name !== undefined ? decodeHtmlEntities(input.name) : undefined;

  // 1. Load first: the project's OWN workspace is the gate's subject.
  const target = await loadVisibleProject(db, id, userId);
  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }

  // 2. D6 — the TARGET home must be live and writable by the caller; a
  // same-home "move" is dropped (no-op, never a proposal of nothing).
  const homeWorkspaceId = await resolveProjectHomeChange(
    db,
    userId,
    target.workspaceId,
    input.homeWorkspaceId
  );

  const patch = {
    ...(name !== undefined ? { name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    ...(input.colorSlot !== undefined ? { colorSlot: input.colorSlot } : {}),
    ...(input.subjectEntityId !== undefined
      ? { subjectEntityId: input.subjectEntityId }
      : {}),
    ...(input.settings !== undefined ? { settings: input.settings } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  // 3. Governance with the WHOLE patch.
  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    workspaceId: target.workspaceId ?? undefined,
    subjectType: "project",
    action: "update",
    ...(reasoning ? { reasoning } : {}),
    data: {
      id,
      ...patch,
      ...(homeWorkspaceId !== undefined ? { homeWorkspaceId } : {}),
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

  // 4. Subject visibility BEFORE writing anything (two statements, not one
  // transaction — a subject failing after the patch landed would report
  // failure on a change that partly applied).
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

  // 5. Write.
  const repo = new ProjectRepository(db, new EventRepository(sql));
  // The repo's write is owner-floored (`projects.user_id = userId`); zero rows
  // there is a project this caller can SEE but not write — a refusal, not a
  // server fault. Typed so both doors map it (was a bare Error ⇒ 500 on tRPC).
  let row: UpdatedRow;
  try {
    row = await repo.update(
      id,
      { ...patch, workspaceId: homeWorkspaceId },
      userId
    );
  } catch (err) {
    if (err instanceof Error && err.message === "Project not found") {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Project not found",
        cause: err,
      });
    }
    throw err;
  }
  if (homeWorkspaceId) {
    await stampProjectHomeUse(db, { projectId: id, homeWorkspaceId, userId });
  }

  // `undefined` = untouched; `null` = unbind.
  if (input.subjectEntityId !== undefined) {
    const bound = await setProjectSubject({
      db,
      projectId: id,
      workspaceId: target.workspaceId,
      entityId: input.subjectEntityId,
      userId,
    });
    if (!bound.ok) {
      throw new TRPCError({ code: "NOT_FOUND", message: bound.reason });
    }
  }

  auditLog({
    subjectType: "project",
    action: "update",
    phase: "completed",
    subjectId: id,
    userId,
    workspaceId: target.workspaceId ?? undefined,
  });

  emitSideEffects({
    subjectType: "project",
    action: "update",
    subjectId: id,
    userId,
    workspaceId: target.workspaceId ?? undefined,
  });

  return { status: "updated", row };
}
