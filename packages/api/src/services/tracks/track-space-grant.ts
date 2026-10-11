/**
 * TRACK SPACE GRANT — founder decision 2a (2026-09-28), reshaped by work-model
 * W5 (2026-10-11): agent access comes from the PROJECT'S SPACES, while the
 * track is ACTIVE.
 *
 * Starting a track admits the agent working it into the spaces the track's
 * project runs through (its `project --uses--> workspace` links,
 * `project_use_workspace`), SCOPED to that track. It exists so an agent
 * working one lasting track across Strategy, Finance and Research is not
 * stopped by a separate workspace-JOIN approval in every one of them. A legacy
 * staged track also keeps its STEP spaces (the workspaces its stages'
 * `domain`s resolve to) — stages are optional now, never required.
 *
 * ── WHAT IT IS (and what it is deliberately NOT) ────────────────────────────
 * NOT a `workspace_members` row. A membership is honoured by every reader and
 * writer in the pod and outlives the track — exactly the blanket access the
 * decision rules out. The grant is instead a CONSENT RECORD on the track row
 * (`project_tracks.metadata.spaceGrant`), consulted at ONE place: the join
 * gate's membership-miss branch (`checkPermissionOrPropose`). There it admits
 * a write only when that write belongs to the track:
 *   (a) a session of the track being started (`focus_session/create`
 *       carrying `trackId`); or
 *   (b) a write made from a session (ambient `sessionId`) that is filed into
 *       the track, still open, and sits in THIS workspace;
 * and in both cases the workspace is one the grant lists, the acting agent is
 * one the grant names, the track is ACTIVE, and the workspace still belongs
 * to the track: the project links it NOW (an unlinked space stops admitting),
 * or — legacy staged tracks — the session's step names it (its `domain` is
 * the workspace's template slug). Admission only skips the JOIN — the normal
 * governance ladder still runs.
 *
 * ── CONSENT ─────────────────────────────────────────────────────────────────
 *   - an agent's start, PROPOSED: the approval is the consent. The proposal's
 *     summary names the agent and the spaces; at approval the granted set is
 *     the spaces re-resolved NOW ∩ the spaces the proposal LISTED (what the
 *     person read — a revised payload can never widen it).
 *   - an agent's start, auto-approved: the person's own governance rule let it
 *     through; the grant names that agent and the resolved spaces.
 *   - a person's own start: the person is the consent. No agent is known yet,
 *     so the grant admits any agent acting FOR that person (`agentUserIds:
 *     null`), still only through this track's sessions. A named default — the
 *     narrower alternative is "no agent until one is named".
 * Only spaces the starting person can WRITE are granted: nobody consents to
 * a space they could not work in themselves. A space linked AFTER the start
 * is not admitted (it was never consented to) — start no new grant for it.
 *
 * ── END ─────────────────────────────────────────────────────────────────────
 * PAUSING suspends it: the gate admits only an ACTIVE track, so resuming
 * restores it with nothing to rewrite. Completing or archiving the track
 * stamps `endedAt` (`applyTrackStatus`), so a later reopen does NOT revive it.
 */

import {
  and,
  eq,
  focusSessions,
  links,
  hasRolePermission,
  inArray,
  projectTracks,
  workspaces,
  type getDb,
  type PermissionType,
} from "@synap/database";
import { readTrackStage, deriveTrackStages } from "@synap-core/types/units";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import {
  resolveStageDomainWorkspace,
  workspacePackageSlug,
} from "./stage-domain.js";
import { TRACK_SPACE_GRANT_KEY } from "./track-start-summary.js";
import { listWorkspacesUsedByProjects } from "../../utils/project-workspace.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { TRPCError } from "@trpc/server";

type Db = Awaited<ReturnType<typeof getDb>>;

/** The key on `project_tracks.metadata` (declared in the leaf). */
export { TRACK_SPACE_GRANT_KEY };

/** The role the grant stands in for — what an approved join would have given. */
const GRANT_ROLE = "editor" as const;

/**
 * The track statuses under which the grant can admit anything (W5): ACTIVE
 * only. A paused track's agents stop at the join gate until it resumes.
 */
const GRANT_LIVE_STATUSES = ["active"] as const;

