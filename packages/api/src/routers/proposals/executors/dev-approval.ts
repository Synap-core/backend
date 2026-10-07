import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  desc,
  focusSessions,
  playbooks,
  playbookRuns,
  liveRunStatusWhere,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { mergeSessionMetadata } from "../../../services/focus-sessions/session-metadata.js";
import {
  DEV_DEPLOY_APPROVAL_TYPE,
  DEV_PLAN_APPROVAL_TYPE,
  stageAfterDevGate,
} from "../../../services/proposals/dev-approval.js";
import { wakeAgentOnDevDecision } from "../../../services/agent-dispatch/wake-external-agent.js";
import {
  registerProposalExecutor,
  type ProposalEffect,
  type ProposalExecutorArgs,
  type ProposalExecutorResult,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/**
 * Approve executors for the two server-side dev-loop HUMAN GATES,
 * `dev.plan_approval` and `dev.deploy_approval`.
 *
 * ── THESE EXECUTORS RECORD. THEY DO NOT RUN. ────────────────────────────────
 * Apply = stamp the decision on the session (`metadata.devLoop`), advance
 * `current_stage`, emit the realtime update, flip the proposal to APPROVED. That
 * is the ENTIRE effect. The proposal payload carries a `gateCommand` /
 * `deployCommand` string, and NOTHING here executes it: the agent on the server
 * polls its session, reads the stamp, and acts under its own credentials on its
 * own machine.
 *
 * The split is deliberate and load-bearing. If approval ran the command, then
 * tapping "Approve" on a phone would be a remote-shell trigger, and a string an
 * agent authored (or that a compromised repo influenced) would sit on the
 * execution path of the pod. Recording the decision keeps the pod a ledger and
 * leaves execution where the credentials already are. Do not "improve" this by
 * spawning a process here.
 *
 * ── THE STAMP IS THE RECEIPT ────────────────────────────────────────────────
 * The `ProposalEffect` returned is built from the UPDATE's own `.returning()`
 * rows, per the receipt contract in `execution-registry.ts`: an approval may
 * only report a write the storage engine confirmed. A session that vanished
 * between propose and approve yields zero rows, and that must read as a failure
 * — not as a green approval over a stamp nobody holds.
 */

/** What `metadata.devLoop` holds after each gate. Additive; never replaced wholesale. */
interface DevLoopStamp {
  plan?: {
    approvedAt: string;
    approvedBy: string;
    proposalId: string;
    repo: string;
    branch: string;
    gateCommand: string;
  };
  deploy?: {
    approvedAt: string;
    approvedBy: string;
    proposalId: string;
    repo: string;
    branch: string;
    commitSha: string;
    targetHost: string;
    deployCommand: string;
    gatePassed: boolean;
  };
}

/**
 * The LEGACY stage a session sits at once a gate clears — used only when the
 * session follows no staged playbook that names the gate (`stageAfterDevGate`
 * decides otherwise). Read by the polling CLI agent as "you may proceed".
 */
const STAGE_AFTER = {
  [DEV_PLAN_APPROVAL_TYPE]: "plan_approved",
  [DEV_DEPLOY_APPROVAL_TYPE]: "deploy_approved",
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Where the session stands after this gate: the stage after the gate stage of
 * the playbook it follows (the run's frozen definition first, the playbook row
 * second — the same precedence the stage gates use), else the legacy stamp.
 */
async function stageAfterApproval(
  session: { id: string; playbookId: string | null },
  type: keyof typeof STAGE_AFTER
): Promise<string> {
  const [run] = await db
    .select({ definitionSnapshot: playbookRuns.definitionSnapshot })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, session.id),
        liveRunStatusWhere(playbookRuns.status)
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const fromRun = stageAfterDevGate(
    (run?.definitionSnapshot as { stages?: unknown } | null)?.stages,
    type
  );
  if (fromRun) return fromRun;
  if (session.playbookId) {
    const [row] = await db
      .select({ stages: playbooks.stages })
      .from(playbooks)
      .where(eq(playbooks.id, session.playbookId))
      .limit(1);
    const fromPlaybook = stageAfterDevGate(row?.stages, type);
    if (fromPlaybook) return fromPlaybook;
  }
  return STAGE_AFTER[type];
}

/**
 * The shared apply for both gates. `buildStamp` is the only thing that differs —
 * one function, two registrations, so the idempotency guard, the receipt, the
 * realtime emit and the proposal flip cannot drift between the plan gate and the
 * deploy gate (which is how the same door grows two behaviours).
 */
async function applyDevApproval(
  args: ProposalExecutorArgs,
  type: keyof typeof STAGE_AFTER,
  buildStamp: (
    payload: Record<string, unknown>,
    base: { approvedAt: string; approvedBy: string; proposalId: string }
  ) => DevLoopStamp
): Promise<ProposalExecutorResult> {
  const { proposal, userId, input, deps } = args;

  // Idempotency: approve is not status-guarded before dispatch, so a double
  // approve must be a no-op rather than a second stamp with a later timestamp.
  const [alreadyDone] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId));
  if (alreadyDone?.status === ProposalStatus.APPROVED) {
    return {
      success: true,
      alreadyApproved: true,
      effect: {
        applied: "none",
        reason:
          "Already approved — the winning attempt stamped this session's dev gate; " +
          "a re-approve must not overwrite the recorded decision time.",
      },
    };
  }

  // `data.data` is where the gate nests its payload; a directly-filed proposal
  // (createDevApprovalProposal) puts it at the top level. Read both, inner first.
  const stored = asRecord(proposal.data);
  const payload = { ...stored, ...asRecord(stored.data) };

  const sessionId = proposal.targetId;
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: {
      id: true,
      metadata: true,
      workspaceId: true,
      goal: true,
      playbookId: true,
    },
  });
  if (!session) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Dev approval targets focus session ${sessionId}, which no longer exists.`,
    });
  }

  const approvedAt = new Date();
  const stamp = buildStamp(payload, {
    approvedAt: approvedAt.toISOString(),
    approvedBy: userId,
    proposalId: input.proposalId,
  });

  // `mergeSessionMetadata` is a SHALLOW JSONB merge, so the `devLoop` key is
  // REPLACED, not deep-merged. Fold the existing sub-object in here or the
  // deploy gate erases the plan gate's stamp (and vice versa).
  const existingDevLoop = asRecord(asRecord(session.metadata).devLoop);
  const mergedDevLoop = { ...existingDevLoop, ...stamp };

  const updated = await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({ devLoop: mergedDevLoop }),
      currentStage: await stageAfterApproval(session, type),
      updatedAt: approvedAt,
    })
    .where(eq(focusSessions.id, sessionId))
    .returning({
      id: focusSessions.id,
      currentStage: focusSessions.currentStage,
    });

  if (updated.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Dev approval could not stamp focus session ${sessionId} — no row was updated.`,
    });
  }

  const effect: ProposalEffect = {
    applied: "verified",
    rows: updated.length,
    ids: updated.map((row) => row.id),
    subject: "focus_session",
  };

  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: approvedAt,
      updatedAt: approvedAt,
    })
    .where(eq(proposals.id, input.proposalId));

  reportApproved(deps, proposal, input.proposalId);
  deps.emitProposalReviewed(
    input.proposalId,
    proposal.workspaceId,
    "approved",
    userId
  );

  // The loop back: a dispatched external agent that filed this gate is told
  // through its binding (no-op for a pod-run or pull agent). After the stamp,
  // never able to undo it.
  await wakeAgentOnDevDecision({
    proposal,
    proposalId: input.proposalId,
    decision: "approved",
    note: input.comment ?? null,
  });

  return { success: true, effect };
}

/** Register the two dev-loop gate executors. */
export function registerDevApprovalExecutors(): void {
  registerProposalExecutor({
    key: "focus_session/dev.plan_approval",
    execute: (args) =>
      applyDevApproval(args, DEV_PLAN_APPROVAL_TYPE, (payload, base) => ({
        plan: {
          ...base,
          repo: asString(payload.repo),
          branch: asString(payload.branch),
          gateCommand: asString(payload.gateCommand),
        },
      })),
  });

  registerProposalExecutor({
    key: "focus_session/dev.deploy_approval",
    execute: (args) =>
      applyDevApproval(args, DEV_DEPLOY_APPROVAL_TYPE, (payload, base) => ({
        deploy: {
          ...base,
          repo: asString(payload.repo),
          branch: asString(payload.branch),
          commitSha: asString(payload.commitSha),
          targetHost: asString(payload.targetHost),
          deployCommand: asString(payload.deployCommand),
          gatePassed: asRecord(payload.gateReport).passed === true,
        },
      })),
  });
}
