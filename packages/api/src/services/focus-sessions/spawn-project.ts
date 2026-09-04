/**
 * spawnProjectFromSession — session → project, the second half of the
 * "turn finished work into reusable structure" pair (promote is the first).
 *
 * A session is a UNIT OF WORK with a goal and a set of expected outputs. A
 * project is a CONTAINER for months of work. Spawning is the moment a person
 * decides the thing they opened a session about is bigger than a session.
 *
 * THE FIELD MAPPING, stated explicitly because half of it is lossy:
 *
 *   session.goal              → project.name (truncated to the column's 255)
 *                               and project.description (the FULL goal, so a
 *                               truncated name never destroys the sentence)
 *   session.workspaceId       → project.workspaceId
 *   session.subjectEntityId   → `project --targets--> entity` via the ONE
 *                               subject door (`setProjectSubject`)
 *   session.expectedOutputs   → project.metadata.spawnedFrom.expectedOutputs
 *   session                   → `session --promoted_to--> project` (lineage)
 *
 * `expectedOutputs` is the lossy one AND IT IS SAID OUT LOUD: the `projects`
 * table has no tasks/outputs notion at all (read `schema/projects.ts` — name,
 * description, status, phase, settings, metadata). There is nowhere honest to
 * put deliverables, so they are carried in metadata where a later reader can
 * find them, and the receipt reports `expectedOutputsCarried` rather than
 * pretending they became work items.
 *
 * WHY `promoted_to` AND NOT A NEW LINK TYPE. `LinkType` and `LinkEndpointType`
 * are independent unions, so `session --promoted_to--> project` is already
 * representable with no enum change. `promoted_to` is the LINEAGE edge ("this
 * became that"); `targets` is the SCOPE edge ("this session runs inside that
 * project") and already means something else on the same pair of endpoints.
 * Using `targets` for lineage would make the two indistinguishable. No enum
 * value is added.
 *
 * GOVERNANCE: a pure domain operation, exactly like `promoteSessionToPlaybook`.
 * The caller (tRPC router / proposal executor) MUST run
 * `checkPermissionOrPropose` before invoking it.
 */

import {
  eq,
  getDb,
  sql,
  focusSessions,
  EventRepository,
  ProjectRepository,
  buildProjectProvenance,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { logEvent } from "../../lib/event-helpers.js";
import { createLinks } from "../links/links-service.js";
import { setProjectSubject } from "../../utils/project-subject.js";
import {
  recordConversion,
  type ConversionReceipt,
} from "./session-conversion.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SPAWN_PROJECT_ACTION,
  FOCUS_SESSION_SPAWNED_PROJECT_EVENT_TYPE,
} from "./lifecycle-events.js";

const logger = createLogger({ module: "focus-sessions/spawn-project" });

/** `projects.name` is `text`, but every write door caps it at 255. */
const PROJECT_NAME_MAX = 255;

export interface SpawnProjectInput {
  sessionId: string;
  /** The acting principal — owner floor AND the project's owner. */
  userId: string;
  /** Optional name; defaults to the session goal. */
  name?: string;
  description?: string;
  /** Provenance label for which door originated the spawn. */
  door?: "trpc" | "hub-rest" | "mcp";
  agentUserId?: string | null;
}

export type SpawnProjectResult =
  | {
      status: "spawned";
      projectId: string;
      /** True when an exact-name project already existed and was REUSED. */
      deduped: boolean;
      /** The subject binding, present only when the session had a subject. */
      subjectBound?: boolean;
      /** Expected outputs carried into `metadata` (see the header). */
      expectedOutputsCarried: number;
      receipt: ConversionReceipt;
    }
  | { status: "refused"; reason: "already_project_scoped"; message: string };

