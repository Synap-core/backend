/**
 * "This waits on that decision / that goal" from the agent doors — the
 * CROSS-KIND `blocked_by` edges the model already holds (`session → entity`,
 * `session → track`, `track → track`; `@synap-core/types/connections`
 * `isDependencyEndpointKind`), which the MCP doors could not write before
 * (pathway research c484c02e, gaps C and D).
 *
 * NO SECOND PRODUCER: every edge goes through THE governed dependency door
 * (`governedDependencyLink` / `governedRemoveDependencyLink`): the endpoint
 * floor (both ends visible, the waiting end writable), the cycle refusal
 * (`closesDependencyCycle`), `checkPermissionOrPropose` `link/create` |
 * `link/delete` and the undo receipt. The session-to-session edge keeps its
 * own door (`session-blocked-by.ts`, owner floor on both sessions).
 *
 * REPORTED PER ID in the shape `blockerLinks` / `blockerRemovals` already use
 * for sessions (`linked` | `proposed` | `failed` with a reason; `removed` |
 * `absent` | `proposed` | `failed`), keyed `blockerEntityId` or
 * `blockerTrackId`. A bad id never fails the call and never vanishes.
 *
 * What it does NOT do: option arms on a decision (founder decision D-P5), or
 * wake a step when its blocker delivers (D-P3).
 */
import { DEPENDENCY_LINK_TYPE } from "@synap-core/types/connections";
import {
  and,
  db,
  eq,
  inArray,
  proposals,
  ProposalStatus,
} from "@synap/database";
import {
  governedDependencyLink,
  governedRemoveDependencyLink,
  type DependencyRefusal,
  type GovernedLinkResult,
} from "./dependency-links.js";

/** The kinds a unit may wait on through these doors (a session has its own). */
export type BlockerKind = "entity" | "track";

/** The waiting unit: a session (start/update session) or a goal (update_track). */
export interface WaitingUnit {
  type: "session" | "track";
  id: string;
}

type BlockerKey =
  | { blockerEntityId: string; blockerTrackId?: never }
  | { blockerTrackId: string; blockerEntityId?: never };

export type UnitBlockerReason =
  "not_found" | "self_blocker" | "cycle" | "denied" | "error";

export type UnitBlockerReport = BlockerKey &
  (
    | { status: "linked"; inserted: number }
    | { status: "proposed"; proposalId: string }
    | { status: "failed"; reason: UnitBlockerReason; message?: string }
  );

export type UnitBlockerRemovalReport = BlockerKey &
  (
    | { status: "removed" | "absent" }
    | { status: "proposed"; proposalId: string }
    | { status: "failed"; reason: UnitBlockerReason; message?: string }
  );

function keyOf(kind: BlockerKind, id: string): BlockerKey {
  return kind === "entity" ? { blockerEntityId: id } : { blockerTrackId: id };
}

/** The door's refusal, in the reasons the session reports already use. */
function reasonOf(r: DependencyRefusal): UnitBlockerReason {
  switch (r.reason) {
    case "self_edge":
      return "self_blocker";
    case "cycle":
      return "cycle";
    case "forbidden":
      return "denied";
    case "not_found":
      return "not_found";
    default:
      return "error";
  }
}

interface UnitBlockerInput {
  from: WaitingUnit;
  kind: BlockerKind;
  ids: readonly string[];
  /** The acting person (the agent's linked user on an agent door). */
  userId: string;
  agentUserId?: string | null;
  /** The work session the write is attributed to. */
  sessionId?: string | null;
  /** Set by an approval replay: the write is already the person's decision. */
  approvedProposalId?: string | null;
  door: string;
}

type Failed = { status: "failed"; reason: UnitBlockerReason; message?: string };

/** A non-applied outcome of the door, in the session reports' words. */
function notApplied(
  r: GovernedLinkResult
): Failed | { status: "proposed"; proposalId: string } {
  if (r.status === "proposed")
    return { status: "proposed", proposalId: r.proposalId };
  if (r.status === "denied")
    return { status: "failed", reason: "denied", message: r.reason };
  if (r.status === "refused")
    return { status: "failed", reason: reasonOf(r), message: r.error };
  return {
    status: "failed",
    reason: "error",
    message: `unexpected outcome ${r.status}`,
  };
}

/** Run the door once per id; a throw is that id's `failed`, never the call's. */
async function perId<R>(
  input: UnitBlockerInput,
  door: typeof governedDependencyLink,
  applied: (r: GovernedLinkResult) => R | null
): Promise<
  Array<BlockerKey & (R | Failed | { status: "proposed"; proposalId: string })>
