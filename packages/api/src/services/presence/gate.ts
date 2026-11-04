/**
 * The approval gate of proof of presence (W3). ONE function every door that
 * approves a proposal calls before anything is applied:
 * `applyProposalApproval` (tRPC approve / batchApprove, Hub REST approve, the
 * OAuth consent, import apply) and the doors that settle a proposal without it
 * (`/setup/agent/pending/*` approve, `secretsVault.grantAIAccess`). The
 * tripwire `presence-gate-every-door` derives those doors from the source and
 * fails when one does not call it.
 *
 * Which approvals: `sensitiveApprovalReason` (`@synap-core/types/presence`,
 * the ONE list), plus every request the CLI filed AS THE PERSON
 * (`data.asPerson`). Everything else passes untouched.
 *
 * Rollout (`SYNAP_PRESENCE_PROOF`): `enforce` refuses a sensitive approval
 * with no proof; anything else (`report`, the default until Relay, desktop and
 * pod admin send proofs) lets it through and records `presence.missing`. A
 * request filed as the person ALWAYS needs the proof, whatever the mode: it is
 * new, and it is the founder's condition (an AI never acts as the person). A
 * proof that is sent is ALWAYS verified, in every mode.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  PRESENCE_REQUIRED,
  presenceActorLabel,
  sensitiveApprovalReason,
  type PresenceProof,
  type SensitiveReason,
} from "@synap-core/types/presence";
import { db, eq, users, EventRepository, sql } from "@synap/database";

import {
  PresenceError,
  verifyAndConsumePresence,
  type PresenceVerdict,
} from "./proof.js";

const logger = createLogger({ module: "presence-gate" });

export const PRESENCE_PROVED_EVENT = "presence.proved";
export const PRESENCE_MISSING_EVENT = "presence.missing";

export type PresenceMode = "enforce" | "report";

/** The pod's rollout mode. Read per call so a deploy can flip it. */
export function presenceMode(): PresenceMode {
  return process.env.SYNAP_PRESENCE_PROOF?.trim() === "enforce"
    ? "enforce"
    : "report";
}

export interface GatedProposal {
  id: string;
  targetType: string;
  proposalType: string;
  data?: unknown;
}

/** Was this proposal filed by the CLI AS THE PERSON (`asPerson`)? */
export function filedAsPerson(proposal: GatedProposal): boolean {
  const data = proposal.data as Record<string, unknown> | null | undefined;
  return data?.asPerson === true;
}

/** Why approving this needs a proof, or null when it does not. */
export function presenceReasonFor(
  proposal: GatedProposal
): SensitiveReason | "as_person" | null {
  if (filedAsPerson(proposal)) return "as_person";
  return sensitiveApprovalReason(proposal);
}

function requestedFrom(proposal: GatedProposal): string | null {
  const data = proposal.data as Record<string, unknown> | null | undefined;
  for (const key of ["instanceLabel", "computer", "hostLabel"]) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function record(
  type: string,
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  await new EventRepository(sql).append({
    id: randomUUID(),
    version: "v1",
    type,
    subjectType: "proposal",
    subjectId: data.proposalId as string,
    userId,
    source: "api",
    timestamp: new Date(),
    data,
  });
}

/**
 * The gate. Returns the verdict when a proof was checked, null when none was
 * needed (or, in `report` mode, missing and reported). Throws FORBIDDEN with
 * `cause.reasonCode` = PRESENCE_REQUIRED | PRESENCE_INVALID | PRESENCE_EXPIRED
 * | PRESENCE_USED otherwise.
 */
export async function assertPresenceForApproval(args: {
  userId: string;
  proposal: GatedProposal;
  proof?: PresenceProof | null;
  /** Which door, for the log and the event. */
  door: string;
}): Promise<PresenceVerdict | null> {
  const { userId, proposal, proof, door } = args;
  const reason = presenceReasonFor(proposal);
  if (!reason) return null;

  if (!proof) {
    if (reason === "as_person" || presenceMode() === "enforce") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Confirm it is you: this approval needs Face ID, Touch ID or your passkey.",
        cause: { reasonCode: PRESENCE_REQUIRED, proposalId: proposal.id },
      });
    }
    logger.warn(
      { proposalId: proposal.id, door, reason },
      "sensitive approval with no proof of presence (report mode)"
    );
    await record(PRESENCE_MISSING_EVENT, userId, {
      proposalId: proposal.id,
      proposalType: `${proposal.targetType}/${proposal.proposalType}`,
      reason,
      door,
    }).catch((err) =>
      logger.warn({ err }, "could not record presence.missing")
    );
    return null;
  }

  let verdict: PresenceVerdict;
  try {
    verdict = await verifyAndConsumePresence({
      userId,
      subject: proposal.id,
      proof,
    });
  } catch (err) {
    if (err instanceof PresenceError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: err.message,
        cause: { reasonCode: err.code, proposalId: proposal.id },
      });
    }
    throw err;
  }

  const person = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true, email: true },
  });
  const actor = presenceActorLabel({
    person: person?.name?.trim() || person?.email || userId,
    method: verdict.method,
    deviceLabel: verdict.deviceLabel,
    requestedFrom: requestedFrom(proposal),
  });
  // The audit line comes before the approval applies: no trace, no apply.
  await record(PRESENCE_PROVED_EVENT, userId, {
    proposalId: proposal.id,
    proposalType: `${proposal.targetType}/${proposal.proposalType}`,
    reason,
    door,
    actor,
    method: verdict.method,
    deviceKeyId: verdict.deviceKeyId,
    challengeId: verdict.challengeId,
  });
  return verdict;
}
