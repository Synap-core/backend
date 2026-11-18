/**
 * THE SLOT TRANSITION — an owed slot (one declared output or ask
 * of a session, `focus_sessions.expected_outputs`) has no status column and
 * gets none: its status is DERIVED (`slotStatusOf`, from the owed rule
 * `deliverableOwedBy`). So the doors that change a slot owe its transition
 * themselves, here, inside the transaction of their own write: they hand the
 * slots as they LOCKED them and as they WRITE them, and every slot whose
 * derived status changed owes one `slot.transition.completed` (subject id
 * `<session id>/<slot key>`, categories from `SLOT_STATUS_DECLARATION`).
 *
 * A slot that appears (declared) or disappears (removed) is not a move and owes
 * nothing; a slot whose facts changed without changing its derived status
 * (a renamed label, a new `why`) owes nothing either.
 *
 * Never a wake: `focus_session.slot_answered` stays the answer's wake. No
 * built-in reactor wakes an agent on this transition (only the hold-resume
 * worker reads every transition, and it resumes holds, never a turn).
 */
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  SLOT_STATUS_DECLARATION,
  slotStatusOf,
  slotSubjectId,
  type SlotStatusFacts,
} from "@synap-core/types/units";
import type {
  SlotTransitionPayload,
  TransitionCause,
} from "@synap-core/types/lifecycle";
import type * as schema from "../../schema/index.js";
import { focusSessions } from "../../schema/focus-sessions.js";
import { insertTransitionOutbox } from "./transition-outbox.js";
import {
  transitionBaseOf,
  type WorkUnitActor,
} from "./work-unit-transition.js";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A slot as the doors store it: its name and the facts its status reads. */
export type SlotForTransition = SlotStatusFacts & {
  key?: string | null;
  label?: string | null;
};

/** Where the session stands: who owns it, its lens, project and goal. */
export interface SlotSessionPlace {
  id: string;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  trackId: string | null;
}

const nameOf = (slot: SlotForTransition): string | null =>
  slot.key || slot.label || null;

/**
 * The slot transitions a write owes: one per slot (matched by key, else
 * label) present before AND after whose derived status changed. Pure.
 */
export function slotTransitionsOf(input: {
  session: SlotSessionPlace;
  before: readonly SlotForTransition[] | null | undefined;
  after: readonly SlotForTransition[] | null | undefined;
  actor: WorkUnitActor;
  reason?: string | null;
  proposalId?: string | null;
  occurredAt?: Date | null;
  /** The move that caused this one (a reaction). */
  cause?: TransitionCause | null;
}): SlotTransitionPayload[] {
  const prior = new Map<string, SlotForTransition>();
  for (const slot of input.before ?? []) {
    const name = nameOf(slot);
    if (name && !prior.has(name)) prior.set(name, slot);
  }
  const out: SlotTransitionPayload[] = [];
  const seen = new Set<string>();
  for (const slot of input.after ?? []) {
    const name = nameOf(slot);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const was = prior.get(name);
    if (!was) continue; // declared now: a birth, not a move
    const from = slotStatusOf(was);
    const to = slotStatusOf(slot);
    if (from === to) continue;
    const subjectId = slotSubjectId(input.session.id, slot)!;
    out.push({
      ...transitionBaseOf({
        subjectId,
        from,
        to,
        fromCategory: SLOT_STATUS_DECLARATION[from].category,
        category: SLOT_STATUS_DECLARATION[to].category,
        actor: input.actor,
        ownerUserId: input.session.userId,
        // The session is the slot's context: the event lands in its history.
        sessionId: input.session.id,
        reason: input.reason,
        proposalId: input.proposalId,
        workspaceId: input.session.workspaceId,
        occurredAt: input.occurredAt,
        cause: input.cause,
      }),
      subjectType: "slot",
      slotKey: name,
      projectId: input.session.projectId,
      trackId: input.session.trackId,
    });
  }
  return out;
}

/**
 * Owe the slot transitions of one session's write — call INSIDE the write's
 * transaction, with the slots as locked (`before`) and as written (`after`).
 * Reads the session's place when the caller does not hand it. Returns what it
 * owed.
 */
export async function oweSlotTransitions(
  tx: Db | Tx,
  input: {
    sessionId: string;
    /** The session's place, when the caller already read it. */
    session?: SlotSessionPlace;
    before: readonly SlotForTransition[] | null | undefined;
    after: readonly SlotForTransition[] | null | undefined;
    actor: WorkUnitActor;
    reason?: string | null;
    proposalId?: string | null;
    occurredAt?: Date | null;
    /** The move that caused this one (a reaction). */
    cause?: TransitionCause | null;
  }
): Promise<SlotTransitionPayload[]> {
  // Cheap first: most writes change no slot's status.
  const probe = slotTransitionsOf({
    ...input,
    session: input.session ?? {
      id: input.sessionId,
      userId: "",
      workspaceId: null,
      projectId: null,
      trackId: null,
    },
  });
  if (probe.length === 0) return [];
  let session = input.session;
  if (!session) {
    const [row] = await tx
      .select({
        id: focusSessions.id,
        userId: focusSessions.userId,
        workspaceId: focusSessions.workspaceId,
        projectId: focusSessions.projectId,
        trackId: focusSessions.trackId,
      })
      .from(focusSessions)
      .where(eq(focusSessions.id, input.sessionId))
      .limit(1);
    if (!row) return [];
    session = {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId ?? null,
      projectId: row.projectId ?? null,
      trackId: row.trackId ?? null,
    };
  }
  const transitions = slotTransitionsOf({ ...input, session });
  await insertTransitionOutbox(tx, transitions);
  return transitions;
}
