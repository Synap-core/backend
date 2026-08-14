/**
 * The event-driven pod-wide proposal attention fan-out.
 *
 * WHY THIS EXISTS: `notifyPodWideProposal` is the fan-out, but it only fires for
 * callers that REMEMBER to call it. The trusted-lane WIDEN scanner
 * (`packages/jobs/src/workers/governance-lane-scanner.ts`) files
 * `governance.widen_lane` proposals through the `insertPendingProposal` one-door
 * and cannot call it at all: it lives in `@synap/jobs`, and the dependency
 * direction is api → jobs, never jobs → api. So the proposal that GRANTS an
 * agent more autonomy — the riskier direction — was invisible to the human it
 * asks to decide.
 *
 * THE SEAM: every one of those writers already emits a `proposal.created` side
 * effect through `emitSideEffects` (@synap/events). That emitter iterates a
 * REACTOR REGISTRY (`registerReactor`), and the reactors run in the process that
 * registered them — the API server process, which is also the process that
 * registers and runs every pg-boss worker (`apps/api/src/index.ts` →
 * `registerAllWorkers`). So an api-side reactor sees the jobs-side emit without
 * anyone importing across the boundary. Registering it is the same IoC move
 * `registerImportCorpusHandler` makes at boot.
 *
 * CONSEQUENCE: any current or future writer of a pod-wide proposal is covered by
 * emitting the side effect it already emits — no writer has to remember the
 * notification.
 *
 * NOT A SECOND NOTIFICATION PATH: this reactor resolves the proposal and calls
 * the SAME `notifyPodWideProposal`. Because the direct callers still call it too,
 * pod-wide proposals reach that helper twice — which is exactly why the
 * idempotency guard lives INSIDE the helper (see `notify-pod-wide-proposal.ts`),
 * keyed on the durable `(sourceId, userId)` notification row, not on ordering.
 *
 * WORKSPACE PROPOSALS ARE NOT TOUCHED: the reactor re-reads the row and bails
 * unless `workspaceId IS NULL`. A workspace proposal's attention is
 * `NotificationService.fromProposal`, fired by `notifyProposalCreated`; this
 * reactor must never double it.
 *
 * The row is re-read rather than trusted from the payload deliberately: the emit
 * payloads differ between writers (some omit `workspaceId` entirely, so an absent
 * field cannot be read as "pod-wide"), and the DB row is the one authority on
 * scope and status.
 */

import { createLogger } from "@synap-core/core";
import { db, eq, proposals } from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import { notifyPodWideProposal } from "./notify-pod-wide-proposal.js";

const logger = createLogger({ module: "pod-wide-proposal-reactor" });

/**
 * The `${targetType}.${proposalType}` label the notification templates expect.
 * Governance rows already store a dotted, fully-qualified `proposalType`
 * (`governance.widen_lane`) while the chat-AI door stores a bare verb
 * (`create`, `update`) under a `targetType`. Composing unconditionally would
 * produce `governance.governance.widen_lane`.
 */
function composeProposalLabel(
  targetType: string,
  proposalType: string
): string {
  return proposalType.includes(".")
    ? proposalType
    : `${targetType}.${proposalType}`;
}

function describe(label: string, data: unknown): string {
  const pattern =
    data && typeof data === "object" && "targetPattern" in data
      ? (data as { targetPattern?: unknown }).targetPattern
      : undefined;
  return typeof pattern === "string" ? `${label} — ${pattern}` : label;
}

export const podWideProposalNotifyReactor: Reactor = {
  id: "pod-wide-proposal-notify",
  match: (payload) =>
    payload.subjectType === "proposal" && payload.action === "created",
  async handler(payload) {
    const proposal = await db.query.proposals.findFirst({
      where: eq(proposals.id, payload.subjectId),
      columns: {
        id: true,
        workspaceId: true,
        status: true,
        targetType: true,
        proposalType: true,
        agentUserId: true,
        data: true,
      },
    });
    // Not found → nothing to notify about. Workspace-scoped → the workspace path
    // owns it. Not pending → it was already decided; a bell item would be noise.
    if (!proposal) return;
    if (proposal.workspaceId !== null) return;
    if (proposal.status !== "pending") return;

    const label = composeProposalLabel(
      proposal.targetType,
      proposal.proposalType
    );
    // Governance rows carry the subject agent in `data.agentUserId` (the row's
    // own `agent_user_id` is null — the scanner, not the agent, authors them).
    const dataAgentUserId =
      proposal.data &&
      typeof proposal.data === "object" &&
      "agentUserId" in proposal.data
        ? (proposal.data as { agentUserId?: unknown }).agentUserId
        : undefined;

    await notifyPodWideProposal({
      proposalId: proposal.id,
      proposalType: label,
      description: describe(label, proposal.data),
      agentUserId:
        proposal.agentUserId ??
        (typeof dataAgentUserId === "string" ? dataAgentUserId : undefined),
    });
  },
};

let registered = false;

/**
 * Register the reactor. Called once at API boot (`apps/api/src/index.ts`).
 * Guarded so a repeated boot path can never fan out twice per emit.
 */
export function registerPodWideProposalReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(podWideProposalNotifyReactor);
  logger.info("Registered pod-wide proposal notification reactor");
}
