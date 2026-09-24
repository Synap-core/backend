/**
 * TRACKS — a METHOD running inside ONE project (`project_tracks`, 0272).
 *
 * A project is long-lived intent; a track is how one strand of it is worked
 * ("Business model", "Content", "Build" inside "Launch The Architech"). The
 * method is a playbook with `scope: "project"`, reusable by any project; the
 * track PINS the definition it started from (`definitionSnapshot` +
 * `methodVersion`) so editing the method never rewrites a live track.
 *
 * ── THE DOORS, ALL HERE ─────────────────────────────────────────────────────
 *   startTrack        — the ONE way a track is born. `projects.instantiateFromPlaybook`
 *                       (the proto-track, 1 method per project) is now a thin
 *                       wrapper over it; there is no second mechanism.
 *   setTrackStatus    — pause / resume / complete / archive.
 *   advanceTrackStage — the ONE writer of `project_tracks.current_stage` after
 *                       birth. Gate evaluation is the subject-agnostic core in
 *                       `services/playbooks/stage-gate.ts` (`applyStageGate`),
 *                       shared with `advanceSessionStage` — never a copy.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * READS go through `scopedDb` + the `project_tracks` VisibilityRule (visible iff
 * the parent project is). WRITES gate on the LOADED project's workspace
 * (`assertWorkspaceWrite`), never a request-supplied workspace, and are
 * GOVERNED: `checkPermissionOrPropose({ subjectType: "track", ... })` with the
 * FULL payload the replay needs. `routers/proposals/executors/track.ts` replays
 * an approved proposal through THIS module.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  eq,
  getDb,
  inArray,
  ne,
  playbooks,
  projects,
  projectTracks,
  drizzleSql,
} from "@synap/database";
import type {
  Playbook,
  ProjectTrack,
  ProjectTrackStatus,
} from "@synap/database/schema";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import {
  canTransitionTrack,
  deriveTrackStages,
  trackPausedBy,
  type TrackPausedBy,
  type TrackStage,
  type TrackStatus,
} from "@synap-core/types/units";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import { trackRepository } from "./track-repo.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { projectVisibleWhere } from "../../access/project-visibility.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
import { createLinks } from "../links/links-service.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import {
  applyStageGate,
  trackGateSubject,
  type StageGateOutcome,
} from "../playbooks/stage-gate.js";

const logger = createLogger({ module: "tracks" });

/** Who is acting. `agentUserId` set ⇒ an AI drove it (governed ladder). */
export interface TrackActor {
  userId: string;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
  /** Provenance for the proposal (e.g. `mcp`, `hub-rest`). */
  source?: string;
  reasoning?: string;
}

export interface ProposedOutcome {
  status: "proposed";
  proposalId: string;
  proposalType: string;
  message: string;
  reviewUrl: string;
}

/** The project a track write gates on — the LOADED row, never the request. */
interface GateProject {
  id: string;
  workspaceId: string | null;
  userId: string;
}

// The DB enum (`PROJECT_TRACK_STATUSES`, @synap/database) and the shared
// transition table's statuses (`TRACK_STATUSES`, @synap-core/types/units) are
// two lists because the database package cannot import types. Pinned EQUAL
// here, at compile time: a status added to one and not the other stops the build.
type _SameStatuses = [ProjectTrackStatus] extends [TrackStatus]
  ? [TrackStatus] extends [ProjectTrackStatus]
    ? true
    : never
  : never;
const _sameStatuses: _SameStatuses = true;
void _sameStatuses;

// ── projection ──────────────────────────────────────────────────────────────

export interface TrackView {
  id: string;
  projectId: string;
  name: string;
  playbookId: string | null;
  methodVersion: string;
  currentStage: string | null;
  status: ProjectTrackStatus;
  /** Why it is paused — `null` unless `status === "paused"`. */
  pausedBy: TrackPausedBy;
  /** The PINNED stages, positioned against `currentStage`. */
  stages: TrackStage[];
  createdAt: string;
  updatedAt: string;
}

export function toTrackView(track: ProjectTrack): TrackView {
  return {
    id: track.id,
    projectId: track.projectId,
    name: track.name,
    playbookId: track.playbookId,
    methodVersion: track.methodVersion,
    currentStage: track.currentStage,
    status: track.status,
    pausedBy: trackPausedBy(track),
    stages: deriveTrackStages(
      track.definitionSnapshot?.stages,
      track.currentStage
    ),
    createdAt: new Date(track.createdAt).toISOString(),
    updatedAt: new Date(track.updatedAt).toISOString(),
  };
}

