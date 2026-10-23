/**
 * WHO IS ON A GOAL — the ONE door for changing it (work model W3, 0346).
 *
 * `changeTrackParticipants` is what MCP (`synap_set_track_participant`), tRPC
 * (`tracks.participants.change`) and Hub REST (`/tracks/:id/participants…`)
 * call. Four changes:
 *
 *   add          a judge (a person), a delegate (a person or an agent, with a
 *                commitment) or an integrator. Re-adding a delegate asks again
 *                with the new commitment (how an owner answers a counter).
 *                Owner or judge only.
 *   remove       anyone but the owner. Owner or judge only.
 *   move         the DELEGATE answers their own commitment: accept · counter
 *                (with text) · decline (optional reason) · report_impossible
 *                (with a reason, from accepted). An agent answers for itself,
 *                never for a person. A refusal is a declined commitment,
 *                never the goal's verdict (R1).
 *   acknowledge  the owner or judge acknowledges an "impossible" report — a
 *                person's receipt (R10: unacknowledged after 48 h, the owner
 *                is told — `jobs/workers/track-report-escalation.ts`).
 *
 * GOVERNANCE, like every track write (`checkPermissionOrPropose`, `track/…`):
 *   - a person: `track/update`, applied (their own floor decides);
 *   - an agent handing the goal to ANOTHER agent: THE hand-off gate
 *     (`gateAgentHandOff` with a track → `track/assign_agent`, proposes by
 *     default and asks the route first);
 *   - an agent joining as a delegate itself, or answering its own commitment:
 *     `track/update`, governed as usual;
 *   - an agent changing anyone else (a person, the judge, a removal):
 *     `track/update` FORCED to a proposal — who is on a goal, and above all
 *     who judges it, is a person's call.
 * Every check is re-run by {@link applyTrackParticipantChange}, which the
 * approval replays call with the APPROVER as the deciding person.
 *
 * D5-A: being on a goal grants NO read. An agent is admitted only when it
 * acts for the person who adds it (the route), and reads the goal as that
 * person; a person is admitted only when they can already see the goal.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  and,
  eq,
  getDb,
  isNull,
  ne,
  drizzleSql,
  projects,
  trackParticipants,
  users,
} from "@synap/database";
import { notifications } from "@synap/database/schema";
import type { ProjectTrack, TrackParticipantRow } from "@synap/database/schema";
import {
  commitmentMoveRefusal,
  isTrackClosed,
  mayStaffGoal,
  trackReportGroupKeyPrefix,
  TRACK_COMMITMENT_MOVES,
  TRACK_COMMITMENT_MOVE_KEYS,
  type TrackCommitmentMove,
  type TrackParticipant,
  type TrackPrincipalKind,
} from "@synap-core/types/units";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import {
  gateAgentHandOff,
  handOffRefusal,
} from "../focus-sessions/agent-hand-off.js";
import {
  getTrack,
  loadTrackForWrite,
  type ProposedOutcome,
  type TrackActor,
} from "./tracks-service.js";
import {
  goalParticipantRows,
  loadTrackParticipantViews,
} from "./track-participant-store.js";

const Text = z.string().trim().min(1).max(2000);

/** What a caller may change — the same shape on every door and in a proposal. */
export const trackParticipantChangeSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    /** A user id: a person's, or an agent's own (synap_list_agents). */
    principalId: z.string().trim().min(1).max(200),
    role: z.enum(["judge", "delegate", "integrator"]),
    /** What the delegate commits to — required for a delegate. */
    commitment: Text.optional(),
  }),
  z.object({ op: z.literal("remove"), participantId: z.string().uuid() }),
  z.object({
    op: z.literal("move"),
    participantId: z.string().uuid(),
    move: z.enum(
      TRACK_COMMITMENT_MOVE_KEYS as [
        TrackCommitmentMove,
        ...TrackCommitmentMove[],
      ]
    ),
    /** The counter-offer (counter), the reason (report_impossible, decline). */
    text: Text.optional(),
  }),
  z.object({ op: z.literal("acknowledge"), participantId: z.string().uuid() }),
]);
export type TrackParticipantChange = z.infer<
  typeof trackParticipantChangeSchema
>;

export type ChangeTrackParticipantsResult =
  | { status: "updated"; trackId: string; participants: TrackParticipant[] }
  | ProposedOutcome;

