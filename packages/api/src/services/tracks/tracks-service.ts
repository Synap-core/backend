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
 *   startTrack        — the ONE way a track is born. The proto-track door
 *                       `projects.instantiateFromPlaybook` was retired (W5c);
 *                       its legacy approval executor calls startTrack directly.
 *   setTrackStatus    — pause / resume / complete / archive.
 *   advanceTrackStage — the ONE writer of `project_tracks.current_stage` after
 *                       birth. Gate evaluation is the subject-agnostic core in
 *                       `services/playbooks/stage-gate.ts` (`applyStageGate`),
 *                       shared with `advanceSessionStage` — never a copy.
 *                       Entering a stage OFFERS its session (`offer`); it
 *                       never starts one.
 *   setTrackParams    — the method's param answers (0274), governed `track/update`.
 *   startStageSession — the ONE door that starts a stage's session: a thin
 *                       wrapper over `createFocusSession` (same governance),
 *                       idempotent on an open session already filed there.
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
  desc,
  eq,
  getDb,
  inArray,
  isNotNull,
  ne,
  or,
  focusSessions,
  playbooks,
  projects,
  projectTracks,
  drizzleSql,
} from "@synap/database";
import {
  describeParamTypeError,
  readPlaybookParams,
  validatePlaybookParams,
} from "@synap/playbooks";
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
  readTrackStage,
  readTrackStageHistory,
  trackPausedBy,
  type TrackPausedBy,
  type TrackStage,
  type TrackStageHistoryEntry,
  type TrackStatus,
} from "@synap-core/types/units";
import {
  CHECK_GATE_METADATA_KEY,
  OPEN_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import { trackRepository } from "./track-repo.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { projectVisibleWhere } from "../../access/project-visibility.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
import { projectPathConditions } from "../projects/project-path.js";
import type { CreateFocusSessionParams } from "../focus-sessions/create-session.js";
import { createLinks } from "../links/links-service.js";
import { linkProjectToWorkspace } from "../../utils/project-workspace.js";
import {
  listMissingStageDomains,
  resolveStageDomainWorkspace,
  workspacePackageSlug,
  type StageDomainFallbackReason,
} from "./stage-domain.js";
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
  /**
   * The PINNED stages, positioned against `currentStage`, with what each
   * declares (goal, gate, criteria…) and — when counted — `sessionCount`.
   */
  stages: TrackStage[];
  /** The method's param answers (0274). */
  params: Record<string, unknown>;
  /**
   * The params the method DECLARED, as pinned at start — what `params`
   * answers. Surfaces render the onboarding form from this, never from the
   * live playbook, whose params may have moved on since the pin.
   */
  declaredParams: unknown[];
  /** Every stage the track entered, oldest first (0274). */
  stageHistory: TrackStageHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Project a track. `sessionsByStage` (from {@link countTrackSessionsByStage})
 * fills each stage's `sessionCount`; without it the key is absent — "not
 * counted", never a fabricated 0. Every read door uses {@link loadTrackViews}.
 */
export function toTrackView(
  track: ProjectTrack,
  sessionsByStage?: Readonly<Record<string, number>>
): TrackView {
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
      track.currentStage,
      sessionsByStage
    ),
    params:
      track.params && typeof track.params === "object" ? track.params : {},
    declaredParams: Array.isArray(track.definitionSnapshot?.params)
      ? track.definitionSnapshot.params
      : [],
    stageHistory: readTrackStageHistory(track.stageHistory),
    createdAt: new Date(track.createdAt).toISOString(),
    updatedAt: new Date(track.updatedAt).toISOString(),
  };
}

/**
 * Sessions filed at each stage of each track — ONE grouped query for any
 * number of tracks. The counted set is the PROJECT PATH's session set for the
 * track's project (`projectPathConditions`, default lens: the caller's own
 * work + tracked runs, undecided agent drafts hidden), narrowed by
 * `track_stage` — so a stage's count is the number of sessions the project
 * path would list at that stage, not a second population. A failed read
 * THROWS: a count that silently became 0 would read as "nothing was done at
 * this stage".
 *
 * NB this is deliberately NOT the check GATE's population. The gate
 * (`measureTrackStage`) counts EVERY member's sessions filed at the stage, on
 * purpose — the track is the project's, and so is its gate — while this count
 * is what one reader's surface lists. The two may differ, and that is correct.
 */