/** What a track pins from its method. The same fields a run snapshots, minus params. */
export function buildTrackSnapshot(playbook: Playbook) {
  return {
    // structuredClone: a spread would share every stage OBJECT with the
    // playbook row (the Odoo "duplicate from template" bug the proto-track's
    // `buildProjectStageSettings` documented).
    stages: structuredClone(
      Array.isArray(playbook.stages) ? playbook.stages : []
    ),
    goalTemplate: playbook.goalTemplate,
    expectedOutputs: structuredClone(playbook.expectedOutputs ?? []),
    criteria: structuredClone(playbook.criteria ?? []),
    version: playbook.version,
  };
}

function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages)) return null;
  const first = stages[0] as { key?: unknown } | undefined;
  return typeof first?.key === "string" && first.key ? first.key : null;
}

function stageKeys(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) =>
      s && typeof s === "object" ? (s as { key?: unknown }).key : null
    )
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

function proposed(
  perm: {
    proposalId: string;
    proposalType: string;
    reviewUrl: string;
  },
  fallback: string
): ProposedOutcome {
  return {
    status: "proposed",
    proposalId: perm.proposalId,
    proposalType: perm.proposalType,
    message: proposedMessageFor(perm.proposalType, fallback),
    reviewUrl: perm.reviewUrl,
  };
}

const repo = trackRepository;

