/**
 * WHO IS ON A GOAL — the reads and the authority rules (work model W3, 0346).
 *
 *   loadTrackParticipantViews — the participants every track READ returns
 *                               (`TrackView.participants`), with "silent since"
 *                               for delegates who still owe something.
 *   loadGoalJudge             — THE judge of a goal (`goalJudge`,
 *                               @synap-core/types/units): the judge row, else
 *                               the owner. Every authority check reads it.
 *   assertGoalCloser          — only the judge applies a move into done. Called
 *                               by `applyTrackStatus` — the one status write
 *                               both `setTrackStatus` and the `track/update`
 *                               approval replay run (a replay acts as the
 *                               APPROVER, so the approver must be the judge).
 *   seedGoalOwner             — the owner row a new goal is born with.
 *
 * Kept apart from the doors (`track-participants.ts`) so `tracks-service.ts`
 * can import it without a cycle. A participant row grants NO read (D5-A): the
 * views are read only for goals the caller already read through the access
 * layer.
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  eq,
  getDb,
  inArray,
  isNotNull,
  focusSessions,
  trackParticipants,
  users,
} from "@synap/database";
import type {
  ProjectTrack,
  TrackCommitmentStateKey,
  TrackParticipantRoleKey,
  TrackParticipantRow,
  TrackPrincipalKindKey,
} from "@synap/database/schema";
import {
  goalJudge,
  isOpenCommitment,
  trackStatusCategory,
  type TrackCommitmentState,
  type TrackParticipant,
  type TrackParticipantRole,
  type TrackPrincipalKind,
} from "@synap-core/types/units";

// The DB mirror (`@synap/database`) and the shared sets
// (`@synap-core/types/units`) name EXACTLY the same values: a role, kind or
// state added on one side only stops the build.
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _sameRoles: _Same<TrackParticipantRoleKey, TrackParticipantRole> = true;
const _sameKinds: _Same<TrackPrincipalKindKey, TrackPrincipalKind> = true;
const _sameStates: _Same<TrackCommitmentStateKey, TrackCommitmentState> = true;
void _sameRoles;
void _sameKinds;
void _sameStates;

/** The stored rows of ONE goal — read only AFTER the goal's own floor passed. */
export async function goalParticipantRows(
  trackId: string
): Promise<TrackParticipantRow[]> {
  const db = await getDb();
  return db
    .select()
    .from(trackParticipants)
    .where(eq(trackParticipants.trackId, trackId));
}

/** THE judge of `track` — its judge row, else its owner. */
export async function loadGoalJudge(
  track: Pick<ProjectTrack, "id" | "userId">
): Promise<string> {
  return goalJudge(await goalParticipantRows(track.id), track);
}

/** A person's display name, for a sentence — `null` when they have none. */
export async function personName(userId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.name?.trim() || null;
}

/**
 * Only the goal's JUDGE applies a move into done (a close). `deciderUserId`
 * is the person whose act it is: the actor on the direct path, the APPROVER on
 * an approval replay. A drop (lost) and every other move keep W1's rule (a
 * person with write access). An agent's close never reaches here unreviewed:
 * it is a proposal (`lifecycleMove` humanOnly), and its approval is checked
 * here against the approver.
 */
export async function assertGoalCloser(
  track: Pick<ProjectTrack, "id" | "userId" | "name">,
  to: string,
  deciderUserId: string
): Promise<void> {
  if (trackStatusCategory(to) !== "done") return;
  const judge = await loadGoalJudge(track);
  if (judge === deciderUserId) return;
  const who = (await personName(judge)) ?? "Its judge";
  throw new TRPCError({
    code: "FORBIDDEN",
    message: `Only this goal's judge can close it. ${who} judges "${track.name}" — ask them to close it, or to approve the close.`,
  });
}

/**
 * The PERSON who owns a goal started by `starterId`: the starter, unless the
 * starter is an AGENT (a pod-wide agent key started it) — then the person the
 * agent belongs to, else the project's owner. The same rule 0346's backfill
 * applies to existing goals.
 */
export async function resolveGoalOwnerPerson(
  starterId: string,
  projectOwnerId: string
): Promise<string> {
  const db = await getDb();
  const [starter] = await db
    .select({ userType: users.userType, createdBy: users.createdByUserId })
    .from(users)
    .where(eq(users.id, starterId))
    .limit(1);
  if (starter?.userType !== "agent") return starterId;
  if (starter.createdBy) {
    const [creator] = await db
      .select({ userType: users.userType })
      .from(users)
      .where(eq(users.id, starter.createdBy))
      .limit(1);
    if (creator?.userType === "human") return starter.createdBy;
  }
  return projectOwnerId;
}