export async function countTrackSessionsByStage(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "projectId">>,
  userId: string
): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>(
    tracks.map((t) => [t.id, {}])
  );
  if (tracks.length === 0) return out;
  const byProject = new Map<string, string[]>();
  for (const t of tracks) {
    const ids = byProject.get(t.projectId) ?? [];
    if (!ids.includes(t.id)) ids.push(t.id);
    byProject.set(t.projectId, ids);
  }
  const db = await getDb();
  const rows = await db
    .select({
      trackId: focusSessions.trackId,
      trackStage: focusSessions.trackStage,
      n: drizzleSql<number>`count(*)`,
    })
    .from(focusSessions)
    .where(
      and(
        isNotNull(focusSessions.trackStage),
        or(
          ...[...byProject].map(([projectId, ids]) =>
            and(
              inArray(focusSessions.trackId, ids),
              ...projectPathConditions({ userId, projectId, lens: "default" })
            )
          )
        )
      )
    )
    .groupBy(focusSessions.trackId, focusSessions.trackStage);
  for (const r of rows) {
    if (!r.trackId || !r.trackStage) continue;
    const counts = out.get(r.trackId);
    if (counts) counts[r.trackStage] = Number(r.n);
  }
  return out;
}

/** Track views with per-stage session counts — what every track READ returns. */
export async function loadTrackViews(
  tracks: ProjectTrack[],
  actor: Pick<TrackActor, "userId">
): Promise<TrackView[]> {
  const counts = await countTrackSessionsByStage(tracks, actor.userId);
  return tracks.map((t) => toTrackView(t, counts.get(t.id) ?? {}));
}

/**
 * The view a track WRITE returns. The write already happened, so a failed
 * count read must not turn it into a 500: the view comes back WITHOUT counts
 * (`sessionCount` absent — "not counted", never a fabricated 0), and the
 * failure is logged. Reads keep throwing ({@link loadTrackViews}).
 */
export async function loadWrittenTrackView(
  track: ProjectTrack,
  actor: Pick<TrackActor, "userId">
): Promise<TrackView> {
  try {
    return await loadTrackView(track, actor);
  } catch (err) {
    logger.warn(
      { err, trackId: track.id },
      "track written, but its stage counts could not be read"
    );
    return toTrackView(track);
  }
}

export async function loadTrackView(
  track: ProjectTrack,
  actor: Pick<TrackActor, "userId">
): Promise<TrackView> {
  const [view] = await loadTrackViews([track], actor);
  return view!;
}

/**
 * Resolve param answers against the method's DECLARED params (the pinned
 * snapshot). Refuses a mistyped value and an undeclared key — a stored,
 * rendered bag must have a declared shape. Returns only the keys the caller
 * actually supplied (a default stays the method's, never frozen onto the
 * track), coerced. A REQUIRED param left unanswered is NOT refused here: it
 * becomes an owed slot on the stage session that needs it.
 */
export function resolveTrackParams(
  declaredRaw: unknown,
  supplied: Record<string, unknown>
): Record<string, unknown> {
  const declared = readPlaybookParams(declaredRaw);
  const names = new Set(declared.map((p) => p.name));
  const undeclared = Object.keys(supplied).filter((k) => !names.has(k));
  if (undeclared.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        declared.length === 0
          ? `This method declares no params — cannot store ${undeclared.map((k) => `"${k}"`).join(", ")}.`
          : `Unknown param${undeclared.length > 1 ? "s" : ""} ${undeclared.map((k) => `"${k}"`).join(", ")}. The method declares: ${[...names].join(", ")}.`,
    });
  }
  const resolution = validatePlaybookParams(declared, supplied);
  const [first] = resolution.typeErrors;
  if (first) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: describeParamTypeError(first),
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(supplied)) {
    if (v === undefined || v === null || v === "") continue;
    if (k in resolution.declaredValues) out[k] = resolution.declaredValues[k];
  }
  return out;
}

