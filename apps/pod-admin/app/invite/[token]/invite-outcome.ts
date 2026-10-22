/**
 * What the invite page says, derived from what the pod answered — pure, so the
 * mapping is tested without a browser (`invite-outcome.test.ts`).
 *
 * Two doors accept an invite: `workspaces.acceptInvite` (tRPC, an existing
 * account) and `POST /api/hub/setup/accept-invite` (REST, a new account).
 * They refuse the same things with different shapes; both land on the SAME
 * page states here, so a dead or spent invite reads as "no longer valid", not
 * as a red banner holding a server sentence.
 */
import {
  humanizeToken,
  nounInSentence,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";

export interface InviteSubject {
  type: "workspace" | "pod";
  inviterName: string;
  role: string;
  workspaceName?: string;
}

/**
 * Where an attempt to accept ended when it did not succeed. `retry` keeps the
 * form and shows `message` (what failed, in words) beside the same action.
 */
export type AcceptRefusal =
  | { kind: "not-found" }
  | { kind: "expired" }
  | { kind: "wrong-account" }
  | { kind: "account-exists" }
  | { kind: "retry"; message: string };

/** The role in running text: "editor", never the raw token. */
export function roleInSentence(role: string): string {
  return nounInSentence(humanizeToken(role));
}

/** "Join "Studio"" / "Join this pod": what the person is being asked to join. */
export function inviteTitle(subject: InviteSubject): string {
  return subject.type === "workspace" && subject.workspaceName
    ? `Join ${subject.workspaceName}`
    : "Join this pod";
}

/** "Alice invited you to the space Studio as editor." */
export function inviteLine(subject: InviteSubject): string {
  const space = nounInSentence(resolveObjectNoun("workspace"));
  const what =
    subject.type === "workspace" && subject.workspaceName
      ? `the ${space} ${subject.workspaceName}`
      : "this pod";
  return `${subject.inviterName} invited you to ${what} as ${roleInSentence(subject.role)}.`;
}

/** The Done headline: what was joined, and where. */
export function joinedHeadline(
  subject: Pick<InviteSubject, "type" | "workspaceName">,
  podHost: string | undefined
): string {
  const where = podHost ?? "this pod";
  return subject.type === "workspace" && subject.workspaceName
    ? `You joined ${subject.workspaceName} on ${where}`
    : `You joined ${where}`;
}

const RETRY_GENERIC =
  "We could not accept the invitation just now. Try again in a moment.";
const RETRY_UNREACHABLE =
  "We could not reach this pod. Check your connection and try again.";

/** A refusal from `workspaces.acceptInvite` (a tRPC client error). */
export function acceptInviteRefusal(err: unknown): AcceptRefusal {
  const e = err as { data?: { code?: string } | null; message?: string };
  const code = e?.data?.code;
  if (code === "NOT_FOUND") return { kind: "not-found" };
  if (code === "BAD_REQUEST" && /expired/i.test(e.message ?? "")) {
    return { kind: "expired" };
  }
  if (code === "FORBIDDEN") return { kind: "wrong-account" };
  // No answer at all: the request never reached the pod.
  if (!code) return { kind: "retry", message: RETRY_UNREACHABLE };
  return { kind: "retry", message: RETRY_GENERIC };
}

/**
 * A refusal from `POST /setup/accept-invite`. `status` null = the request
 * never got an answer (network). `body` is the parsed JSON, when there was one.
 */
export function createAccountRefusal(
  status: number | null,
  body: { error?: string; code?: string } | null
): AcceptRefusal {
  if (status === null) return { kind: "retry", message: RETRY_UNREACHABLE };
  if (status === 409 && body?.code === "ACCOUNT_EXISTS") {
    return { kind: "account-exists" };
  }
  if (status === 404) return { kind: "not-found" };
  if (status === 410) return { kind: "expired" };
  if (status === 403) return { kind: "wrong-account" };
  // A 400 names the field the person can fix (e.g. the password rule).
  if (status === 400 && body?.error) {
    return { kind: "retry", message: body.error };
  }
  return {
    kind: "retry",
    message:
      "We could not create your account just now. Try again in a moment.",
  };
}
