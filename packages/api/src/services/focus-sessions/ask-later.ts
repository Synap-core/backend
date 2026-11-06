/**
 * "Later" on an owed ask (founder decision 9bc9f75c, 2026-11-04): the ONE
 * door that sets one ask aside for its person until a time, and takes it
 * back (the receipt's Undo).
 *
 * The same act as a request's Later (`../proposals/request-later.ts`,
 * decision G3), with the same limits (a time in the future, at most
 * `REQUEST_LATER_MAX_MS` ahead) and the same meaning: nothing else changes —
 * the ask stays owed, the agent still waits — and for the person it is Review
 * later until then (`isSetAside`, read by the needs-you rule
 * `classifyOwedAsk`), back on its own after it. A request is seen by several
 * people, so its Later is a row per person (`proposal_snoozes`); an owed ask
 * has exactly one person, so its Later is a stamp on the slot
 * (`ExpectedOutput.laterUntil`, server-stamped by this door only).
 *
 * Owner-floored like the answer door: the session's owner is the only person
 * whose asks these are. Under the session row lock, like every other
 * `expectedOutputs` writer.
 */

import { TRPCError } from "@trpc/server";
import { db as defaultDb, focusSessions, and, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { laterTimeProblem } from "@synap-core/types/proposals";
import { findSlotIndex } from "./slot-keys.js";
import { isOwedSlot } from "./owed-outputs.js";

type Database = typeof defaultDb;

/**
 * Pure: the slots with the ask named by `ref` set aside until `until`
 * (`null` takes the Later back). `not_owed` when no slot by that key or label
 * is owed by the person — an answered or retired ask has nothing to put off.
 */
export function stampAskLater(
  outputs: readonly ExpectedOutput[],
  ref: string,
  until: Date | null
):
  | { status: "ok"; outputs: ExpectedOutput[]; label: string }
  | { status: "not_owed" } {
  const index = findSlotIndex(outputs, ref, (s) => !!s && isOwedSlot(s));
  if (index === -1) return { status: "not_owed" };
  const slot = outputs[index]!;
  const next = { ...slot };
  if (until) next.laterUntil = until.toISOString();
  else delete next.laterUntil;
  const copy = [...outputs];
  copy[index] = next;
  return { status: "ok", outputs: copy, label: slot.label };
}

/** The refusal a bad time earns: the one Later check, shared with a request's. */
function assertLaterTime(until: Date, now: Date): void {
  const problem = laterTimeProblem(until, now, "an ask");
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
}

async function writeAskLater(p: {
  sessionId: string;
  userId: string;
  expectedLabel: string;
  until: Date | null;
  db: Database;
}): Promise<{ label: string } | null> {
  return p.db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, p.sessionId),
          eq(focusSessions.userId, p.userId)
        )
      )
      .for("update");
    if (!locked) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No session of yours has this id.",
      });
    }
    const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const stamped = stampAskLater(current, p.expectedLabel, p.until);
    if (stamped.status === "not_owed") return null;
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: stamped.outputs })
      .where(eq(focusSessions.id, p.sessionId));
    return { label: stamped.label };
  });
}

/**
 * Set the person's owed ask (`expectedLabel`: the slot's key or label) aside
 * until `until`. A second call moves the time. Refused: a time not in the
 * future or more than 30 days ahead, a session that is not the caller's, an
 * ask that is no longer owed.
 */
export async function setAskLater(input: {
  sessionId: string;
  userId: string;
  expectedLabel: string;
  until: Date;
  now?: Date;
  db?: Database;
}): Promise<{ sessionId: string; label: string; laterUntil: Date }> {
  assertLaterTime(input.until, input.now ?? new Date());
  const written = await writeAskLater({
    sessionId: input.sessionId,
    userId: input.userId,
    expectedLabel: input.expectedLabel,
    until: input.until,
    db: input.db ?? defaultDb,
  });
  if (!written) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This ask is already answered or withdrawn, so there is nothing to put off.",
    });
  }
  return {
    sessionId: input.sessionId,
    label: written.label,
    laterUntil: input.until,
  };
}

/** Take back the person's Later on an owed ask (the receipt's Undo). */
export async function clearAskLater(input: {
  sessionId: string;
  userId: string;
  expectedLabel: string;
  db?: Database;
}): Promise<{ cleared: boolean }> {
  const written = await writeAskLater({
    sessionId: input.sessionId,
    userId: input.userId,
    expectedLabel: input.expectedLabel,
    until: null,
    db: input.db ?? defaultDb,
  });
  return { cleared: written !== null };
}