/** Editor+ on the project's workspace, or the owner of a pod-personal project. */
async function assertProjectWrite(
  project: GateProject,
  userId: string
): Promise<void> {
  const db = await getDb();
  await assertWorkspaceWrite(db, userId, {
    workspaceId: project.workspaceId,
    ownerId: project.workspaceId ? undefined : project.userId,
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

/** A track ONLY if the caller may see its project. */
export async function getTrack(
  trackId: string,
  actor: TrackActor
): Promise<ProjectTrack | null> {
  const row = await scopedDb(AccessContext.from(actor)).findFirst<ProjectTrack>(
    projectTracks,
    { where: eq(projectTracks.id, trackId) }
  );
  return row ?? null;
}

/**
 * The project's tracks, oldest first (the order they were started in). Returns
 * `null` when the project itself is not visible — NOT `[]`: "no tracks" and
 * "no such project for you" are different facts.
 */
export async function listTracks(params: {
  projectId: string;
  actor: TrackActor;
  includeArchived?: boolean;
}): Promise<ProjectTrack[] | null> {
  const db = await getDb();
  const project = await loadVisibleProject(
    db,
    params.projectId,
    params.actor.userId
  );
  if (!project) return null;
  return scopedDb(AccessContext.from(params.actor)).findMany<ProjectTrack>(
    projectTracks,
    {
      where: and(
        eq(projectTracks.projectId, params.projectId),
        params.includeArchived
          ? undefined
          : ne(projectTracks.status, "archived")
      ),
      orderBy: [asc(projectTracks.createdAt), asc(projectTracks.id)],
    }
  );
}

/**
 * How many projects use each method — DISTINCT projects over non-archived
 * tracks, counted only over projects the caller can SEE (a count of invisible
 * projects would disclose their existence). ONE grouped query for any number
 * of methods; a method no visible project uses is absent from the map (read
 * it as 0).
 */
export async function countProjectsUsingMethods(
  playbookIds: string[],
  actor: TrackActor
): Promise<Map<string, number>> {
  const ids = [...new Set(playbookIds)];
  if (ids.length === 0) return new Map();
  const db = await getDb();
  const access = AccessContext.from(actor);
  const rows = await db
    .select({
      playbookId: projectTracks.playbookId,
      n: drizzleSql<number>`count(distinct ${projectTracks.projectId})`,
    })
    .from(projectTracks)
    .where(
      and(
        inArray(projectTracks.playbookId, ids),
        ne(projectTracks.status, "archived"),
        inArray(
          projectTracks.projectId,
          db
            .select({ id: projects.id })
            .from(projects)
            .where(projectVisibleWhere(access))
        )
      )
    )
    .groupBy(projectTracks.playbookId);
  return new Map(
    rows
      .filter((r): r is { playbookId: string; n: number } => !!r.playbookId)
      .map((r) => [r.playbookId, Number(r.n)])
  );
}

export async function countProjectsUsingMethod(
  playbookId: string,
  actor: TrackActor
): Promise<number> {
  return (
    (await countProjectsUsingMethods([playbookId], actor)).get(playbookId) ?? 0
  );
}

// ── start ───────────────────────────────────────────────────────────────────

export interface StartTrackInput {
  projectId: string;
  playbookId: string;
  /** Display name. Absent ⇒ the method's name. */
  name?: string;
  actor: TrackActor;
  /**
   * Pre-minted id — ONLY the approval replay passes it (the id the proposal
   * was filed under), so the approved row and its receipt name the same id.
   */
  id?: string;
}

export type StartTrackResult =
  | {
      status: "started" | "exists";
      track: ProjectTrack;
      playbook: { id: string; name: string; version: number };
    }
  | ProposedOutcome;

/**
 * Start a method on a project. Idempotent: a live (non-archived) track of the
 * same method on the same project is returned as `exists`, and nothing is
 * filed or written.
 */
export async function startTrack(
  input: StartTrackInput
): Promise<StartTrackResult> {
  const { actor } = input;
  const db = await getDb();

  const project = await loadVisibleProject(db, input.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }

  // The method's own visibility floor — `scopedDb` + the `playbooks` rule.
  const playbook = await scopedDb(
    AccessContext.from(actor)
  ).findFirst<Playbook>(playbooks, {
    where: eq(playbooks.id, input.playbookId),
  });
  if (!playbook) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Playbook ${input.playbookId} not found`,
    });
  }

  // A SESSION playbook is a template for one bounded piece of work; running it
  // as a months-long track would give the project a vocabulary describing a
  // work session. Only `scope: "project"` is a method.
  if (playbook.scope !== "project") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `Playbook "${playbook.name}" is ${playbook.scope ?? "session"}-scoped. ` +
        "Only a project-scoped playbook can run as a track on a project — a " +
        "session playbook is started as a focus session instead.",
    });
  }

  await assertProjectWrite(project, actor.userId);

  const playbookRef = {
    id: playbook.id,
    name: playbook.name,
    version: playbook.version,
  };

  // IDEMPOTENT before governance: an agent asking for a track that already
  // runs gets it back, rather than a proposal to create what exists.
  const [live] = await db
    .select()
    .from(projectTracks)
    .where(
      and(
        eq(projectTracks.projectId, project.id),
        eq(projectTracks.playbookId, playbook.id),
        ne(projectTracks.status, "archived")
      )
    )
    .limit(1);
  if (live) {
    return {
      status: "exists",
      track: live as ProjectTrack,
      playbook: playbookRef,
    };
  }

  const trackName = input.name?.trim() || playbook.name;
  const trackId = input.id ?? randomUUID();

  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "create",
    source: actor.source,
    reasoning: actor.reasoning,
    // EVERYTHING the replay needs. Nothing DERIVED (the snapshot) is stored:
    // the replay re-reads the method, re-checks its scope and both visibility
    // floors, and pins the definition as it stands at approval.
    data: {
      id: trackId,
      projectId: project.id,
      playbookId: playbook.id,
      name: trackName,
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "create",
        objectKind: "track",
        objectName: trackName,
      }) + " — proposed for review"
    );
  }

  const snapshot = buildTrackSnapshot(playbook);
  const { track, created } = await (
    await repo()
  ).createOrGet(
    {
      id: trackId,
      projectId: project.id,
      playbookId: playbook.id,
      name: trackName,
      definitionSnapshot: snapshot,
      methodVersion: String(playbook.version),
      // Seeded at birth, like a session's first stage: nobody "advanced into"
      // the first stage, so the gate is not consulted here.
      currentStage: firstStageKey(snapshot.stages),
    },
    actor.userId
  );

  if (created) {
    // Provenance edge — the same `instantiated_from` shape the proto-track
    // wrote, so every reader of `project --instantiated_from--> playbook`
    // keeps working. Idempotent on the unique edge.
    await createLinks([
      {
        workspaceId: project.workspaceId,
        fromType: "project",
        fromId: project.id,
        toType: "playbook",
        toId: playbook.id,
        linkType: "instantiated_from",
      },
    ]);
    void emitSideEffects({
      subjectType: "track",
      action: "create",
      subjectId: track.id,
      userId: actor.userId,
      workspaceId: project.workspaceId,
      data: {
        trackId: track.id,
        projectId: project.id,
        playbookId: playbook.id,
        methodVersion: track.methodVersion,
      },
    }).catch((err) =>
      logger.warn({ err, trackId: track.id }, "track.create emit failed")
    );
  }

  return {
    status: created ? "started" : "exists",
    track,
    playbook: playbookRef,
  };
}

// ── writes on an existing track ─────────────────────────────────────────────

/** Load a track the actor can SEE, and its project, for a write. */
async function loadTrackForWrite(
  trackId: string,
  actor: TrackActor
): Promise<{ track: ProjectTrack; project: GateProject }> {
  const track = await getTrack(trackId, actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }
  const db = await getDb();
  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }
  await assertProjectWrite(project, actor.userId);
  return { track, project };
}

/**
 * Refuse a status move the shared table (`TRACK_STATUS_TRANSITIONS`,
 * @synap-core/types/units) does not allow. Called by `setTrackStatus` AND by
 * the `track/update` approval replay: a proposal filed while the move was
 * legal can be approved after the track moved on (archived, say) — replaying
 * it unchecked would revive an archived track and collide with a newer live
 * track of the same method.
 */
export function assertTrackTransition(
  track: Pick<ProjectTrack, "name" | "status">,
  to: ProjectTrackStatus
): void {
  if (canTransitionTrack(track.status, to)) return;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      track.status === "archived"
        ? `Track "${track.name}" is archived — start the method again to run it anew.`
        : `A ${track.status} track cannot move to ${to}.`,
  });
}

export type SetTrackStatusResult =
  { status: "updated" | "unchanged"; track: ProjectTrack } | ProposedOutcome;

export async function setTrackStatus(input: {
  trackId: string;
  status: ProjectTrackStatus;
  actor: TrackActor;
}): Promise<SetTrackStatusResult> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  if (track.status === input.status) return { status: "unchanged", track };
  assertTrackTransition(track, input.status);

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    data: { id: track.id, name: track.name, status: input.status },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackStatus(track, project, input.status, input.actor.userId);
}

/**
 * The status write itself. Callers: `setTrackStatus` and the approval replay —
 * BOTH have run `assertTrackTransition` first. Compare-and-set on the status
 * it was decided from: a track moved by someone else in between is a
 * CONFLICT, never a silent overwrite. Every status change clears the check
 * gate's `metadata.checkGate` marker — a person has now decided the track's
 * state, so the hold it recorded no longer describes it.
 */
export async function applyTrackStatus(
  track: ProjectTrack,
  project: GateProject,
  status: ProjectTrackStatus,
  userId: string
): Promise<{ status: "updated"; track: ProjectTrack }> {
  const updated = await (
    await repo()
  ).transitionStatus(
    track.id,
    {
      from: track.status,
      to: status,
      dropMetadataKey: CHECK_GATE_METADATA_KEY,
    },
    userId
  );
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Track "${track.name}" changed while this was being decided — reload it and try again.`,
    });
  }
  void emitSideEffects({
    subjectType: "track",
    action: "update",
    subjectId: track.id,
    userId,
    workspaceId: project.workspaceId,
    data: {
      trackId: track.id,
      projectId: project.id,
      fromStatus: track.status,
      toStatus: status,
    },
  }).catch((err) =>
    logger.warn({ err, trackId: track.id }, "track.update emit failed")
  );
  return { status: "updated", track: updated };
}

