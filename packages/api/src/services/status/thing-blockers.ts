/**
 * THE BLOCKERS OF A SET OF THINGS (plan e7f753db §9) — what the flow read and
 * the flow board put on each card: why it is blocked, whose move it is, what
 * clears it and the status it unlocks. ONE call for the whole set, through
 * THE waiting-on collector (`readWaitingOnSourcesFor`): every source is read
 * once for all the cards (the slots holding them up in one query,
 * `listBlockingSlots`), never once per card.
 *
 * A thing's blocker is an OVERLAY (`deriveThingBlocker`): a hold never
 * blocks (a pause is the status itself), so this question asks no hold — the
 * card keeps its column, marked blocked. statusOf reads the same derivation
 * from the same collector, with its hold.
 *
 * Floored on the reader like every status read: the slots of sessions the
 * reader may read, proposals under the proposal floor, blockers under the
 * dependency read. The caller floored the things themselves (it read them).
 * THROWS on a failed read: the caller says `unavailable`, never "not blocked".
 */
import type { LifecycleOption } from "@synap-core/types/lifecycle";
import { deriveThingBlocker, type ThingBlocker } from "@synap-core/types/units";
import {
  readWaitingOnSourcesFor,
  type WaitingOnQuestion,
  type WaitingOnReader,
} from "./status-facts.js";

/** One card: the thing, the status it stands on and the lifecycle it moves on. */
export interface ThingBlockerAsk {
  id: string;
  /**
   * The role's facet when the card is a role's (a lead): its status and the
   * role's lifecycle decide which `requires` count. Absent = the kind's.
   */
  facetId?: string | null;
  status: string | null;
  /** Its declared lifecycle (the board's columns); null without one. */
  lifecycle: { readonly options: readonly LifecycleOption[] } | null;
}

/** THE question one thing's blocker asks: every wait but a hold. */
export function thingBlockerQuestion(
  id: string,
  facetId?: string | null
): WaitingOnQuestion {
  return {
    owed: { blocking: [id] },
    proposals: { targetIds: [id] },
    blockedNodes: [{ kind: "entity", id }],
    steps: [{ subjectType: "entity", subjectId: id }],
    requirements: [{ entityId: id, ...(facetId ? { facetId } : {}) }],
  };
}

/** Each thing's blocker, keyed by its id (every asked id has one). */
export async function readThingBlockers(
  reader: WaitingOnReader,
  things: readonly ThingBlockerAsk[]
): Promise<Map<string, ThingBlocker>> {
  const unique = [...new Map(things.map((t) => [t.id, t])).values()];
  if (unique.length === 0) return new Map();
  const sources = await readWaitingOnSourcesFor(
    reader,
    new Map(unique.map((t) => [t.id, thingBlockerQuestion(t.id, t.facetId)]))
  );
  return new Map(
    unique.map((t) => [
      t.id,
      deriveThingBlocker(sources.get(t.id) ?? [], t.lifecycle, t.status),
    ])
  );
}
