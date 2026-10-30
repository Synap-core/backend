/**
 * An agent's OWN revision of its capture graph is decided again (structural
 * plan S4, research fbb1eef7 §2 option a).
 *
 * A revise used to change what a pending graph asks for and never what the
 * pod decided about it: a graph parked for a reason the revision removed kept
 * waiting for a person, and its stored reason described content that no
 * longer existed. GitHub's lesson in reverse: a change to the content re-opens
 * the decision.
 *
 * WHEN. Only the proposal's own agent, only a revision that replaced its
 * `operations`, only an `import.graph` filed by the capture door
 * (`data.graphSource === "capture"`). Never a person's revision: "Save &
 * Approve" is a decision, and a reviewer's edit is not the agent asking again.
 *
 * WHAT. The decision the filing ran (`submitCaptureGraph`), in its order:
 *   1. the stored reason — a FLOOR (`ruleCanReachReason` false: admin, schema,
 *      scope, duplicate, untrusted origin, daily ceiling, an inference about the
 *      user, …) keeps the graph pending whatever the revision says. A revision
 *      never turns a floored write into an automatic one;
 *   2. channel bindings and a plan project below the agent evidence floor keep
 *      it pending, as at filing;
 *   3. the duplicate door again, over the revised creates (its own pending
 *      twin excluded): anything but `clear` keeps it pending;
 *   4. every member through the ONE resolver (`captureGraphMemberVerdict`).
 * Still proposes → the row keeps waiting with the reason of THIS content.
 * Executes → it is applied as the filing's auto path applies a graph.
 *
 * HOW IT APPLIES. A compare-and-set claims the row: `pending` → `auto_approved`
 * only while it is still pending, still the agent's, and still at the revision
 * this decision read. A person approving, rejecting or revising in between
 * wins; the claim then matches nothing and nothing is applied. The claimed row
 * IS the receipt (FK target of every row it creates), and it materializes
 * through `materializeAgentGraphUnderReceipt`, the auto path's own materializer.
 */
import {
  db,
  proposals,
  and,
  eq,
  or,
  isNull,
  entities,
  drizzleSql,
  ProposalStatus,
  extractIdentitySignals,
  ownerPrivateVisibleWhere,
  getWorkspaceMembership,
  transitionProposal,
} from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { ruleCanReachReason } from "@synap-core/types/trust-ladder";
import { createLogger } from "@synap-core/core";
import { captureGraphMemberVerdict } from "../capture-agent/capture-graph-governance.js";
import { materializeAgentGraphUnderReceipt } from "../capture-agent/submit-capture-graph.js";
import {
  findDuplicateCandidates,
  loadOwnPendingCreates,
} from "../duplicates/find-duplicate-candidates.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
} from "./stamp-materialized.js";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";

const logger = createLogger({ module: "redecide-graph-revision" });

