/**
 * The words for WHO IS ON A GOAL (W3, `@synap-core/types/units`
 * `track-participants.ts`): the role each participant plays and the state of
 * a delegate's commitment. Their own tables, because the shared words mean
 * something else here: a commitment `proposed` is one the person was ASKED to
 * take on (not a governance proposal), and a delegate who reports a goal
 * impossible has refused the commitment — it is never the goal's verdict (R1).
 * `units/track-participants.ts` holds the compile-time floor that every role
 * and state has a row here, and nothing else does.
 */

import { humanizeToken } from "./index.js";

export const TRACK_PARTICIPANT_ROLE_LABELS = {
  owner: "Owner",
  judge: "Judge",
  delegate: "Delegate",
  // NEGCTL: integrator words dropped
} as const satisfies Readonly<Record<string, string>>;

/** The word for a participant's role on a goal; unknown values humanize. */
export function resolveTrackParticipantRoleLabel(
  role: string | null | undefined
): string {
  if (!role) return "";
  const key = role.trim().toLowerCase();
  return Object.hasOwn(TRACK_PARTICIPANT_ROLE_LABELS, key)
    ? TRACK_PARTICIPANT_ROLE_LABELS[
        key as keyof typeof TRACK_PARTICIPANT_ROLE_LABELS
      ]
    : humanizeToken(role);
}

export const TRACK_COMMITMENT_STATE_LABELS = {
  proposed: "Asked",
  accepted: "Accepted",
  countered: "Countered",
  declined: "Declined",
  reported_impossible: "Reported impossible",
  done: "Done",
} as const satisfies Readonly<Record<string, string>>;

/** The word for a delegate's commitment state; unknown values humanize. */
export function resolveTrackCommitmentStateLabel(
  state: string | null | undefined
): string {
  if (!state) return "";
  const key = state.trim().toLowerCase();
  return Object.hasOwn(TRACK_COMMITMENT_STATE_LABELS, key)
    ? TRACK_COMMITMENT_STATE_LABELS[
        key as keyof typeof TRACK_COMMITMENT_STATE_LABELS
      ]
    : humanizeToken(state);
}

/**
 * How long a delegate who owes a goal something has said nothing — "Silent 6 h",
 * "Silent 3 d". ONE word for this ("Silent", never "stale": stale already
 * means an unreadable session). `null` under an hour: a delegate quiet for
 * minutes is not silent.
 */
export function trackSilenceLabel(
  silentSince: string | Date | null | undefined,
  now: Date = new Date()
): string | null {
  if (!silentSince) return null;
  const since =
    silentSince instanceof Date ? silentSince : new Date(silentSince);
  const ms = now.getTime() - since.getTime();
  if (!Number.isFinite(ms) || ms < 60 * 60 * 1000) return null;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours < 48
    ? `Silent ${hours} h`
    : `Silent ${Math.floor(hours / 24)} d`;
}
