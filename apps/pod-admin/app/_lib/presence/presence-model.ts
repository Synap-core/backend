/**
 * Proof of presence in pod admin (W3): the ONE way the console approves when
 * the pod asks for the person in person. Pure: no React, no fetch.
 *
 * A sensitive approval (connect an AI, change who may do what, deploy,
 * delete: `SENSITIVE_APPROVALS`, `@synap-core/types/presence`) is refused
 * `PRESENCE_REQUIRED` without a proof once the pod runs in `enforce`, and a
 * request filed AS the person always is. The client then:
 *   1. asks `presence.challenge` for THAT proposal (or pending agent key);
 *   2. signs it with a passkey, user verification required;
 *   3. approves again with `presence: {kind: "passkey", challengeId, credential}`.
 * A refused proof (`PRESENCE_INVALID | _EXPIRED | _USED`) is never resent: a
 * new challenge, a new signature.
 *
 * Every approve door the console calls goes through `approveWithPresence`
 * (one approval) or `approveEachWithPresence` (a batch), wrapped by the doors
 * in this folder (`use-approve.ts`, `pending-key-approval.ts`). The tripwire
 * `__tripwires__/presence-approve-doors.test.ts` fails when a page calls an
 * approve door around them.
 *
 * Contract: pod document "W3 pod-first: proof of presence on the pod",
 * section "As built".
 */

import {
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_REQUIRED,
  PRESENCE_USED,
  sensitiveApprovalReason,
  type PresenceProof,
  type PresenceRefusalCode,
} from "@synap-core/types/presence";

/** What a challenge names: a proposal, or a pending agent key (its `agent/connect`). */
export type PresenceSubject = { proposalId: string } | { pendingKeyId: string };

/** Where in a batch this proof is, so the dialog can say "2 of 3". */
export interface PresenceProgress {
  index: number;
  total: number;
}

/**
 * Ask the person for a proof of this subject. `refusal` is why the pod
 * refused the last try (the dialog says why it asks again). Rejects with
 * {@link PresenceDeclined} when the person does not confirm.
 */
/**
 * `upFront`: asked BEFORE the first try, because the request is sensitive
 * (`needsPresence`). The person is asked only when they can prove (a passkey
 * this browser can use); otherwise, or when the challenge cannot be read, it
 * resolves null and the approval goes without a proof: the pod then decides
 * (`report` lets it through; `enforce` refuses it and the reactive ask, with
 * its failed-read and no-passkey states, follows). Never null without it.
 */
export interface ProveOptions {
  upFront?: boolean;
}

export type ProvePresence = (
  subject: PresenceSubject,
  refusal: PresenceRefusalCode,
  progress?: PresenceProgress,
  options?: ProveOptions
) => Promise<PresenceProof | null>;

/**
 * Does approving this request need a proof of presence? The pod's own test
 * (`services/presence/gate.ts` `presenceReasonFor`): a sensitive approval
 * (`sensitiveApprovalReason`, the ONE list) or a request filed AS the person.
 * Clients prove such a request UP FRONT, so `report` mode already runs the
 * proof path that `enforce` will require (review bf96d410, lane A).
 */
export function needsPresence(proposal: {
  targetType?: string | null;
  proposalType?: string | null;
  data?: unknown;
}): boolean {
  const data = proposal.data as { asPerson?: unknown } | null | undefined;
  if (data?.asPerson === true) return true;
  if (!proposal.targetType || !proposal.proposalType) return false;
  return (
    sensitiveApprovalReason({
      targetType: proposal.targetType,
      proposalType: proposal.proposalType,
    }) !== null
  );
}

const PRESENCE_CODES: ReadonlySet<string> = new Set([
  PRESENCE_REQUIRED,
  PRESENCE_INVALID,
  PRESENCE_EXPIRED,
  PRESENCE_USED,
]);

/** A machine code → a presence refusal, or null. */
export function asPresenceCode(code: unknown): PresenceRefusalCode | null {
  return typeof code === "string" && PRESENCE_CODES.has(code)
    ? (code as PresenceRefusalCode)
    : null;
}

/**
 * A REST door's presence refusal (`{error, code}` with 403), thrown so the
 * same retry reads it as a tRPC one.
 */
export class PresenceRefusedError extends Error {
  readonly presenceCode: PresenceRefusalCode;
  constructor(code: PresenceRefusalCode, message: string) {
    super(message);
    this.name = "PresenceRefusedError";
    this.presenceCode = code;
  }
}