/** What a track pins from its method. The same fields a run snapshots. */
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
    // The method's DECLARED params (0274): what `project_tracks.params`
    // answers, pinned like the stages so a method edit never changes what a
    // live track is asked.
    params: structuredClone(
      Array.isArray(playbook.params) ? playbook.params : []
    ),
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
  // A READ: the project is checked through the SAME `projects` VisibilityRule
  // the tracks below are floored on — member branch included (Sites W2 S2: a
  // project member, guest included, sees the project's tracks). NOT
  // `loadVisibleProject`: that floor also gates WRITES, so it deliberately has
  // no member branch.
  const access = AccessContext.from(params.actor);
  const project = await scopedDb(access).findFirst<{ id: string }>(projects, {
    where: eq(projects.id, params.projectId),
    columns: { id: true },
  });
  if (!project) return null;
  return scopedDb(access).findMany<ProjectTrack>(projectTracks, {
    where: and(
      eq(projectTracks.projectId, params.projectId),
      params.includeArchived ? undefined : ne(projectTracks.status, "archived")
    ),
    orderBy: [asc(projectTracks.createdAt), asc(projectTracks.id)],
  });
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
  /**
   * Initial answers to the method's declared params (0274). Validated against
   * the method (`resolveTrackParams`): a mistyped value or an undeclared key
   * refuses. A required param left out is NOT refused — it is owed on the
   * stage session that needs it.
   */
  params?: Record<string, unknown>;
  actor: TrackActor;
  /**
   * Pre-minted id — ONLY the approval replay passes it (the id the proposal
   * was filed under), so the approved row and its receipt name the same id.
   */
  id?: string;
}