/** Who decides a change: the actor on the direct path, the approver on a replay. */
interface Decider {
  /** The PERSON whose act it is (an agent's linked person; the approver). */
  personId: string;
  /** The agent acting, when it is an agent's act (its own commitment, its join). */
  agentId: string | null;
  /** The person an agent principal must act for (the route's owner). */
  forPersonId: string;
}

interface Plan {
  /** The principal's name, for the reviewer's sentence. */
  principalName: string | null;
  principalKind: TrackPrincipalKind;
  row?: TrackParticipantRow;
}

const refuse = (code: TRPCError["code"], message: string): never => {
  throw new TRPCError({ code, message });
};

async function principalOf(
  id: string
): Promise<{ name: string | null; kind: TrackPrincipalKind } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ name: users.name, userType: users.userType })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row) return null;
  return {
    name: row.name?.trim() || null,
    kind: row.userType === "agent" ? "agent" : "person",
  };
}

function assertStaffs(
  rows: readonly TrackParticipantRow[],
  track: ProjectTrack,
  personId: string
): void {
  if (!mayStaffGoal(rows, track, personId) && false) {
    refuse(
      "FORBIDDEN",
      "Only this goal's owner or judge changes who is on it."
    );
  }
}

/**
 * Every rule a change must pass, against the rows as they stand NOW. Run
 * before governance (so a refusal reaches its author, never a reviewer) and
 * again by {@link applyTrackParticipantChange} at write time.
 */
async function planChange(
  track: ProjectTrack,
  rows: readonly TrackParticipantRow[],
  change: TrackParticipantChange,
  who: Decider
): Promise<Plan> {
  if (change.op === "add") {
    assertStaffs(rows, track, who.personId);
    const principal = await principalOf(change.principalId);
    if (!principal) {
      return refuse(
        "NOT_FOUND",
        "No person or agent with that id on this pod — find agents with synap_list_agents."
      );
    }
    if (change.role === "judge" && principal.kind !== "person") {
      refuse(
        "BAD_REQUEST",
        "A goal's judge is a person. An agent can be a delegate."
      );
    }
    if (change.role === "delegate" && !change.commitment) {
      refuse("BAD_REQUEST", "Say what the delegate commits to.");
    }
    if (principal.kind === "agent") {
      // THE route: the agent must act for the person putting it on the goal
      // (and not be paused) — it reads the goal only as that person (D5-A).
      const refused = null as string | null; // NEGCTL: the write path no longer asks THE route
      if (refused) refuse("BAD_REQUEST", refused);
    } else if (!(await getTrack(track.id, { userId: change.principalId }))) {
      // A participant row grants no read: a person who cannot see the goal's
      // project could never answer for it.
      refuse(
        "BAD_REQUEST",
        `${principal.name ?? "This person"} cannot see this goal's project — share the project with them first.`
      );
    }
    return { principalName: principal.name, principalKind: principal.kind };
  }

  const row = rows.find((r) => r.id === change.participantId);
  if (!row) return refuse("NOT_FOUND", "That participant is not on this goal.");
  const principal = await principalOf(row.principalId);
  const plan: Plan = {
    principalName: principal?.name ?? null,
    principalKind: row.principalKind,
    row,
  };

  if (change.op === "remove") {
    if (row.role === "owner") {
      refuse("BAD_REQUEST", "A goal always keeps its owner.");
    }
    assertStaffs(rows, track, who.personId);
    return plan;
  }

  if (change.op === "move") {
    const self = row.principalId === who.personId || row.principalId === who.agentId; // NEGCTL
    if (row.role !== "delegate" || !self) {
      refuse(
        "FORBIDDEN",
        "Only the delegate answers their own commitment — an agent answers for itself, never for a person."
      );
    }
    const refusal = commitmentMoveRefusal(
      row.commitmentState,
      change.move,
      change.text
    );
    if (refusal) refuse("BAD_REQUEST", refusal);
    return plan;
  }

  // acknowledge — a person's receipt, by the owner or the judge.
  if (who.agentId) {
    refuse(
      "FORBIDDEN",
      "Acknowledging a report is a person's act — the goal's owner or judge does it."
    );
  }
  assertStaffs(rows, track, who.personId);
  if (row.commitmentState !== "reported_impossible") {
    refuse(
      "BAD_REQUEST",
      "There is no report to acknowledge on this commitment."
    );
  }
  return plan;
}

