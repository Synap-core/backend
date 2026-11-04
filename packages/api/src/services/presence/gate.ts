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
  PRESENCE_REQUEST_KINDS,
  PRESENCE_REQUIRED,
  presenceActorLabel,
  presenceRequestSubject,
  type PresenceRequestKind,
  sensitiveApprovalReason,
  type PresenceProof,
  type SensitiveReason,
} from "@synap-core/types/presence";
import { isUuid } from "@synap-core/types/property-render";
import { db, eq, users, EventRepository, sql } from "@synap/database";

import {
  PresenceError,
  verifyAndConsumePresence,
  type PresenceVerdict,
} from "./proof.js";

const logger = createLogger({ module: "presence-gate" });

const PRESENCE_PROVED_EVENT = "presence.proved";
const PRESENCE_MISSING_EVENT = "presence.missing";

type PresenceMode = "enforce" | "report";

/** The pod's rollout mode. Read per call so a deploy can flip it. */
function presenceMode(): PresenceMode {
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
function filedAsPerson(proposal: GatedProposal): boolean {
  const data = proposal.data as Record<string, unknown> | null | undefined;
  return data?.asPerson === true;
}

/** Why approving this needs a proof, or null when it does not. */
function presenceReasonFor(
  proposal: GatedProposal
): SensitiveReason | "as_person" | null {
  if (filedAsPerson(proposal)) return "as_person";
  return sensitiveApprovalReason(proposal);
}

/**
 * The computer a request came from, for the audit line. `instanceLabel` is
 * stamped at filing from the filing key's own machine record (setup.ts), never
 * from the request body, and a revise cannot change it
 * (`PROTECTED_ENVELOPE_FIELDS`).
 */
function requestedFrom(proposal: GatedProposal): string | null {
  const data = proposal.data as Record<string, unknown> | null | undefined;
  const value = data?.instanceLabel;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function record(
  type: string,
  userId: string,
  data: Record<string, unknown>
): Promise<void> {
  // A proposal is the event's subject; a request (`<kind>:<id>`) is not a
  // uuid, so it rides in `data` only (the event schema's subjectId is a uuid).
  const subject = data.proposalId as string;
  const isProposal = isUuid(subject);
  await new EventRepository(sql).append({
    id: randomUUID(),
    version: "v1",
    type,
    subjectType: isProposal ? "proposal" : "presence_request",
    ...(isProposal ? { subjectId: subject } : {}),
    userId,
    source: "api",
    timestamp: new Date(),
    data,
  });
}

/**
 * The one check behind both gates: a proof for `subject`, or (report mode) the
 * missing one recorded. `subject` is a proposal id or `<kind>:<id>`; `what` is
 * what the events call it (`proposalType`, or the request kind).
 */
async function checkPresence(args: {
  userId: string;
  subject: string;
  what: string;
  reason: SensitiveReason | "as_person";
  proof?: PresenceProof | null;
  door: string;
  requestedFrom?: string | null;
}): Promise<PresenceVerdict | null> {
  const { userId, subject, what, reason, proof, door } = args;
  // `proposalId` names the subject on the wire (a proposal id, or the request
  // `<kind>:<id>`): the client asks `presence.challenge` for exactly that.
  if (!proof) {
    if (reason === "as_person" || presenceMode() === "enforce") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Confirm it is you: this approval needs Face ID, Touch ID or your passkey.",
        cause: { reasonCode: PRESENCE_REQUIRED, proposalId: subject },
      });
    }
    logger.warn(
      { subject, door, reason },
      "sensitive approval with no proof of presence (report mode)"
    );
    await record(PRESENCE_MISSING_EVENT, userId, {
      proposalId: subject,
      proposalType: what,
      reason,
      door,
    }).catch((err) =>
      logger.warn({ err }, "could not record presence.missing")
    );
    return null;
  }

  let verdict: PresenceVerdict;
  try {
    verdict = await verifyAndConsumePresence({ userId, subject, proof });
  } catch (err) {
    if (err instanceof PresenceError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: err.message,
        cause: { reasonCode: err.code, proposalId: subject },
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
    requestedFrom: args.requestedFrom ?? null,
  });
  // The audit line comes before the approval applies: no trace, no apply.
  await record(PRESENCE_PROVED_EVENT, userId, {
    proposalId: subject,
    proposalType: what,
    reason,
    door,
    actor,
    method: verdict.method,
    deviceKeyId: verdict.deviceKeyId,
    challengeId: verdict.challengeId,
  });
  return verdict;
}

/**
 * The gate of a PROPOSAL approval. Returns the verdict when a proof was
 * checked, null when none was needed (or, in `report` mode, missing and
 * reported). Throws FORBIDDEN with `cause.reasonCode` = PRESENCE_REQUIRED |
 * PRESENCE_INVALID | PRESENCE_EXPIRED | PRESENCE_USED otherwise.
 */
export async function assertPresenceForApproval(args: {
  userId: string;
  proposal: GatedProposal;
  proof?: PresenceProof | null;
  /** Which door, for the log and the event. */
  door: string;
}): Promise<PresenceVerdict | null> {
  const reason = presenceReasonFor(args.proposal);
  if (!reason) return null;
  return checkPresence({
    userId: args.userId,
    subject: args.proposal.id,
    what: `${args.proposal.targetType}/${args.proposal.proposalType}`,
    reason,
    proof: args.proof,
    door: args.door,
    requestedFrom: requestedFrom(args.proposal),
  });
}

/**
 * The gate of a sensitive decision that settles NO proposal (W3 slice 2):
 * the door decides its own request (`PRESENCE_REQUEST_KINDS`), and the
 * challenge names it, `<kind>:<id>`. Same modes and refusals as
 * `assertPresenceForApproval`.
 */
export async function assertPresenceForRequest(args: {
  userId: string;
  kind: PresenceRequestKind;
  id: string;
  proof?: PresenceProof | null;
  door: string;
  requestedFrom?: string | null;
}): Promise<PresenceVerdict | null> {
  return checkPresence({
    userId: args.userId,
    subject: presenceRequestSubject(args.kind, args.id),
    what: args.kind,
    reason: PRESENCE_REQUEST_KINDS[args.kind],
    proof: args.proof,
    door: args.door,
    requestedFrom: args.requestedFrom ?? null,
  });
}