export type StartTrackResult = (
  | {
      status: "started" | "exists";
      track: ProjectTrack;
      playbook: { id: string; name: string; version: number };
    }
  | ProposedOutcome
) & {
  /**
   * Stage domains (workspace template slugs) with no live workspace the
   * caller can see — ADVISORY, never a refusal: those stages' sessions fall
   * back to the project's home workspace (and say so) until one is installed.
   */
  missingDomains: string[];
};

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

  // Advisory, computed from the method AS IT STANDS (what would be pinned).
  const missingDomains = await listMissingStageDomains(
    db,
    playbook.stages,
    actor.userId
  );

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
      missingDomains,
    };
  }

  const trackName = input.name?.trim() || playbook.name;
  const trackId = input.id ?? randomUUID();
  // Refused BEFORE governance, so a malformed answer is told to its author
  // rather than filed for a human to approve.
  const trackParams = input.params
    ? resolveTrackParams(playbook.params, input.params)
    : {};

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
      // The answers ride the proposal; the replay re-validates them against
      // the method as it stands at approval.
      ...(Object.keys(trackParams).length > 0 ? { params: trackParams } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return {
      ...proposed(
        perm,
        buildObjectActionTitle({
          action: "create",
          objectKind: "track",
          objectName: trackName,
        }) + " — proposed for review"
      ),
      missingDomains,
    };
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
      params: trackParams,
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
    missingDomains,
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

/**
 * The session a stage OFFERS once the track enters it (M2). Entering a stage
 * never starts work: the offer is what a surface shows as "Start this step",
 * and `startStageSession` is the one door that acts on it.
 */
export interface StageSessionOffer {
  stageKey: string;
  name: string;
  /** The stage's own goal — the brief the session is started with. */
  goal: string | null;
  suggestedTasks: string[];
}

export interface AdvanceTrackStageResult {
  status: "advanced" | "unchanged";
  track: ProjectTrack;
  /** True when the stage entered declares a gate (human or check). */
  gated: boolean;
  /** True only when the track row was actually flipped to `paused`. */
  paused: boolean;
  proposalId?: string;
  proposalType?: string;
  check?: { passed: boolean; failing: string[]; reason?: string };
  /**
   * The session the stage just entered offers — `null` when nothing moved, or
   * when the caller already has an open session filed at that stage.
   */
  offer: StageSessionOffer | null;
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
    return {
      status: "unchanged",
      track,
      gated: false,
      paused: false,
      offer: null,
    };
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
    return {
      status: "unchanged",
      track,
      gated: false,
      paused: false,
      offer: null,
    };
  }

  // Compare-and-set: the stage moves ONLY from the stage this advance was
  // decided on. Two concurrent advances cannot both land; the loser is told.
  // The SAME statement appends the stage-history entry (0274).
  const updated = await (
    await repo()
  ).advanceStage(
    track.id,
    fromStage,
    toStage,
    userId,
    params.agentUserId ?? userId
  );
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
  const offer = await stageSessionOffer(after, toStage, userId);
  const base = { status: "advanced" as const, track: after, offer };
  if (!outcome) return { ...base, gated: false, paused: false };
  if (outcome.kind === "check") {
    return {
      ...base,
      gated: true,
      paused: outcome.paused,
      check: {
        passed: outcome.passed,
        failing: outcome.failing,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
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

/** The caller's newest OPEN session filed at this stage of this track, if any. */
/**
 * The caller's OPEN session filed at (track, stage) — the idempotency probe of
 * `startStageSession`, re-run by `createFocusSession({ oneOpenPerStage })`
 * under its advisory lock (hence `database`: the locking transaction).
 */
export async function openStageSession(
  trackId: string,
  stageKey: string,
  userId: string,
  database?: Awaited<ReturnType<typeof getDb>>
) {
  const db = database ?? (await getDb());
  // SESSION-KIND-LENS-EXEMPT: an idempotency probe for ONE (track, stage), not a list door.
  const [row] = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.trackId, trackId),
        eq(focusSessions.trackStage, stageKey),
        eq(focusSessions.userId, userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The offer for a stage just entered (M2) — derived purely from the PINNED
 * stage, `null` when the caller already has an open session filed there
 * (nothing to offer) or the stage is not declared.
 */
async function stageSessionOffer(
  track: ProjectTrack,
  stageKey: string,
  userId: string
): Promise<StageSessionOffer | null> {
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);
  if (!stage) return null;
  if (await openStageSession(track.id, stageKey, userId)) return null;
  return {
    stageKey: stage.key,
    name: stage.name,
    goal: stage.goal ?? null,
    suggestedTasks: stage.suggestedTasks ?? [],
  };
}

export interface TrackFiling {
  trackId: string;
  projectId: string;
  /**
   * The stage the session is FILED at (M1): the caller's explicit stage when
   * given (validated against the pinned stages), else the track's current
   * stage; `null` for a stageless method.
   */
  trackStage: string | null;
  trackName: string;
  /** The method's DECLARED params, as pinned — what `params` answers. */
  methodParams: unknown;
}

/**
 * Validate a session/run being filed into a track. Returns the project the
 * session must carry: the TRACK's project. A `projectId` that disagrees is a
 * refusal, never a silent correction; an archived track takes no new work.
 * An explicit `trackStage` naming a stage the method does not declare is a
 * refusal too.
 */
export async function resolveTrackFiling(params: {
  trackId: string;
  projectId?: string | null;
  /** An explicit stage to file at. Absent/null ⇒ the track's current stage. */
  trackStage?: string | null;
  actor: TrackActor;
}): Promise<TrackFiling> {
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
  return {
    trackId: track.id,
    projectId: track.projectId,
    trackStage: resolveFilingStage(track, params.trackStage),
    trackName: track.name,
    methodParams: track.definitionSnapshot?.params,
  };
}

/**
 * THE stage rule for filing (M1), shared by the direct doors and the
 * `focus_session/create` approval replay: an explicit stage must be one the
 * track PINNED; absent ⇒ the track's current stage.
 */
export function resolveFilingStage(
  track: Pick<ProjectTrack, "name" | "currentStage" | "definitionSnapshot">,
  explicit: string | null | undefined
): string | null {
  if (explicit === undefined || explicit === null || explicit === "") {
    return track.currentStage ?? null;
  }
  const keys = stageKeys(track.definitionSnapshot?.stages);
  if (!keys.includes(explicit)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        keys.length === 0
          ? `Track "${track.name}" follows a method with no stages — omit trackStage.`
          : `"${explicit}" is not a stage of "${track.name}". Stages: ${keys.join(", ")}.`,
    });
  }
  return explicit;
}

// ── params ──────────────────────────────────────────────────────────────────

export type SetTrackParamsResult =
  { status: "updated" | "unchanged"; track: ProjectTrack } | ProposedOutcome;

/**
 * Answer (some of) the method's params — MERGED onto the track's current
 * answers; a `null` value clears that answer. Governed `track/update` (the
 * existing key; its executor replays through {@link applyTrackParams}).
 */
export async function setTrackParams(input: {
  trackId: string;
  params: Record<string, unknown>;
  actor: TrackActor;
}): Promise<SetTrackParamsResult> {
  const { track, project } = await loadTrackForWrite(
    input.trackId,
    input.actor
  );
  const next = mergeTrackParams(track, input.params);
  if (JSON.stringify(next) === JSON.stringify(track.params ?? {})) {
    return { status: "unchanged", track };
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
    // The PATCH, not the merged result: the replay merges onto the answers as
    // they stand at approval, so an answer given in between is not reverted.
    data: { id: track.id, name: track.name, params: input.params },
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
  return applyTrackParams(track, input.params, input.actor.userId);
}

function mergeTrackParams(
  track: Pick<ProjectTrack, "params" | "definitionSnapshot">,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...((track.params as Record<string, unknown> | null) ?? {}),
  };
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else answers[k] = v;
  }
  return {
    ...merged,
    ...resolveTrackParams(track.definitionSnapshot?.params, answers),
  };
}

/** The params write. Callers: `setTrackParams` and the `track/update` replay. */
export async function applyTrackParams(
  track: ProjectTrack,
  patch: Record<string, unknown>,
  userId: string
): Promise<{ status: "updated"; track: ProjectTrack }> {
  // Validated + coerced against the PINNED declaration; the write itself is a
  // SQL merge of exactly these keys (`patchParams`), never the whole bag.
  const clear = Object.keys(patch).filter((k) => patch[k] === null);
  const answers = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== null)
  );
  const set = resolveTrackParams(track.definitionSnapshot?.params, answers);
  const updated = await (
    await repo()
  ).patchParams(track.id, { set, clear }, userId);
  if (!updated) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }
  return { status: "updated", track: updated };
}

