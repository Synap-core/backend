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
 * read against the pod's choice of what asks for a passkey, W5),
 * the ONE list), plus every request the CLI filed AS THE PERSON
 * (`data.asPerson`). Everything else passes untouched.
 *
 * The mode (`mode.ts`: the pod setting, `enforce` by default, the operator
 * env floor): `enforce` refuses a sensitive approval with no proof; `report`
 * (an admin's explicit choice) lets it through and records
 * `presence.missing`. A request filed as the person ALWAYS needs the proof,
 * whatever the mode: it is new, and it is the founder's condition (an AI
 * never acts as the person). A proof that is sent is ALWAYS verified, in
 * every mode.
 *
 * A person with NO proof factor is refused like anyone else, and the refusal
 * says how to add one: their first passkey and their first Relay device key
 * need no proof (`factors.ts`, the Kratos settings guard), so the way back in
 * is always open.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  PRESENCE_REQUEST_KINDS,
  PRESENCE_REQUIRED,
  presenceActorLabel,
  presenceActionDigest,
  presenceActionSubject,
  presenceRequestSubject,
  type PresenceRequestKind,
  sensitiveActionReason,
  sensitiveApprovalReason,
  type PresenceProof,
  type SensitiveActionPath,
  type SensitiveReason,
} from "@synap-core/types/presence";
import { isUuid } from "@synap-core/types/property-render";
import { readPresenceMode, readPresenceSensitivity } from "./mode.js";
import { mintPresencePass, type PresencePass } from "./pass.js";
import { db, eq, users, EventRepository, sql } from "@synap/database";

export type { PresencePass } from "./pass.js";

import {
  hasProofFactor,
  PresenceError,
  verifyAndConsumePresence,
  type PresenceVerdict,
} from "./proof.js";

const logger = createLogger({ module: "presence-gate" });

const PRESENCE_PROVED_EVENT = "presence.proved";
const PRESENCE_MISSING_EVENT = "presence.missing";

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

/**
 * Why approving this needs a proof, or null when it does not. A row of the
 * lists asks unless a pod admin switched it off (W5): the pod's choice is
 * read only for a proposal a row matches, so an everyday approval never
 * waits on it. A failed read throws (never "switched off").
 */