// ── stage advance ───────────────────────────────────────────────────────────

export interface AdvanceTrackStageResult {
  status: "advanced" | "unchanged";
  track: ProjectTrack;
  /** True when the stage entered declares a gate (human or check). */
  gated: boolean;
  /** True only when the track row was actually flipped to `paused`. */
  paused: boolean;
  proposalId?: string;
  proposalType?: string;
  check?: { passed: boolean; failing: string[] };
}

/**
 * Move a track to ANY declared stage of its pinned method — forward, back or
 * sideways (stages are re-enterable). Governed for agents (`track/update`).
 */
export async function advanceTrackStage(input: {
  trackId: string;
  toStage: string;
  actor: TrackActor;
}): Promise<AdvanceTrackStageResult | ProposedOutcome> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  assertStageAdvanceable(track, input.toStage);
  if (track.currentStage === input.toStage) {
    return { status: "unchanged", track, gated: false, paused: false };
  }

  const perm = await checkPermissionOrPropose({
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? undefined,
    workspaceId: project.workspaceId ?? undefined,
    projectId: project.id,
    subjectType: "track",
    action: "update",
    source: input.actor.source,
    reasoning: input.actor.reasoning,
    data: { id: track.id, name: track.name, currentStage: input.toStage },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return proposed(
      perm,
      buildObjectActionTitle({
        action: "update",
        objectKind: "track",
        objectName: track.name,
      }) + " — proposed for review"
    );
  }
  return applyTrackStageAdvance({
    track,
    project,
    toStage: input.toStage,
    userId: input.actor.userId,
    agentUserId: input.actor.agentUserId ?? null,
    gate: true,
  });
}

