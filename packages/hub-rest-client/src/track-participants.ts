/**
 * Wire types for WHO IS ON A GOAL — the Hub `/tracks/:id/participants…`
 * routes (rest/track-participants.ts) and `HubTrack.participants`.
 *
 * Roles, principal kinds and commitment states mirror `@synap-core/types/units`
 * (`TrackParticipantRole`, …), pinned EQUAL by `parity/track-status.floor.ts`
 * (this package has zero dependencies, so it cannot import the originals).
 */

import type { HubTrackProposed } from "./tracks.js";

export type HubTrackParticipantRole =
  "owner" | "judge" | "delegate" | "integrator";

export type HubTrackPrincipalKind = "person" | "agent";

export type HubTrackCommitmentState =
  | "proposed"
  | "accepted"
  | "countered"
  | "declined"
  | "reported_impossible"
  | "done";

/** How a delegate answers their own commitment. */
export type HubTrackCommitmentMove =
  "accept" | "counter" | "decline" | "report_impossible";

/** One participant of a goal, as `GET /tracks/:id` returns it. */
export interface HubTrackParticipant {
  id: string;
  principalKind: HubTrackPrincipalKind;
  /** A user id: a person's, or an agent's own. */
  principalId: string;
  /** The name a person reads, resolved by the pod — `null` when unknown. */
  displayName: string | null;
  role: HubTrackParticipantRole;
  commitment: string | null;
  commitmentState: HubTrackCommitmentState | null;
  counterText: string | null;
  reportedReason: string | null;
  reportedAt: string | null;
  acknowledgedAt: string | null;
  decidedBy: string;
  decidedAt: string;
  createdAt: string;
  /** A delegate who still owes something: since when they have said nothing. */
  silentSince: string | null;
}

export interface AddTrackParticipantInput {
  principalId: string;
  role: "judge" | "delegate" | "integrator";
  /** Required for a delegate. */
  commitment?: string;
  reasoning?: string;
}

export interface AnswerTrackCommitmentInput {
  move: HubTrackCommitmentMove;
  /** counter: the counter-offer; report_impossible: why (required); decline: why. */
  text?: string;
  reasoning?: string;
}

/** Every participant write: the goal's participants now, or `proposed`. */
export type HubTrackParticipantsResult =
  | {
      status: "updated";
      trackId: string;
      participants: HubTrackParticipant[];
    }
  | HubTrackProposed;