async function presenceReasonFor(
  proposal: GatedProposal
): Promise<SensitiveReason | "as_person" | null> {
  if (filedAsPerson(proposal)) return "as_person";
  if (!sensitiveApprovalReason(proposal)) return null;
  return sensitiveApprovalReason(proposal, await readPresenceSensitivity());
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

/** The refusal's sentence: what it needs, and how to add one when none is held. */
export const PRESENCE_REQUIRED_MESSAGE =
  "Confirm it is you: this needs Face ID, Touch ID or your passkey.";
export const PRESENCE_NO_FACTOR_HINT =
  "You have none yet: add a passkey in pod admin under Security, or set up Relay on your phone. The first one needs no approval.";
/**
 * The refusal a KEY caller gets (the CLI, an AI, a script): a key can never
 * answer a Face ID or passkey prompt, so it is told where the person does it.
 */
export const PRESENCE_KEY_CALLER_MESSAGE =
  "This needs the person, not a key: do it in pod admin, where you confirm it is you.";

/**
 * The words of a PRESENCE_REQUIRED refusal. When the person holds no factor
 * at all, it says how to add the first one. The refusal stands either way:
 * a failed factor read only loses the hint (logged), never the refusal.
 */
export async function presenceRequiredMessage(
  userId: string,
  sentence: string = PRESENCE_REQUIRED_MESSAGE
): Promise<string> {
  try {
    if (!(await hasProofFactor(userId))) {
      return `${sentence} ${PRESENCE_NO_FACTOR_HINT}`;
    }
  } catch (err) {
    logger.warn(
      { err, userId },
      "could not read the person's proof factors for the refusal's hint"
    );
  }
  return sentence;
}

/**
 * The one check behind both gates: a proof for `subject`, or (report mode) the
 * missing one recorded. `subject` is a proposal id or `<kind>:<id>`; `what` is
 * what the events call it (`proposalType`, or the request kind).
 */
/**
 * The PRESENCE_REQUIRED refusal. A key caller is told where the person does
 * it (a key cannot prove presence, and the no-factor hint is the person's);
 * anyone else gets the sentence, with the hint when they hold no factor.
 */
export async function presenceRequiredError(args: {
  userId: string;
  subject: string;
  keyCaller?: boolean;
}): Promise<TRPCError> {
  return new TRPCError({
    code: "FORBIDDEN",
    message: args.keyCaller
      ? PRESENCE_KEY_CALLER_MESSAGE
      : await presenceRequiredMessage(args.userId),
    cause: { reasonCode: PRESENCE_REQUIRED, proposalId: args.subject },
  });
}

/** Record a sensitive call let through with no proof (`report` mode). */
export async function recordMissing(args: {
  userId: string;
  subject: string;
  what: string;
  reason: SensitiveReason | "as_person";
  door: string;
}): Promise<void> {
  logger.warn(
    { subject: args.subject, door: args.door, reason: args.reason },
    "sensitive call with no proof of presence (report mode)"
  );
  await record(PRESENCE_MISSING_EVENT, args.userId, {
    proposalId: args.subject,
    proposalType: args.what,
    reason: args.reason,
    door: args.door,
  }).catch((err) => logger.warn({ err }, "could not record presence.missing"));
}

async function checkPresence(args: {
  userId: string;
  subject: string;
  what: string;
  reason: SensitiveReason | "as_person";
  proof?: PresenceProof | null;
  door: string;
  requestedFrom?: string | null;
  /** The caller is a key (Bearer), not a person's session. */
  keyCaller?: boolean;
}): Promise<PresenceVerdict | null> {
  const { userId, subject, what, reason, proof, door } = args;
  // `proposalId` names the subject on the wire (a proposal id, or the request
  // `<kind>:<id>`): the client asks `presence.challenge` for exactly that.
  if (!proof) {
    if (
      reason === "as_person" ||
      (await readPresenceMode()).mode === "enforce"
    ) {
      throw await presenceRequiredError({
        userId,
        subject,
        keyCaller: args.keyCaller,
      });
    }
    await recordMissing({ userId, subject, what, reason, door });
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
  const reason = await presenceReasonFor(args.proposal);
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
  keyCaller?: boolean;
}): Promise<PresenceVerdict | null> {
  return checkPresence({
    userId: args.userId,
    subject: presenceRequestSubject(args.kind, args.id),
    what: args.kind,
    reason: PRESENCE_REQUEST_KINDS[args.kind],
    proof: args.proof,
    door: args.door,
    requestedFrom: args.requestedFrom ?? null,
    keyCaller: args.keyCaller,
  });
}

/**
 * The gate of a sensitive ACTION (W3 slice 3, founder decision 1): a tRPC
 * procedure in `SENSITIVE_ACTIONS` that creates, rotates or widens a
 * credential or a governance rule directly. The proof names THIS call:
 * `action:<path>:<digest of the raw input>`. Same modes and refusals as the
 * other gates. Returns null for a path that is not sensitive.
 */
export async function assertPresenceForAction(args: {
  userId: string;
  path: string;
  /** The call's RAW input (before validation), presence included. */
  input: unknown;
  proof?: PresenceProof | null;
  keyCaller?: boolean;
  /** Which door, when it is not the tRPC procedure itself (a Hub twin). */
  door?: string;
}): Promise<PresenceVerdict | null> {
  const listed = sensitiveActionReason(args.path);
  if (!listed) return null;
  // A path a pod admin switched off (W5) needs no proof: the step-up's fresh
  // sign-in holds instead (`requireFreshAuthentication`). A proof sent anyway
  // (a client that reads the full list) is still verified and still counts
  // as the step-up.
  const reason =
    sensitiveActionReason(args.path, await readPresenceSensitivity()) ??
    (args.proof ? listed : null);
  if (!reason) return null;
  const digest = await presenceActionDigest(args.path, args.input);
  return checkPresence({
    userId: args.userId,
    subject: presenceActionSubject(args.path, digest),
    what: args.path,
    reason,
    proof: args.proof,
    door: args.door ?? args.path,
    keyCaller: args.keyCaller,
  });
}

/**
 * The gate of a sensitive ACTION, for any door: checks the proof bound to
 * this call (or, in `report` mode, records the missing one) and hands the
 * pass the service behind the act requires. Throws as the other gates do.
 */
export async function passPresenceForAction(args: {
  userId: string;
  path: SensitiveActionPath;
  input: unknown;
  proof?: PresenceProof | null;
  keyCaller?: boolean;
  door?: string;
}): Promise<{ verdict: PresenceVerdict | null; pass: PresencePass }> {
  if (!sensitiveActionReason(args.path)) {
    throw new Error(`${args.path} is not a sensitive action`);
  }
  const verdict = await assertPresenceForAction(args);
  return {
    verdict,
    pass: mintPresencePass(args.path, args.userId, verdict !== null),
  };
}