/**
 * Why the pod refused an approval for its proof, or null when it refused for
 * something else (or did not refuse). tRPC carries it as `data.reasonCode`
 * (`init-trpc.ts`), a REST door as a {@link PresenceRefusedError}.
 */
export function presenceRefusal(err: unknown): PresenceRefusalCode | null {
  if (err instanceof PresenceRefusedError) return err.presenceCode;
  const data = (err as { data?: { reasonCode?: unknown } | null } | null)?.data;
  return asPresenceCode(data?.reasonCode);
}

/** The person closed the dialog without confirming: nothing was approved. */
export class PresenceDeclined extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresenceDeclined";
  }
}

/**
 * How many proofs one approval may ask for. A proof the pod refuses
 * (expired, used, not verified) is asked for again, but never forever.
 */
export const MAX_PROOFS = 3;

/**
 * ONE approval, with its proof when the pod asks for it. `attempt` sends the
 * approval (with `presence` when given); a presence refusal asks the person
 * (`prove`) and tries again with a new proof. Any other failure, and the
 * refusal after {@link MAX_PROOFS} proofs, is thrown as the door threw it.
 */
export async function approveWithPresence<T>(args: {
  subject: PresenceSubject;
  prove: ProvePresence;
  attempt: (presence?: PresenceProof) => Promise<T>;
  progress?: PresenceProgress;
  /** The request is sensitive: ask before the first try (`needsPresence`). */
  upFront?: boolean;
}): Promise<T> {
  let presence: PresenceProof | undefined;
  if (args.upFront) {
    presence =
      (await args.prove(args.subject, PRESENCE_REQUIRED, args.progress, {
        upFront: true,
      })) ?? undefined;
  }
  for (let proofs = 0; ; proofs++) {
    try {
      return await args.attempt(presence);
    } catch (err) {
      const code = presenceRefusal(err);
      if (!code || proofs >= MAX_PROOFS) throw err;
      const proof = await args.prove(args.subject, code, args.progress);
      if (!proof) throw err;
      presence = proof;
    }
  }
}

/**
 * A batch's sensitive items, proved UP FRONT one by one before the batch is
 * sent ("1 of 3"). Declining one stops the whole batch before anything is
 * sent (`PresenceDeclined` is thrown). An item the person cannot prove here
 * is sent without a proof, and the pod decides.
 */
export async function proveEachUpFront(args: {
  ids: readonly string[];
  subjectOf: (id: string) => PresenceSubject;
  prove: ProvePresence;
}): Promise<Record<string, PresenceProof>> {
  const proofs: Record<string, PresenceProof> = {};
  for (const [n, id] of args.ids.entries()) {
    const proof = await args.prove(
      args.subjectOf(id),
      PRESENCE_REQUIRED,
      { index: n + 1, total: args.ids.length },
      { upFront: true }
    );
    if (proof) proofs[id] = proof;
  }
  return proofs;
}

/**
 * A BATCH, item by item where the pod asks for a proof. The batch door
 * answers per item; each item refused for its proof is proved and sent again
 * ALONE, right after its proof (a proof lives 2 minutes, one challenge per
 * item). When the person declines one, nothing more is asked: the remaining
 * refused items stay refused, as the pod answered them.
 *
 * Returns the batch's results with each retried item's new result in place.
 */
export async function approveEachWithPresence<R>(args: {
  results: readonly R[];
  /** The item's id and presence refusal, or null when it needs no proof. */
  refusalOf: (result: R) => { id: string; code: PresenceRefusalCode } | null;
  subjectOf: (id: string) => PresenceSubject;
  prove: ProvePresence;
  /** Send this one item again with its proof; its new result. */
  retryOne: (id: string, presence: PresenceProof) => Promise<R>;
}): Promise<R[]> {
  const out = [...args.results];
  const refused = out
    .map((r, i) => ({ i, refusal: args.refusalOf(r) }))
    .filter((x) => x.refusal !== null);
  for (const [n, { i }] of refused.entries()) {
    const progress = { index: n + 1, total: refused.length };
    for (let proofs = 0; proofs < MAX_PROOFS; proofs++) {
      const refusal = args.refusalOf(out[i]!);
      if (!refusal) break;
      let presence: PresenceProof | null;
      try {
        presence = await args.prove(
          args.subjectOf(refusal.id),
          refusal.code,
          progress
        );
      } catch (err) {
        if (err instanceof PresenceDeclined) return out;
        throw err;
      }
      if (!presence) return out;
      out[i] = await args.retryOne(refusal.id, presence);
    }
  }
  return out;
}
