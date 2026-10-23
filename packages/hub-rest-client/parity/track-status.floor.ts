/**
 * COMPILE FLOOR — the track status and verdict unions this zero-dependency
 * package publishes (`HubTrackStatus`, `HubTrackVerdict`) must stay EQUAL to
 * the canonical ones (`TrackStatus`, `TrackVerdict` in
 * `@synap-core/types/units`), which are the tuples the pod's DB enum is pinned
 * to. Before this floor the client hand-typed a 4-value union that nothing
 * checked; the pod then grew the open statuses (0344) and a client still
 * offering four would have refused nothing and shown nothing new.
 *
 * Why a mirror at all, and why outside `src/`: see `space-brief.floor.ts`.
 * Run by `pnpm typecheck` (tsconfig.parity.json).
 *
 * WHAT IT CANNOT SEE: the wire VALUES the pod returns (a status the pod
 * writes but no union names would still type-check here) — the pod's own
 * compile pins (`tracks-service.ts`) hold the DB side.
 */
import type { TrackStatus, TrackVerdict } from "../../types/src/units/track.js";
import type {
  TrackCommitmentMove,
  TrackCommitmentState,
  TrackParticipantRole,
  TrackPrincipalKind,
} from "../../types/src/units/track-participants.js";
import type { HubTrackStatus, HubTrackVerdict } from "../src/tracks.js";
import type {
  HubTrackCommitmentMove,
  HubTrackCommitmentState,
  HubTrackParticipantRole,
  HubTrackPrincipalKind,
} from "../src/track-participants.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const _status: Same<HubTrackStatus, TrackStatus> = true;
export const _verdict: Same<HubTrackVerdict, TrackVerdict> = true;
// Who is on a goal (0346, W3).
export const _role: Same<HubTrackParticipantRole, TrackParticipantRole> = true;
export const _kind: Same<HubTrackPrincipalKind, TrackPrincipalKind> = true;
export const _state: Same<HubTrackCommitmentState, TrackCommitmentState> = true;
export const _move: Same<HubTrackCommitmentMove, TrackCommitmentMove> = true;
