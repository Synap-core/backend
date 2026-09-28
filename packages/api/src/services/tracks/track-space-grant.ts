/**
 * TRACK SPACE GRANT — founder decision 2a (2026-09-28).
 *
 * Starting a track admits the agent working it into the track's STEP SPACES
 * (the workspaces its stages' `domain`s resolve to), SCOPED to that track. It
 * exists so an agent working one track across Strategy, Finance and Research
 * is not stopped by a separate workspace-JOIN approval in every one of them.
 *
 * ── WHAT IT IS (and what it is deliberately NOT) ────────────────────────────
 * NOT a `workspace_members` row. A membership is honoured by every reader and
 * writer in the pod and outlives the track — exactly the blanket access the
 * decision rules out. The grant is instead a CONSENT RECORD on the track row
 * (`project_tracks.metadata.spaceGrant`), consulted at ONE place: the join
 * gate's membership-miss branch (`checkPermissionOrPropose`). There it admits
 * a write only when that write belongs to the track:
 *   (a) the stage session's own `focus_session/create`, carrying `trackId` +
 *       `trackStage`; or
 *   (b) a write made from a session (ambient `sessionId`) that is filed into
 *       the track, still open, and sits in THIS workspace;
 * and in both cases the step it belongs to names THIS workspace (its `domain`
 * equals the workspace's template slug), the workspace is one the grant lists,
 * the acting agent is one the grant names, and the track is live.
 * Admission only skips the JOIN — the normal governance ladder still runs.
 *
 * ── CONSENT ─────────────────────────────────────────────────────────────────
 *   - an agent's start, PROPOSED: the approval is the consent. The proposal's
 *     summary names the agent and the spaces; at approval the granted set is
 *     the step spaces re-resolved NOW ∩ the spaces the proposal LISTED (what the
 *     person read — a revised payload can never widen it).
 *   - an agent's start, auto-approved: the person's own governance rule let it
 *     through; the grant names that agent and the resolved spaces.
 *   - a person's own start: the person is the consent. No agent is known yet,
 *     so the grant admits any agent acting FOR that person (`agentUserIds:
 *     null`), still only through this track's sessions. A named default — the
 *     narrower alternative is "no agent until one is named".
 *
 * ── END ─────────────────────────────────────────────────────────────────────
 * Completing or archiving the track stamps `endedAt` (`applyTrackStatus`), so a
 * later reopen does NOT revive it; the gate also refuses any track that is not
 * active/paused, belt and braces.
 */

import {
  and,
  eq,
  focusSessions,
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

type Db = Awaited<ReturnType<typeof getDb>>;

/** The key on `project_tracks.metadata` (declared in the leaf). */
export { TRACK_SPACE_GRANT_KEY };

/** The role the grant stands in for — what an approved join would have given. */
const GRANT_ROLE = "editor" as const;

/** The track statuses under which the grant can admit anything. */
const LIVE_TRACK_STATUSES = ["active", "paused"] as const;

export interface TrackSpaceGrant {
  /** The person the admitted agents act for (the gate's `userId`). */
  operatorUserId: string;
  /** The agents admitted; `null` ⇒ any agent acting for `operatorUserId`. */
  agentUserIds: string[] | null;
  /** The step spaces admitted — never widened after birth. */
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

/** A step space, as a proposal lists it for the person to read. */
export interface TrackStepSpace {
  workspaceId: string;
  name: string;
  domain: string;
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
 * The step spaces a method's stages resolve to FOR `userId` — the same
 * resolver `startStageSession` places each stage session with, so the grant
 * names exactly the spaces the sessions will be started in. A domain with no
 * usable workspace contributes nothing (its sessions fall back to the
 * project's home, which needs no grant).
 */
export async function resolveTrackStepSpaces(
  db: Db,
  args: { stages: unknown; projectId: string; userId: string }
): Promise<TrackStepSpace[]> {
  const domains: string[] = [];
  for (const { domain } of deriveTrackStages(args.stages, null)) {
    if (domain && !domains.includes(domain)) domains.push(domain);
  }
  const picked: Array<{ workspaceId: string; domain: string }> = [];
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
    name: names.get(p.workspaceId) ?? p.domain,
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

  // Which track (and step) does this write belong to?
  let trackId: string | null = null;
  let stageKey: string | null = null;
  if (
    input.subjectType === "focus_session" &&
    input.action === "create" &&
    typeof input.data?.trackId === "string" &&
    typeof input.data?.trackStage === "string"
  ) {
    // (a) the stage session itself, being started in this space.
    trackId = input.data.trackId;
    stageKey = input.data.trackStage;
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
      !session.trackStage ||
      session.workspaceId !== workspaceId ||
      !(OPEN_SESSION_STATUSES as readonly string[]).includes(session.status)
    ) {
      return false;
    }
    trackId = session.trackId;
    stageKey = session.trackStage;
  }
  if (!trackId || !stageKey) return false;

  const [track] = await db
    .select({
      status: projectTracks.status,
      metadata: projectTracks.metadata,
      definitionSnapshot: projectTracks.definitionSnapshot,
    })
    .from(projectTracks)
    .where(
      and(
        eq(projectTracks.id, trackId),
        inArray(projectTracks.status, [...LIVE_TRACK_STATUSES])
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

  // The STEP names this space: its domain is this workspace's template.
  const stage = readTrackStage(track.definitionSnapshot?.stages, stageKey);
  if (!stage?.domain) return false;
  return (await workspacePackageSlug(db, workspaceId)) === stage.domain;
}