// ── the stage session (M2) ──────────────────────────────────────────────────

/**
 * Where a stage that names a DOMAIN was worked (W2a). Present only when the
 * pinned stage declares `domain` — absent means "no domain asked for".
 */
export type StageSessionDomainOutcome =
  | {
      /** The session was placed in (or found in) a workspace of that template. */
      domain: {
        wanted: string;
        workspaceId: string;
        /**
         * `project --uses--> workspace` was stamped. `false` only on a
         * PROPOSED session — nothing exists yet to have used the domain; the
         * stamp lands when this door next returns the approved session.
         */
        usesStamped: boolean;
      };
      domainFallback?: never;
    }
  | {
      /**
       * NO workspace of that template could take the session: it was placed
       * in the project's HOME workspace instead. Never silent — `reason` says
       * what would fix it.
       */
      domainFallback: { wanted: string; reason: StageDomainFallbackReason };
      domain?: never;
    }
  | { domain?: never; domainFallback?: never };

export type StartStageSessionResult = (
  | {
      /**
       * `created` — a new session; `existing` — the caller already had an open
       * session filed at this stage, returned untouched; `deduped` — an open
       * twin (same goal, track and stage) was returned by the session door.
       */
      status: "created" | "existing" | "deduped";
      stageKey: string;
      session: typeof focusSessions.$inferSelect;
    }
  | (Omit<ProposedOutcome, "reviewUrl"> & {
      stageKey: string;
      /** Present only when the governance door returned one — never invented. */
      reviewUrl?: string;
    })
) &
  StageSessionDomainOutcome;

/**
 * THE ONE DOOR that starts a stage's session (M2). Entering a stage only
 * OFFERS this; nothing auto-starts.
 *
 * A thin wrapper over `createFocusSession` — the SAME governance (an agent
 * PROPOSES a `focus_session/create`; no new proposal key), the same dedup and
 * the same project ladder. What it adds is only what the stage declares:
 *   - goal: the caller's, else the stage's goal (the brief), else the
 *     method's goalTemplate, else the stage name;
 *   - expected outputs + criteria: the stage's, as pinned;
 *   - params: the TRACK's answers, so a REQUIRED method param still missing
 *     becomes a human-owned slot on this session (stage 1 = onboarding);
 *   - trackId + trackStage.
 * IDEMPOTENT: the caller's open session already filed at that stage is
 * returned (`existing`) and nothing is filed or written.
 */