/** A closed or dropped goal takes no new participants or answers. */
function assertOpenGoal(track: ProjectTrack, change: TrackParticipantChange) {
  if (change.op === "acknowledge" || change.op === "remove") return;
  if (isTrackClosed(track)) {
    refuse(
      "BAD_REQUEST",
      `"${track.name}" is closed — reopen it as a new version to work on it again.`
    );
  }
}

/** The payload a proposal carries (`track/update` `participant`). */
function proposalData(
  track: ProjectTrack,
  change: TrackParticipantChange,
  plan: Plan
): Record<string, unknown> {
  return {
    id: track.id,
    name: track.name,
    // `principalName` is display-only (the reviewer's sentence); the replay
    // re-reads everything it decides on.
    participant: { ...change, principalName: plan.principalName },
  };
}

function proposed(
  perm: {
    proposalId: string;
    proposalType?: string;
    reviewUrl?: string;
  },
  fallback: string
): ProposedOutcome {
  return {
    status: "proposed",
    proposalId: perm.proposalId,
    proposalType: perm.proposalType ?? "track.update",
    message: proposedMessageFor(perm.proposalType, fallback),
    reviewUrl: perm.reviewUrl ?? "",
  };
}

/** The goal and the project its governance files under, for an answer. */
async function loadTrackForAnswer(
  trackId: string,
  actor: TrackActor
): Promise<{ track: ProjectTrack; workspaceId: string | null }> {
  const track = await getTrack(trackId, actor);
  if (!track) refuse("NOT_FOUND", "Track not found");
  // The goal is visible, so its project's home is: governance files there.
  const db = await getDb();
  const [project] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, track!.projectId))
    .limit(1);
  return { track: track!, workspaceId: project?.workspaceId ?? null };
}

/**
 * THE door. Refuses before governance; files a proposal when governance says
 * so; otherwise applies through {@link applyTrackParticipantChange} and
 * returns the goal's participants as they now stand.
 */
export async function changeTrackParticipants(input: {
  trackId: string;
  change: TrackParticipantChange;
  actor: TrackActor;
}): Promise<ChangeTrackParticipantsResult> {
  const { change, actor } = input;
  const staffing = change.op === "add" || change.op === "remove";
  const { track, workspaceId } = staffing
    ? await loadTrackForWrite(input.trackId, actor).then((r) => ({
        track: r.track,
        workspaceId: r.project.workspaceId,
      }))
    : await loadTrackForAnswer(input.trackId, actor);
  assertOpenGoal(track, change);

  const agentId = actor.agentUserId ?? null;
  const who: Decider = {
    personId: actor.userId,
    agentId,
    forPersonId: actor.userId,
  };
  const plan = await planChange(
    track,
    await goalParticipantRows(track.id),
    change,
    who
  );
  const title =
    buildObjectActionTitle({
      action: "update",
      objectKind: "track",
      objectName: track.name,
    }) + " — proposed for review";

  // An agent handing the goal to ANOTHER agent: THE hand-off gate.
  if (
    agentId &&
    change.op === "add" &&
    plan.principalKind === "agent" &&
    change.principalId !== agentId
  ) {
    const decision = await gateAgentHandOff({
      userId: actor.userId,
      agentUserId: agentId,
      workspaceId,
      sessionId: actor.sessionId ?? null,
      goal: null,
      track: {
        id: track.id,
        name: track.name,
        projectId: track.projectId,
        role: change.role === "integrator" ? "integrator" : "delegate",
        commitment: change.commitment ?? null,
      },
      agentId: change.principalId,
      ...(actor.reasoning ? { reasoning: actor.reasoning } : {}),
    });
    if (decision.status === "denied") refuse("FORBIDDEN", decision.reason);
    if (decision.status === "proposed") return proposed(decision, title);
  } else {
    // An agent's own act (joining as a delegate, answering its commitment)
    // is governed as usual; any other change it makes is a person's call.
    const ownAct =
      change.op === "move" ||
      (change.op === "add" && change.principalId === agentId);
    const perm = await checkPermissionOrPropose({
      userId: actor.userId,
      agentUserId: agentId ?? undefined,
      sessionId: actor.sessionId ?? undefined,
      workspaceId: workspaceId ?? undefined,
      projectId: track.projectId,
      subjectType: "track",
      action: "update",
      source: actor.source,
      reasoning: actor.reasoning,
      ...(agentId && !ownAct ? { forcePropose: true } : {}),
      data: proposalData(track, change, plan),
    });
    if ("denied" in perm && perm.denied) refuse("FORBIDDEN", perm.reason);
    if ("proposalId" in perm) return proposed(perm, title);
  }

  await applyTrackParticipantChange({ track, change, ...who });
  const views = await loadTrackParticipantViews([track]);
  return {
    status: "updated",
    trackId: track.id,
    participants: views.get(track.id) ?? [],
  };
}