> {
  const out: Array<
    BlockerKey & (R | Failed | { status: "proposed"; proposalId: string })
  > = [];
  for (const id of [...new Set(input.ids)]) {
    const key = keyOf(input.kind, id);
    try {
      const r = await door({
        edge: {
          fromType: input.from.type,
          fromId: input.from.id,
          toType: input.kind,
          toId: id,
          linkType: DEPENDENCY_LINK_TYPE,
        },
        userId: input.userId,
        agentUserId: input.agentUserId ?? null,
        approvedProposalId: input.approvedProposalId ?? null,
        sessionId: input.sessionId ?? null,
        door: input.door,
      });
      out.push({ ...key, ...(applied(r) ?? notApplied(r)) });
    } catch (err) {
      out.push({
        ...key,
        status: "failed",
        reason: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Add `from --blocked_by--> <kind>:<id>` for each id, governed, per id. */
export async function addUnitBlockers(
  input: UnitBlockerInput
): Promise<UnitBlockerReport[]> {
  const reports = await perId(input, governedDependencyLink, (r) =>
    r.status === "created" || r.status === "exists"
      ? { status: "linked" as const, inserted: r.inserted }
      : null
  );
  return input.kind === "track" && false ? explainPendingGoals(reports) : reports; // NEGCTL
}

/**
 * A goal id that is not a goal YET: `start_track` answered `proposed` with a
 * `pendingTrackId`, and the person has not approved it. The door can only say
 * "not found"; this says why, and what to do (link it once approved), instead
 * of an agent concluding the id is wrong. Read-only: a pending `track/create`
 * proposal filed under that id (the gate files it with `targetId = data.id`).
 */
async function explainPendingGoals(
  reports: UnitBlockerReport[]
): Promise<UnitBlockerReport[]> {
  const missing = reports.flatMap((r) =>
    r.status === "failed" && r.reason === "not_found" && r.blockerTrackId
      ? [r.blockerTrackId]
      : []
  );
  if (missing.length === 0) return reports;
  // The explanation is advisory: a failed read leaves each report exactly as
  // the door gave it (`failed`, `not_found`), never hides it.
  let pending: Array<{ id: string; targetId: string | null }>;
  try {
    pending = await db
      .select({ id: proposals.id, targetId: proposals.targetId })
      .from(proposals)
      .where(
        and(
          eq(proposals.targetType, "track"),
          inArray(proposals.targetId, missing),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );
  } catch {
    return reports;
  }
  if (pending.length === 0) return reports;
  const proposalOf = new Map(pending.map((p) => [p.targetId, p.id]));
  return reports.map((r) => {
    const proposalId =
      r.status === "failed" && r.reason === "not_found" && r.blockerTrackId
        ? proposalOf.get(r.blockerTrackId)
        : undefined;
    return proposalId && r.status === "failed"
      ? {
          ...r,
          message: `This goal is still a proposal (${proposalId}): it exists once the person approves it. Link it then.`,
        }
      : r;
  });
}

/** Drop `from --blocked_by--> <kind>:<id>` for each id, governed, per id. */
export async function removeUnitBlockers(
  input: UnitBlockerInput
): Promise<UnitBlockerRemovalReport[]> {
  return perId(input, governedRemoveDependencyLink, (r) =>
    r.status === "removed" || r.status === "absent"
      ? { status: r.status }
      : null
  );
}

/**
 * Both kinds for one waiting unit, in one call — what the session and goal
 * doors run. Empty lists cost nothing and report nothing.
 */
export async function applyUnitBlockerEdits(input: {
  from: WaitingUnit;
  add: { entity: readonly string[]; track: readonly string[] };
  remove: { entity: readonly string[]; track: readonly string[] };
  userId: string;
  agentUserId?: string | null;
  sessionId?: string | null;
  approvedProposalId?: string | null;
  door: string;
}): Promise<{
  links: UnitBlockerReport[];
  removals: UnitBlockerRemovalReport[];
}> {
  const base = {
    from: input.from,
    userId: input.userId,
    agentUserId: input.agentUserId,
    sessionId: input.sessionId,
    approvedProposalId: input.approvedProposalId,
    door: input.door,
  };
  const links: UnitBlockerReport[] = [];
  const removals: UnitBlockerRemovalReport[] = [];
  for (const kind of ["entity", "track"] as const) {
    if (input.add[kind].length > 0) {
      links.push(
        ...(await addUnitBlockers({ ...base, kind, ids: input.add[kind] }))
      );
    }
    if (input.remove[kind].length > 0) {
      removals.push(
        ...(await removeUnitBlockers({
          ...base,
          kind,
          ids: input.remove[kind],
        }))
      );
    }
  }
  return { links, removals };
}