export async function spawnProjectFromSession(
  input: SpawnProjectInput
): Promise<SpawnProjectResult> {
  const database = await getDb();
  const session = (await database.query.focusSessions.findFirst({
    where: eq(focusSessions.id, input.sessionId),
  })) as FocusSession | undefined;
  if (!session) {
    throw new Error(`Session ${input.sessionId} not found`);
  }

  // Mirrors the promote door's project-scope guard, but as a TYPED refusal
  // rather than a thrown string: a session that is ALREADY project-scoped has
  // nothing to spawn — it lives inside a container already.
  if (session.projectId) {
    return {
      status: "refused",
      reason: "already_project_scoped",
      message:
        "This session is already scoped to a project — it cannot spawn another.",
    };
  }

  const name = (input.name ?? session.goal).slice(0, PROJECT_NAME_MAX);
  const expectedOutputs = (session.expectedOutputs ?? []) as Array<
    Record<string, unknown>
  >;

  const eventRepo = new EventRepository(sql);
  const projectRepo = new ProjectRepository(database, eventRepo);
  const created = await projectRepo.create(
    {
      name,
      // The FULL goal, so truncating the name never loses the sentence.
      description: input.description ?? session.goal,
      status: "active",
      metadata: {
        spawnedFrom: {
          sessionId: session.id,
          goal: session.goal,
          // Deliberately parked here — `projects` has no outputs/tasks notion.
          expectedOutputs,
          at: new Date().toISOString(),
        },
      },
      userId: input.userId,
      workspaceId: session.workspaceId ?? null,
      provenance: buildProjectProvenance({
        door: input.door ?? "trpc",
        agentUserId: input.agentUserId ?? undefined,
      }),
    },
    input.userId
  );

  // Lineage edge — see the header for why `promoted_to` and not `targets`.
  // `createLinks` is onConflict-safe, so a re-run is idempotent.
  await createLinks([
    {
      workspaceId: session.workspaceId,
      fromType: "session",
      fromId: session.id,
      toType: "project",
      toId: created.id,
      linkType: "promoted_to",
    },
  ]);

  // Carry the session's subject through the ONE subject door. Checked, never
  // thrown: the project exists at this point, so failing the call would report
  // "failed" about a project that is already in the caller's list.
  let subjectBound: boolean | undefined;
  if (session.subjectEntityId) {
    const bound = await setProjectSubject({
      db: database,
      projectId: created.id,
      workspaceId: session.workspaceId ?? null,
      entityId: session.subjectEntityId,
      userId: input.userId,
    });
    subjectBound = bound.ok;
    if (!bound.ok) {
      logger.warn(
        { projectId: created.id, sessionId: session.id, reason: bound.reason },
        "spawnProjectFromSession: subject binding did not land"
      );
    }
  }

  // Rename + receipt (the ONE conversion recorder, shared with promote).
  const receipt = await recordConversion({
    session,
    kind: "project",
    createdId: created.id,
    createdName: created.name,
    userId: input.userId,
  });

  const data = {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    userId: input.userId,
    projectId: created.id,
    projectName: created.name,
    deduped: !!created.deduped,
    renamedFrom: receipt.renamedFrom,
    goal: receipt.renamedTo,
  };
  // BOTH halves — persisted history row AND the transient reactor hop. The
  // promote door emitted NEITHER before this wave; see lifecycle-events.ts.
  await logEvent(input.userId, FOCUS_SESSION_SPAWNED_PROJECT_EVENT_TYPE, data, {
    subjectId: session.id,
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    source: input.agentUserId ? "intelligence" : "api",
    ...(input.agentUserId
      ? { metadata: { agentUserId: input.agentUserId } }
      : {}),
  });
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_SPAWN_PROJECT_ACTION,
    subjectId: session.id,
    userId: input.userId,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    data,
  });

  return {
    status: "spawned",
    projectId: created.id,
    deduped: !!created.deduped,
    ...(subjectBound !== undefined ? { subjectBound } : {}),
    expectedOutputsCarried: expectedOutputs.length,
    receipt,
  };
}