export interface TrackSpaceGrant {
  /** The person the admitted agents act for (the gate's `userId`). */
  operatorUserId: string;
  /** The agents admitted; `null` ⇒ any agent acting for `operatorUserId`. */
  agentUserIds: string[] | null;
  /** The spaces admitted — never widened after birth. */
  workspaceIds: string[];
  /** Who consented: the approver, or the person who started it. */
  grantedBy: string;
  /** ISO-8601. */
  grantedAt: string;
  /** The approved `track/create` proposal, when the start was proposed. */
  proposalId?: string;
  /** ISO-8601 — set when the track completed or was archived. */
  endedAt?: string;
  endedReason?: "completed" | "archived";
}

/** A granted space, as a proposal lists it for the person to read. */
export interface TrackStepSpace {
  workspaceId: string;
  name: string;
  /** The stage domain that named it; `null` for a project-linked space. */
  domain: string | null;
}

/** Parse the stored grant; anything malformed reads as "no grant". */
export function readTrackSpaceGrant(metadata: unknown): TrackSpaceGrant | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[TRACK_SPACE_GRANT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.operatorUserId !== "string" || !g.operatorUserId) return null;
  if (!Array.isArray(g.workspaceIds)) return null;
  const agents =
    g.agentUserIds === null
      ? null
      : Array.isArray(g.agentUserIds)
        ? g.agentUserIds.filter((a): a is string => typeof a === "string")
        : undefined;
  if (agents === undefined) return null;
  return {
    operatorUserId: g.operatorUserId,
    agentUserIds: agents,
    workspaceIds: g.workspaceIds.filter(
      (w): w is string => typeof w === "string"
    ),
    grantedBy: typeof g.grantedBy === "string" ? g.grantedBy : "",
    grantedAt: typeof g.grantedAt === "string" ? g.grantedAt : "",
    ...(typeof g.proposalId === "string" ? { proposalId: g.proposalId } : {}),
    ...(typeof g.endedAt === "string" ? { endedAt: g.endedAt } : {}),
    ...(g.endedReason === "completed" || g.endedReason === "archived"
      ? { endedReason: g.endedReason }
      : {}),
  };
}

/**
 * The spaces a track's grant names FOR `userId` (W5): the spaces its project
 * links (`uses`) that `userId` can write, then — legacy staged tracks — the
 * spaces its stages' domains resolve to (the same resolver `startStageSession`
 * places each stage session with). Deduped, project spaces first. A domain
 * with no usable workspace contributes nothing (its sessions fall back to the
 * project's home, which needs no grant).
 */
export async function resolveTrackGrantSpaces(
  db: Db,
  args: { stages: unknown; projectId: string; userId: string }
): Promise<TrackStepSpace[]> {
  const picked: Array<{ workspaceId: string; domain: string | null }> = [];
  const linked =
    (await listWorkspacesUsedByProjects(db, [args.projectId], args.userId)).get(
      args.projectId
    ) ?? [];
  for (const workspaceId of linked) {
    try {
      await assertWorkspaceWrite(db, args.userId, { workspaceId });
    } catch (err) {
      // FORBIDDEN is the answer "not writable" — the one thing this probe
      // asks. Anything else is a FAILED read, never folded into "no access".
      if (!(err instanceof TRPCError && err.code === "FORBIDDEN")) throw err;
      continue;
    }
    if (!picked.some((p) => p.workspaceId === workspaceId)) {
      picked.push({ workspaceId, domain: null });
    }
  }
  const domains: string[] = [];
  for (const { domain } of deriveTrackStages(args.stages, null)) {
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  for (const slug of domains) {
    const r = await resolveStageDomainWorkspace(db, {
      slug,
      projectId: args.projectId,
      userId: args.userId,
    });
    if (r.resolved && !picked.some((p) => p.workspaceId === r.workspaceId)) {
      picked.push({ workspaceId: r.workspaceId, domain: slug });
    }
  }
  if (picked.length === 0) return [];
  const rows = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      inArray(
        workspaces.id,
        picked.map((p) => p.workspaceId)
      )
    );
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return picked.map((p) => ({
    ...p,
    name: names.get(p.workspaceId) ?? p.domain ?? "a space",
  }));
}

