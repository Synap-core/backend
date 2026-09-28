/**
 * ADOPT an existing session into a track step (or unfile it) — the ONE
 * resolution every update door runs: MCP `update_session`
 * (`updateFocusSession`), the Hub PATCH, the tRPC `focusSessions.update`, and
 * the `focus_session/update` approval executor (which RE-resolves, so a track
 * archived or a stage dropped since the proposal is refused, not written).
 *
 * Not a second rule. The track is loaded through `getTrack` (the scoped
 * visibility floor), and the archived check + the stage rule are
 * `resolveTrackFiling` / `resolveFilingStage` — the same code the create doors
 * run. What this adds is only what an EXISTING row brings:
 *   - the session already has a project ⇒ it must be the track's (refused
 *     otherwise, never silently moved across projects);
 *   - the session has NO project ⇒ filing sets it to the track's project, and
 *     `projectName` is returned so the proposal title can say so;
 *   - the step names a DOMAIN the session's space is not ⇒ the session is NOT
 *     moved; it is filed where it is, and `domainNote` says so.
 *
 * Throws `TRPCError` (NOT_FOUND / BAD_REQUEST); each door maps it to its own
 * refusal shape.
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "@synap/database";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { readTrackStage } from "@synap-core/types/units";
import {
  getTrack,
  resolveTrackFiling,
  type TrackActor,
} from "./tracks-service.js";
import { workspacePackageSlug } from "./stage-domain.js";
import { loadVisibleProject } from "../projects/load-visible-project.js";
import { linkProjectToWorkspace } from "../../utils/project-workspace.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-track-filing" });

export interface SessionTrackFilingPatch {
  /** File into this track; `null` UNFILES (track + stage cleared). */
  trackId?: string | null;
  /** The step. Absent/null ⇒ the track's current stage. Alone ⇒ re-file within the session's track. */
  trackStage?: string | null;
}

export interface SessionTrackFiling {
  /** The columns to write. `projectId` only when filing moves an unfiled session in. */
  set: {
    trackId: string | null;
    trackStage: string | null;
    projectId?: string;
  };
  /** Display only — the proposal title and the door's answer. */
  trackName: string | null;
  stageName: string | null;
  /** Present only when filing ALSO sets the session's project. */
  projectName: string | null;
  /** The track's project home — the `uses` stamp skips it. */
  projectWorkspaceId: string | null;
  /** The step names a domain the session's space is not; the session stays put. */
  domainNote?: string;
}

/** Does this patch touch the track filing at all? */
export function hasTrackFilingPatch(p: SessionTrackFilingPatch): boolean {
  return p.trackId !== undefined || p.trackStage !== undefined;
}

export async function resolveSessionTrackFiling(params: {
  session: {
    projectId: string | null;
    trackId: string | null;
    workspaceId: string | null;
  };
  patch: SessionTrackFilingPatch;
  /** The same call's `projectId` patch, if any (`undefined` = unchanged). */
  projectId?: string | null;
  actor: TrackActor;
}): Promise<SessionTrackFiling> {
  const { session, patch, actor } = params;

  if (patch.trackId === null) {
    if (typeof patch.trackStage === "string" && patch.trackStage) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "trackId: null unfiles the session from its track — do not pass a trackStage with it.",
      });
    }
    return {
      set: { trackId: null, trackStage: null },
      trackName: null,
      stageName: null,
      projectName: null,
      projectWorkspaceId: null,
    };
  }

  const trackId = patch.trackId ?? session.trackId;
  if (!trackId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "trackStage needs trackId — this session is in no track yet; pass the track to file it into.",
    });
  }
  const track = await getTrack(trackId, actor);
  if (!track) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }

  if (params.projectId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Cannot unfile the session from its project and file it into a track in one call.",
    });
  }
  const effectiveProjectId =
    params.projectId !== undefined ? params.projectId : session.projectId;
  if (effectiveProjectId && effectiveProjectId !== track.projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Track "${track.name}" belongs to another project than this session — a session is filed into a track of its own project.`,
    });
  }

  // THE shared rules: archived refusal + the stage must be one the track pinned.
  const filing = await resolveTrackFiling({
    trackId: track.id,
    projectId: track.projectId,
    trackStage: patch.trackStage,
    actor,
  });

  const db = await getDb();
  const project = await loadVisibleProject(db, track.projectId, actor.userId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
  }

  const stage = filing.trackStage
    ? readTrackStage(track.definitionSnapshot?.stages, filing.trackStage)
    : null;
  const stageName = filing.trackStage
    ? stage?.name?.trim() || humanizeToken(filing.trackStage)
    : null;

  let domainNote: string | undefined;
  if (stage?.domain) {
    const slug = session.workspaceId
      ? await workspacePackageSlug(db, session.workspaceId)
      : null;
    if (slug !== stage.domain) {
      domainNote = `Step "${stageName}" is worked in the "${stage.domain}" domain; this session stays in its current space — it was filed, not moved.`;
    }
  }

  return {
    set: {
      trackId: filing.trackId,
      trackStage: filing.trackStage,
      ...(effectiveProjectId ? {} : { projectId: track.projectId }),
    },
    trackName: filing.trackName,
    stageName,
    projectName: effectiveProjectId ? null : project.name,
    projectWorkspaceId: project.workspaceId ?? null,
    ...(domainNote ? { domainNote } : {}),
  };
}

/**
 * After the filing LANDED: stamp `project --uses--> <the session's space>`
 * through the one `uses` door, so the project lists the space its adopted
 * work lives in. Skipped for an unfile, a session in no space, and the
 * project's own home. Returns whether a stamp was written (`false` also when
 * the stamp failed — logged; the filing itself stands).
 */
export async function stampTrackFilingUses(args: {
  filing: SessionTrackFiling;
  sessionWorkspaceId: string | null;
  projectId: string | null;
  userId: string;
}): Promise<boolean> {
  const { filing, sessionWorkspaceId, projectId } = args;
  if (!filing.set.trackId || !sessionWorkspaceId || !projectId) return false;
  if (sessionWorkspaceId === filing.projectWorkspaceId) return false;
  // The filing already LANDED: a failed index stamp must not turn it into an
  // error. Reported as `usesStamped: false` and logged, never thrown.
  try {
    const db = await getDb();
    const res = await linkProjectToWorkspace(db, {
      projectId,
      workspaceId: sessionWorkspaceId,
      userId: args.userId,
    });
    return res.linked;
  } catch (err) {
    logger.warn(
      { err, projectId, workspaceId: sessionWorkspaceId },
      "session filed into a track, but the project `uses` stamp failed"
    );
    return false;
  }
}

/** A `TRPCError` from the resolution, as a door's refusal sentence. */
export function trackFilingRefusal(err: unknown): string | null {
  return err instanceof TRPCError ? err.message : null;
}
