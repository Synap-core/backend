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
  isGradeAwaitingOutput,
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
    // Read in their lists: a grade comes due (pending → owed) when the output
    // it waits on is made, a write to ANOTHER slot.
    const from = slotStatusOf(was, input.before ?? []);
    const to = slotStatusOf(slot, input.after ?? []);
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
 * The declared grade slots (work-model W5) this write made DUE: waiting on
 * the output their criterion checks before (`isGradeAwaitingOutput`, read in
 * `before`), owed by the person after (read in `after`) — the output was
 * made by this write, a write to ANOTHER slot. Their names (key, else label).
 * Pure.
 */
export function gradesComeDueOf(
  before: readonly SlotForTransition[] | null | undefined,
  after: readonly SlotForTransition[] | null | undefined
): string[] {
  const prior = new Map<string, SlotForTransition>();
  for (const slot of before ?? []) {
    const name = nameOf(slot);
    if (name && !prior.has(name)) prior.set(name, slot);
  }
  const due: string[] = [];
  for (const slot of after ?? []) {
    const name = nameOf(slot);
    const was = name ? prior.get(name) : undefined;
    if (!name || !was || due.includes(name)) continue;
    if (
      isGradeAwaitingOutput(
        was as Parameters<typeof isGradeAwaitingOutput>[0],
        before ?? []
      ) &&
      slotStatusOf(slot, after ?? []) === "owed"
    ) {
      due.push(name);
    }
  }
  return due;
}

/**
 * The slots with `owedSince` stamped `at` on each slot named in `due` that
 * IS due in `outputs` (owed, not waiting on its output: read in this list, so
 * a list the write has not reached yet is left alone) — the moment it became
 * the person's. Forward only: a stamp already at or after `at` is kept (ISO
 * instants: text order is time order), so an age never moves back. `null`
 * when nothing changes. Pure.
 */
export function stampOwedSinceOnDue<T>(
  outputs: readonly T[],
  due: readonly string[],
  at: string
): T[] | null {
  let changed = false;
  const next = outputs.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const slot = raw as SlotForTransition & { owedSince?: unknown };
    const name = nameOf(slot);
    if (!name || !due.includes(name)) return raw;
    if (slotStatusOf(slot, outputs) !== "owed") return raw;
    if (typeof slot.owedSince === "string" && slot.owedSince >= at) return raw;
    changed = true;
    return { ...slot, owedSince: at } as unknown as T;
  });
  return changed ? next : null;
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
  // A declared grade comes due when its output is made, not when it was
  // declared: its age (`owedSince`, which needs-you reads in TypeScript and in
  // SQL alike) starts now (finding f3c864cc). Every slot door calls this in
  // its own write's transaction, on the row it locked, so it is the one
  // place that sees the output made, whichever door made it. A door that
  // owes before it writes (the update door) stamps its own list
  // (`stampOwedSinceOnDue`): the stored row does not show the grade due yet,
  // so the restamp below leaves it alone.
  const due = gradesComeDueOf(input.before, input.after);
  if (due.length > 0) {
    await restampDueGrades(
      tx,
      input.sessionId,
      due,
      (input.occurredAt ?? new Date()).toISOString()
    );
  }
  return transitions;
}

/** Write {@link stampOwedSinceOnDue} onto the stored row (in `tx`). */
async function restampDueGrades(
  tx: Db | Tx,
  sessionId: string,
  due: readonly string[],
  at: string
): Promise<void> {
  const [row] = await tx
    .select({ expectedOutputs: focusSessions.expectedOutputs })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  if (!row || !Array.isArray(row.expectedOutputs)) return;
  const next = stampOwedSinceOnDue(row.expectedOutputs, due, at);
  if (!next) return;
  await tx
    .update(focusSessions)
    .set({ expectedOutputs: next as typeof row.expectedOutputs })
    .where(eq(focusSessions.id, sessionId));
}