/** What the re-decision did. `null` from the entry point: not eligible. */
export type GraphRedecision =
  /** Still waits for a person; `reason` is why (the stored code when a floor held). */
  | { outcome: "pending"; reason: string | null }
  /** Every member executes now: applied, the row is its `auto_approved` receipt. */
  | { outcome: "applied"; proposalId: string }
  /** The claim matched nothing: someone decided or revised it first. */
  | { outcome: "superseded" }
  /** Claimed but did not materialize: the row is `approval_failed` with why. */
  | { outcome: "failed"; proposalId: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function revisionCount(history: unknown): number {
  return Array.isArray(history) ? history.length : 0;
}

/** The row is still pending, still the agent's, still at this revision. */
function unchangedSince(
  proposalId: string,
  agentUserId: string,
  revisions: number
) {
  return and(
    eq(proposals.id, proposalId),
    eq(proposals.status, ProposalStatus.PENDING),
    eq(proposals.agentUserId, agentUserId),
    drizzleSql`jsonb_array_length(COALESCE(${proposals.revisionHistory}, '[]'::jsonb)) = ${revisions}`
  );
}

/**
 * Is every revised create clear of twins? The capture door's duplicate leg
 * (`submitCaptureGraph`), read again for the revised `operations`: the same
 * record scope, and the caller's pending queue minus this proposal (its own
 * creates are not its twins). Anything the door would not call `clear` (a
 * strong identity it would have linked, a possible twin, a leg that failed)
 * keeps the graph for a person.
 */
async function revisedCreatesAreClear(args: {
  proposalId: string;
  userId: string;
  workspaceId: string | null;
  operations: CompositeProposalOperation[];
}): Promise<boolean> {
  const creates = args.operations.filter(
    (op) => op.op === "create_entity" && !op.existingEntityId
  );
  if (creates.length === 0) return true;
  const recordScope = and(
    ownerPrivateVisibleWhere(
      entities.workspaceId,
      entities.userId,
      args.userId
    ),
    args.workspaceId
      ? or(
          eq(entities.workspaceId, args.workspaceId),
          isNull(entities.workspaceId)
        )
      : isNull(entities.workspaceId)
  );
  const queue = await loadOwnPendingCreates(db, args.userId);
  const pending = {
    ...queue,
    creates: queue.creates.filter((c) => c.proposalId !== args.proposalId),
  };
  for (const op of creates) {
    if (op.op !== "create_entity") continue;
    const answer = await findDuplicateCandidates(db, {
      subject: "entity",
      userId: args.userId,
      profileSlug: op.profileSlug,
      title: op.title ?? null,
      signals: extractIdentitySignals(op.properties, { kind: op.profileSlug }),
      properties: op.properties,
      recordScope,
      ...(op.ref ? { forRef: op.ref } : {}),
      pending,
    });
    if (answer.identity?.match === "strong") return false;
    if (answer.check.status !== "clear") return false;
  }
  return true;
}

/** Keep it waiting, with the reason of the content it now carries. */
async function keepPending(
  proposalId: string,
  agentUserId: string,
  revisions: number,
  reason: string | null,
  storedReason: string | null
): Promise<GraphRedecision> {
  if (reason !== storedReason) {
    await db
      .update(proposals)
      .set({ governanceReason: reason, updatedAt: new Date() })
      .where(unchangedSince(proposalId, agentUserId, revisions));
  }
  return { outcome: "pending", reason };
}

/**
 * Decide again an agent's own revision of its pending capture graph. `null`
 * when the revision is not one this re-decides (see the module header), or
 * when the re-decision itself failed: the revision has already committed, so
 * a failure here leaves the graph pending as revised, and never throws.
 * `revisions` is the row's revision count right after the revision committed.
 */
export async function redecideOwnGraphRevision(input: {
  proposalId: string;
  actingAgentUserId: string;
  revisions: number;
}): Promise<GraphRedecision | null> {
  try {
    return await redecide(input);
  } catch (err) {
    logger.warn(
      { err, proposalId: input.proposalId },
      "re-decide: failed — the revised graph stays pending"
    );
    return null;
  }
}

async function redecide(input: {
  proposalId: string;
  actingAgentUserId: string;
  revisions: number;
}): Promise<GraphRedecision | null> {
  const { proposalId, actingAgentUserId, revisions } = input;
  const [row] = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      proposalType: proposals.proposalType,
      agentUserId: proposals.agentUserId,
      subjectUserId: proposals.subjectUserId,
      workspaceId: proposals.workspaceId,
      sessionId: proposals.sessionId,
      governanceReason: proposals.governanceReason,
      revisionHistory: proposals.revisionHistory,
      data: proposals.data,
    })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  const data = asRecord(row?.data);
  if (
    !row ||
    row.status !== ProposalStatus.PENDING ||
    row.proposalType !== "import.graph" ||
    data.graphSource !== "capture" ||
    row.agentUserId !== actingAgentUserId ||
    !row.subjectUserId ||
    revisionCount(row.revisionHistory) !== revisions
  ) {
    return null;
  }
  const userId = row.subjectUserId;
  const storedReason = row.governanceReason ?? null;
  const operations = (
    Array.isArray(data.operations) ? data.operations : []
  ) as CompositeProposalOperation[];

  // 1. A floor the filing hit holds, whatever the revision changed.
  if (!ruleCanReachReason(storedReason)) {
    return { outcome: "pending", reason: storedReason };
  }
  // 2. What the filing never auto-applies.
  const bindings = Array.isArray(data.bindings) ? data.bindings : [];
  const planNeedsReview = operations.some(
    (op) => op.op === "create_project" && op.evidence?.belowAgentFloor === true
  );
  if (bindings.length > 0 || planNeedsReview) {
    return { outcome: "pending", reason: storedReason };
  }
  // 3. The duplicate door, again.
  if (
    !(await revisedCreatesAreClear({
      proposalId,
      userId,
      workspaceId: row.workspaceId,
      operations,
    }))
  ) {
    return keepPending(
      proposalId,
      actingAgentUserId,
      revisions,
      "POSSIBLE_DUPLICATE",
      storedReason
    );
  }
  // 4. Every member, through the one resolver.
  const verdict = await captureGraphMemberVerdict({
    agentUserId: actingAgentUserId,
    userId,
    workspaceId: row.workspaceId,
    operations,
  });
  if (verdict.proposes) {
    return keepPending(
      proposalId,
      actingAgentUserId,
      revisions,
      verdict.reasonCode,
      storedReason
    );
  }

  const workspaceRole = row.workspaceId
    ? (await getWorkspaceMembership(db, row.workspaceId, userId))?.role
    : "owner";
  // No membership: it cannot materialize as this person, so a person decides.
  if (!workspaceRole) return { outcome: "pending", reason: storedReason };

  const now = new Date();
  const [claimed] = await transitionProposal(db, {
    to: ProposalStatus.AUTO_APPROVED,
    from: [ProposalStatus.PENDING],
    set: {
      reviewedBy: userId,
      reviewedAt: now,
      updatedAt: now,
      governanceReason: null,
    },
    where: unchangedSince(proposalId, actingAgentUserId, revisions),
  }).returning({ id: proposals.id, data: proposals.data });
  if (!claimed) return { outcome: "superseded" };
  markProposalNotificationsActioned([claimed.id]);

  const receipt = {
    id: claimed.id,
    data: asRecord(claimed.data),
  };
  let materialized: Awaited<
    ReturnType<typeof materializeAgentGraphUnderReceipt>
  >;
  try {
    materialized = await materializeAgentGraphUnderReceipt(
      {
        db,
        authenticated: true,
        userId,
        workspaceId: row.workspaceId,
        workspaceRole,
        sessionId: row.sessionId ?? null,
        // The row the claim just returned: the FK target exists.
        governanceProposalId: claimed.id,
      },
      {
        receipt,
        operations,
        agentUserId: actingAgentUserId,
        source: typeof data.source === "string" ? data.source : "agent",
        idempotencyKey:
          typeof data.idempotencyKey === "string"
            ? data.idempotencyKey
            : claimed.id,
      }
    );
  } catch (err) {
    // `runMaterializationUnderReceipt` recorded the failure on the row.
    logger.warn(
      { err, proposalId },
      "re-decide: the revised graph did not materialize (approval_failed)"
    );
    return { outcome: "failed", proposalId };
  }
  try {
    await stampMaterialized({
      proposalId: claimed.id,
      record: buildMaterializedRecord(materialized),
      baseData: receipt.data,
    });
  } catch (err) {
    logger.warn(
      { err, proposalId },
      "re-decide: receipt materialized-ids update failed (graph applied)"
    );
  }
  return { outcome: "applied", proposalId: claimed.id };
}