/** Read the spaces a `track/create` proposal listed (its consent). */
export function readListedStepSpaces(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const grant = (data as Record<string, unknown>)[TRACK_SPACE_GRANT_KEY];
  if (!grant || typeof grant !== "object") return [];
  const spaces = (grant as Record<string, unknown>).spaces;
  if (!Array.isArray(spaces)) return [];
  return spaces
    .map((s) =>
      s && typeof s === "object"
        ? (s as Record<string, unknown>).workspaceId
        : null
    )
    .filter((w): w is string => typeof w === "string");
}

/** The grant as it stands once the track completes or is archived. */
export function endTrackSpaceGrant(
  metadata: unknown,
  reason: "completed" | "archived",
  at: Date = new Date()
): Record<string, unknown> | undefined {
  const grant = readTrackSpaceGrant(metadata);
  if (!grant || grant.endedAt) return undefined;
  return {
    [TRACK_SPACE_GRANT_KEY]: {
      ...grant,
      endedAt: at.toISOString(),
      endedReason: reason,
    },
  };
}

/**
 * The join gate's one question: does a LIVE track grant admit this agent write
 * into `workspaceId`, which the agent is not a member of? Read-only; every
 * miss returns `false` and the caller files the join proposal as before.
 */
export async function admittedByTrackSpaceGrant(
  db: Db,
  input: {
    userId: string;
    agentUserId: string;
    workspaceId: string;
    requiredPermission: PermissionType;
    subjectType: string;
    action: string;
    data?: Record<string, unknown>;
    sessionId?: string | null;
  }
): Promise<boolean> {
  const { userId, agentUserId, workspaceId } = input;
  // The grant stands in for an editor join — never more.
  if (!hasRolePermission(GRANT_ROLE, input.requiredPermission)) return false;

  // Which track (and step, when it has one) does this write belong to?
  let trackId: string | null = null;
  let stageKey: string | null = null;
  if (
    input.subjectType === "focus_session" &&
    input.action === "create" &&
    typeof input.data?.trackId === "string"
  ) {
    // (a) a session of the track, being started in this space.
    trackId = input.data.trackId;
    stageKey =
      typeof input.data.trackStage === "string" ? input.data.trackStage : null;
  } else if (input.sessionId) {
    // (b) a write made from a session filed into a track, in THIS space.
    const [session] = await db
      .select({
        trackId: focusSessions.trackId,
        trackStage: focusSessions.trackStage,
        workspaceId: focusSessions.workspaceId,
        status: focusSessions.status,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, input.sessionId))
      .limit(1);
    if (
      !session?.trackId ||
      session.workspaceId !== workspaceId ||
      !(OPEN_SESSION_STATUSES as readonly string[]).includes(session.status)
    ) {
      return false;
    }
    trackId = session.trackId;
    stageKey = session.trackStage ?? null;
  }
  if (!trackId) return false;

  const [track] = await db
    .select({
      projectId: projectTracks.projectId,
      status: projectTracks.status,
      metadata: projectTracks.metadata,
      definitionSnapshot: projectTracks.definitionSnapshot,
    })
    .from(projectTracks)
    .where(
      and(
        eq(projectTracks.id, trackId),
        inArray(projectTracks.status, [...GRANT_LIVE_STATUSES])
      )
    )
    .limit(1);
  if (!track) return false;

  const grant = readTrackSpaceGrant(track.metadata);
  if (!grant || grant.endedAt) return false;
  if (grant.operatorUserId !== userId) return false;
  if (grant.agentUserIds !== null && !grant.agentUserIds.includes(agentUserId))
    return false;
  if (!grant.workspaceIds.includes(workspaceId)) return false;

  // The space still belongs to the track: the project links it NOW (W5)…
  if (await projectLinksWorkspace(db, track.projectId, workspaceId)) {
    return true;
  }
  // …or (legacy staged track) the STEP names it: its domain is this
  // workspace's template.
  if (!stageKey) return false;
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);
  if (!stage?.domain) return false;
  return (await workspacePackageSlug(db, workspaceId)) === stage.domain;
}

/**
 * Does `project --uses--> workspace` exist right now? The INDEX edge itself,
 * unfloored (the grant already floored the space on the operator's write
 * access at consent time) — an unlink stops admission on the next write.
 */
async function projectLinksWorkspace(
  db: Db,
  projectId: string,
  workspaceId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, "project"),
        eq(links.fromId, projectId),
        eq(links.toType, "workspace"),
        eq(links.toId, workspaceId),
        eq(links.linkType, "uses")
      )
    )
    .limit(1);
  return !!row;
}