export async function startStageSession(input: {
  trackId: string;
  /** Absent ⇒ the track's current stage. */
  stageKey?: string | null;
  title?: string | null;
  goal?: string | null;
  actor: TrackActor;
}): Promise<StartStageSessionResult> {
  const { actor } = input;
  const track = await getTrack(input.trackId, actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }
  if (track.status === "archived" || track.status === "completed") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" is ${track.status} — reopen it before starting work in it.`,
    });
  }
  const stageKey = resolveFilingStage(track, input.stageKey);
  if (!stageKey) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" stands on no stage — pass stageKey.`,
    });
  }
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);

  const db = await getDb();
  const open = await openStageSession(track.id, stageKey, actor.userId);
  if (open) {
    // A session approved AFTER a proposal comes back here: it now exists in
    // the domain's workspace, so the `uses` stamp the proposal could not make
    // lands now. Only when the session really sits in that template's
    // workspace — never re-derived from the stage alone.
    if (
      stage?.domain &&
      open.workspaceId &&
      (await workspacePackageSlug(db, open.workspaceId)) === stage.domain
    ) {
      const uses = await linkProjectToWorkspace(db, {
        projectId: track.projectId,
        workspaceId: open.workspaceId,
        userId: actor.userId,
      });
      return {
        status: "existing",
        stageKey,
        session: open,
        domain: {
          wanted: stage.domain,
          workspaceId: open.workspaceId,
          usesStamped: uses.linked,
        },
      };
    }
    return { status: "existing", stageKey, session: open };
  }

  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }

  // PER-STEP DOMAIN (W2a): the stage names a workspace TEMPLATE; work it in a
  // live workspace of that template the caller can write to (one the project
  // already uses wins). None ⇒ the project's home, REPORTED, never silent.
  let sessionWorkspaceId: string | null = project.workspaceId ?? null;
  let domainWorkspaceId: string | null = null;
  let domainFallback:
    { wanted: string; reason: StageDomainFallbackReason } | undefined;
  if (stage?.domain) {
    const resolved = await resolveStageDomainWorkspace(db, {
      slug: stage.domain,
      projectId: project.id,
      userId: actor.userId,
    });
    if (resolved.resolved) {
      sessionWorkspaceId = resolved.workspaceId;
      domainWorkspaceId = resolved.workspaceId;
    } else {
      domainFallback = { wanted: resolved.slug, reason: resolved.reason };
    }
  }

  const goal =
    input.goal?.trim() ||
    stage?.goal?.trim() ||
    (typeof track.definitionSnapshot?.goalTemplate === "string" &&
      track.definitionSnapshot.goalTemplate.trim()) ||
    `${stage?.name ?? stageKey} — ${track.name}`;

  // Dynamic: `create-session.ts` imports this module (resolveTrackFiling).
  const { createFocusSession } =
    await import("../focus-sessions/create-session.js");
  const result = await createFocusSession({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: sessionWorkspaceId,
    projectId: track.projectId,
    trackId: track.id,
    trackStage: stageKey,
    title: input.title?.trim() || stage?.name || null,
    goal,
    // A stage session is not a template run: never bind or match a playbook.
    templateId: null,
    // Pinned jsonb, validated by `createFocusSession`'s own floors.
    ...(stage?.expectedOutputs?.length
      ? {
          expectedOutputs: stage.expectedOutputs as unknown as NonNullable<
            CreateFocusSessionParams["expectedOutputs"]
          >,
        }
      : {}),
    ...(stage?.criteria?.length
      ? {
          criteria: stage.criteria as unknown as NonNullable<
            CreateFocusSessionParams["criteria"]
          >,
        }
      : {}),
    params: (track.params as Record<string, unknown> | null) ?? {},
    // Check-then-create under ONE lock: the probe above is only a fast path.
    oneOpenPerStage: true,
  });
  const domainOutcome = (usesStamped: boolean): StageSessionDomainOutcome =>
    domainWorkspaceId && stage?.domain
      ? {
          domain: {
            wanted: stage.domain,
            workspaceId: domainWorkspaceId,
            usesStamped,
          },
        }
      : domainFallback
        ? { domainFallback }
        : {};
  if (result.status === "proposed") {
    return {
      status: "proposed",
      stageKey,
      proposalId: result.proposalId,
      proposalType: result.proposalType ?? "focus_session.create",
      message: result.message,
      ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
      ...domainOutcome(false),
    };
  }
  // The session EXISTS in the domain's workspace: stamp the project's use of
  // it through the one `uses` door — a derived index under the session create
  // that governance already allowed, never a raw link insert.
  let usesStamped = false;
  if (domainWorkspaceId && result.session.workspaceId === domainWorkspaceId) {
    usesStamped = (
      await linkProjectToWorkspace(db, {
        projectId: project.id,
        workspaceId: domainWorkspaceId,
        userId: actor.userId,
      })
    ).linked;
  }
  return {
    status: result.status === "deduped" ? "deduped" : "created",
    stageKey,
    session: result.session,
    ...domainOutcome(usesStamped),
  };
}