/** Refuses a stage the pinned method does not declare, or a closed track. */
export function assertStageAdvanceable(track: ProjectTrack, toStage: string) {
  if (track.status === "archived" || track.status === "completed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" is ${track.status} — resume it before moving its stage.`,
    });
  }
  const keys = stageKeys(track.definitionSnapshot?.stages);
  if (!keys.includes(toStage)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        keys.length === 0
          ? `Track "${track.name}" follows a method with no stages.`
          : `"${toStage}" is not a stage of "${track.name}". Stages: ${keys.join(", ")}.`,
    });
  }
}

/**
 * THE writer of `project_tracks.current_stage` after birth. Writes the stage,
 * emits `track.stage_changed`, then hands the gate to the shared core.
 *
 * ORDER IS LOAD-BEARING, and it is the session door's order: the gate runs
 * AFTER the write and the emit — a gate is a PAUSE, not a veto
 * (services/playbooks/stage-gate.ts).
 *
 * `gate: false` is the APPROVAL RE-APPLY — a human has just answered the
 * proposal for this very advance; re-gating would ask the same person for the
 * same move twice (the precedent `advance-stage.ts` records for sessions).
 */
export async function applyTrackStageAdvance(params: {
  track: ProjectTrack;
  project: GateProject;
  toStage: string;
  userId: string;
  agentUserId?: string | null;
  gate: boolean;
}): Promise<AdvanceTrackStageResult> {
  const { track, project, toStage, userId } = params;
  const fromStage = track.currentStage ?? null;
  if (fromStage === toStage) {
    return { status: "unchanged", track, gated: false, paused: false };
  }

  // Compare-and-set: the stage moves ONLY from the stage this advance was
  // decided on. Two concurrent advances cannot both land; the loser is told.
  const updated = await (
    await repo()
  ).advanceStage(track.id, fromStage, toStage, userId);
  if (!updated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Track "${track.name}" moved stage while this was being decided — reload it and try again.`,
    });
  }

  void emitSideEffects({
    subjectType: "track",
    action: "stage_changed",
    subjectId: track.id,
    userId,
    workspaceId: project.workspaceId,
    data: {
      trackId: track.id,
      projectId: project.id,
      playbookId: track.playbookId,
      fromStage,
      toStage,
      workspaceId: project.workspaceId,
      userId,
    },
  }).catch((err) =>
    logger.warn(
      { err, trackId: track.id, toStage },
      "track.stage_changed emit failed"
    )
  );

  const outcome: StageGateOutcome = params.gate
    ? await applyStageGate(
        trackGateSubject({
          trackId: track.id,
          userId,
          projectId: project.id,
          workspaceId: project.workspaceId,
          playbookId: track.playbookId,
          snapshotStages: track.definitionSnapshot?.stages,
        }),
        {
          userId,
          agentUserId: params.agentUserId ?? null,
          toStage,
          fromStage,
        }
      )
    : null;

  // The RETURNED row is the post-gate state: when the gate paused the track,
  // re-read it, so `paused: true` never travels beside `status: "active"`.
  let after = updated;
  if (outcome?.paused) {
    const db = await getDb();
    const [row] = await db
      .select()
      .from(projectTracks)
      .where(eq(projectTracks.id, track.id))
      .limit(1);
    if (row) after = row as ProjectTrack;
  }
  const base = { status: "advanced" as const, track: after };
  if (!outcome) return { ...base, gated: false, paused: false };
  if (outcome.kind === "check") {
    return {
      ...base,
      gated: true,
      paused: outcome.paused,
      check: { passed: outcome.passed, failing: outcome.failing },
    };
  }
  return {
    ...base,
    gated: true,
    paused: outcome.paused,
    proposalId: outcome.proposalId,
    proposalType: outcome.proposalType,
  };
}

// ── sessions filed inside a track ───────────────────────────────────────────

/**
 * Validate a session/run being filed into a track. Returns the project the
 * session must carry: the TRACK's project. A `projectId` that disagrees is a
 * refusal, never a silent correction; an archived track takes no new work.
 */
export async function resolveTrackFiling(params: {
  trackId: string;
  projectId?: string | null;
  actor: TrackActor;
}): Promise<{ trackId: string; projectId: string }> {
  const track = await getTrack(params.trackId, params.actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }
  if (params.projectId && params.projectId !== track.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" belongs to another project — pass that project, or omit projectId.`,
    });
  }
  if (track.status === "archived") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" is archived and takes no new work.`,
    });
  }
  return { trackId: track.id, projectId: track.projectId };
}