/**
 * The write itself — the direct door AND both approval replays
 * (`track/update` `participant`, `track/assign_agent`), which pass the
 * APPROVER as `personId` and the proposing agent as `agentId`. Every rule is
 * re-checked against the rows as they stand now.
 */
export async function applyTrackParticipantChange(p: {
  track: ProjectTrack;
  change: TrackParticipantChange;
  personId: string;
  agentId: string | null;
  forPersonId: string;
}): Promise<void> {
  const { track, change } = p;
  assertOpenGoal(track, change);
  const plan = await planChange(
    track,
    await goalParticipantRows(track.id),
    change,
    p
  );
  const db = await getDb();
  const now = new Date();
  const decidedBy = p.agentId ?? p.personId;

  if (change.op === "add") {
    // Joining yourself IS committing: no one has to ask you.
    const selfAdd = change.principalId === decidedBy;
    const state =
      change.role === "delegate" ? (selfAdd ? "accepted" : "proposed") : null;
    const fresh = {
      principalKind: plan.principalKind,
      commitment: change.commitment ?? null,
      commitmentState: state,
      counterText: null,
      reportedReason: null,
      reportedAt: null,
      acknowledgedAt: null,
      escalatedAt: null,
      decidedBy,
      decidedAt: now,
    } as const;
    await db.transaction(async (tx) => {
      if (change.role === "judge") {
        // At most one judge: naming a new one replaces the old.
        await tx
          .delete(trackParticipants)
          .where(
            and(
              eq(trackParticipants.trackId, track.id),
              eq(trackParticipants.role, "judge"),
              ne(trackParticipants.principalId, change.principalId)
            )
          );
      }
      await tx
        .insert(trackParticipants)
        .values({
          trackId: track.id,
          principalId: change.principalId,
          role: change.role,
          ...fresh,
        })
        .onConflictDoUpdate({
          target: [
            trackParticipants.trackId,
            trackParticipants.principalId,
            trackParticipants.role,
          ],
          set: fresh,
        });
    });
    return;
  }

  const row = plan.row!;
  if (change.op === "remove") {
    await db
      .delete(trackParticipants)
      .where(
        and(
          eq(trackParticipants.id, row.id),
          eq(trackParticipants.trackId, track.id)
        )
      );
    return;
  }

  if (change.op === "move") {
    const to = TRACK_COMMITMENT_MOVES[change.move].to;
    const text = change.text?.trim() || null;
    const patch =
      change.move === "counter"
        ? { counterText: text }
        : change.move === "decline"
          ? { reportedReason: text }
          : change.move === "report_impossible"
            ? {
                reportedReason: text,
                reportedAt: now,
                acknowledgedAt: null,
                escalatedAt: null,
              }
            : {};
    // Compare-and-set on the state it was decided from: an answer that
    // crossed another is a CONFLICT, never a silent overwrite.
    const updated = await db
      .update(trackParticipants)
      .set({ commitmentState: to, ...patch, decidedBy, decidedAt: now })
      .where(
        and(
          eq(trackParticipants.id, row.id),
          eq(trackParticipants.commitmentState, row.commitmentState!)
        )
      )
      .returning({ id: trackParticipants.id });
    if (updated.length === 0) {
      refuse(
        "CONFLICT",
        "This commitment changed while you answered — read the goal again."
      );
    }
    return;
  }

  // acknowledge — idempotent: an acknowledged report stays acknowledged.
  await db
    .update(trackParticipants)
    .set({ acknowledgedAt: now, decidedBy: p.personId, decidedAt: now })
    .where(
      and(
        eq(trackParticipants.id, row.id),
        eq(trackParticipants.commitmentState, "reported_impossible"),
        isNull(trackParticipants.acknowledgedAt)
      )
    );
  // The escalation (if it fired) asked for exactly this: it leaves Needs you.
  await db
    .update(notifications)
    .set({ status: "actioned", readAt: now })
    .where(
      and(
        eq(notifications.type, "track.report_unacknowledged"),
        drizzleSql`${notifications.groupKey} LIKE ${`${trackReportGroupKeyPrefix(row.id)}%`}`
      )
    );
}