/**
 * The owner row a NEW goal is born with (`startTrack`, on creation only).
 * Idempotent: a goal that already has its owner keeps it.
 */
export async function seedGoalOwner(
  track: Pick<ProjectTrack, "id" | "userId">,
  projectOwnerId: string
): Promise<void> {
  const owner = await resolveGoalOwnerPerson(track.userId, projectOwnerId);
  const db = await getDb();
  await db
    .insert(trackParticipants)
    .values({
      trackId: track.id,
      principalKind: "person",
      principalId: owner,
      role: "owner",
      decidedBy: owner,
    })
    .onConflictDoNothing();
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

/** One stored row as every read returns it (`silentSince` filled by the caller). */
export function toTrackParticipant(
  row: TrackParticipantRow,
  silentSince: string | null = null
): TrackParticipant {
  return {
    id: row.id,
    principalKind: row.principalKind,
    principalId: row.principalId,
    role: row.role,
    commitment: row.commitment ?? null,
    commitmentState: row.commitmentState ?? null,
    counterText: row.counterText ?? null,
    reportedReason: row.reportedReason ?? null,
    reportedAt: iso(row.reportedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt)!,
    createdAt: iso(row.createdAt)!,
    silentSince,
  };
}

const ROLE_ORDER: Record<TrackParticipantRole, number> = {
  owner: 0,
  judge: 1,
  delegate: 2,
  integrator: 3,
};

/**
 * "Silent since" for a delegate who still OWES the goal something (an open
 * commitment): the latest of — when they were added, their own last answer on
 * the commitment, and the last change of a session of this goal they work in
 * (a person: a session they own; an agent: a session whose roster names it).
 * A session's `updated_at` moves on anyone's touch, so it reads "the work they
 * are on moved", not a proof of their own act. `null` for every other row.
 */
export function silentSinceOf(
  row: TrackParticipantRow,
  sessions: ReadonlyArray<{
    userId: string;
    agentIds: string[] | null;
    updatedAt: Date | string;
  }>
): string | null {
  if (row.role !== "delegate" || !isOpenCommitment(row.commitmentState)) {
    return null;
  }
  let last = new Date(row.createdAt).getTime();
  if (row.decidedBy === row.principalId) {
    last = Math.max(last, new Date(row.decidedAt).getTime());
  }
  for (const s of sessions) {
    const theirs =
      row.principalKind === "agent"
        ? (s.agentIds ?? []).includes(row.principalId)
        : s.userId === row.principalId;
    if (theirs) last = Math.max(last, new Date(s.updatedAt).getTime());
  }
  return new Date(last).toISOString();
}

/**
 * The participants of `tracks`, keyed by track id. `tracks` are rows the
 * caller already READ through the access layer (`getTrack` / `listTracks`):
 * a participant is exactly as visible as its goal (the `track_participants`
 * VisibilityRule says the same), so the rows are read by those ids. Every
 * goal has an entry; a goal with no stored rows reads `[]`.
 */
export async function loadTrackParticipantViews(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id">>
): Promise<Map<string, TrackParticipant[]>> {
  const out = new Map<string, TrackParticipant[]>(
    tracks.map((t) => [t.id, []])
  );
  if (tracks.length === 0) return out;
  const ids = tracks.map((t) => t.id);
  const db = await getDb();
  const rows = await db
    .select()
    .from(trackParticipants)
    .where(inArray(trackParticipants.trackId, ids));
  const owing = rows.filter(
    (r) => r.role === "delegate" && isOpenCommitment(r.commitmentState)
  );
  // Only the TIMES of the goal's sessions are read, for "silent since" — never
  // their content, which keeps its own floor (`session-visibility.ts`).
  const sessions =
    owing.length === 0
      ? []
      : await db
          .select({
            trackId: focusSessions.trackId,
            userId: focusSessions.userId,
            agentIds: focusSessions.agentIds,
            updatedAt: focusSessions.updatedAt,
          })
          .from(focusSessions)
          .where(
            and(
              isNotNull(focusSessions.trackId),
              inArray(focusSessions.trackId, [
                ...new Set(owing.map((r) => r.trackId)),
              ])
            )
          );
  for (const row of rows) {
    const list = out.get(row.trackId);
    if (!list) continue;
    list.push(
      toTrackParticipant(
        row,
        silentSinceOf(
          row,
          sessions.filter((s) => s.trackId === row.trackId)
        )
      )
    );
  }
  for (const list of out.values()) {
    list.sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.createdAt.localeCompare(b.createdAt)
    );
  }
  return out;
}
