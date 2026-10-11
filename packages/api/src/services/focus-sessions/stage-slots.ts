/**
 * Stage-level outputs → session slots, on stage ENTRY.
 *
 * A playbook stage may declare its own `expectedOutputs` (Content OS "Produce
 * Content" › Draft owes a `content-composition`, `made_for` its subject). A
 * track stage session receives them (`tracks-service.ts`), but a normal run of
 * the playbook only ever received the PLAYBOOK-level slots: the stage's slots
 * were never owed, so nothing produced them and their `relationToSubject` edge
 * (`subject-edge.ts`, written when a slot is satisfied) was never written.
 *
 * Entering a stage now MERGES that stage's declared outputs into the session's
 * slots — the same merge a followed playbook's slots take (`follow-playbook.ts`):
 * declarations sanitized through the ONE floor, added only when the session
 * does not already carry the slot (same key, or same label), every stored
 * slot echoed verbatim so its receipts survive. A slot is never removed on
 * leaving a stage: what a stage owed stays owed.
 *
 * Two entry points, one rule ({@link stageSlotsToAdd}): the run's birth seeds
 * its first stage (`playbook-lifecycle.ts`), and every advance goes through
 * `advanceSessionStage`, which calls {@link mergeEnteredStageSlots}.
 */

import { db, focusSessions, eq } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./expected-label.js";
import { deriveSlotKeys } from "./slot-keys.js";
import {
  mergeExpectedOutputs,
  sanitizeDeclaredOutputs,
} from "./update-session.js";

/** The declared outputs of stage `stageKey`, or [] (unknown stage, none declared). */
function declaredStageOutputs(
  stages: unknown,
  stageKey: string | null
): ExpectedOutput[] {
  if (!stageKey || !Array.isArray(stages)) return [];
  const stage = stages.find(
    (s) =>
      !!s && typeof s === "object" && (s as { key?: unknown }).key === stageKey
  ) as { expectedOutputs?: unknown } | undefined;
  return Array.isArray(stage?.expectedOutputs)
    ? (stage.expectedOutputs as ExpectedOutput[])
    : [];
}

/**
 * The entered stage's slots the session does not carry yet — sanitized, ready
 * to append. Matched by declared `key` against the stored slots' keys, and by
 * label (trim + casefold), so entering a stage twice owes nothing twice.
 */
export function stageSlotsToAdd(
  stages: unknown,
  stageKey: string | null,
  current: readonly ExpectedOutput[]
): ExpectedOutput[] {
  const declared = declaredStageOutputs(stages, stageKey);
  if (declared.length === 0) return [];
  const keys = new Set(deriveSlotKeys(current).filter((k): k is string => !!k));
  const labels = new Set(
    current.map((o) => normalizeExpectedLabel(o?.label)).filter(Boolean)
  );
  const fresh: ExpectedOutput[] = [];
  for (const o of declared) {
    const label = normalizeExpectedLabel(o?.label);
    if (!label || labels.has(label)) continue;
    const key = (o as { key?: unknown }).key;
    if (typeof key === "string" && keys.has(key)) continue;
    labels.add(label);
    fresh.push(o);
  }
  return sanitizeDeclaredOutputs(fresh);
}

/**
 * Merge the entered stage's declared outputs into the session's slots, under
 * the session row lock. `stages` is the run's own stage list (its definition
 * snapshot, as `loadSessionProcess` reads it). Returns the labels it added.
 */
export async function mergeEnteredStageSlots(input: {
  sessionId: string;
  stageKey: string;
  stages: unknown;
}): Promise<{ added: string[] }> {
  if (declaredStageOutputs(input.stages, input.stageKey).length === 0) {
    return { added: [] };
  }
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, input.sessionId))
      .for("update");
    if (!locked) return { added: [] };
    const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const added = stageSlotsToAdd(input.stages, input.stageKey, current);
    if (added.length === 0) return { added: [] };
    const next = mergeExpectedOutputs(current, [...current, ...added]);
    await tx
      .update(focusSessions)
      .set({ expectedOutputs: next, updatedAt: new Date() })
      .where(eq(focusSessions.id, input.sessionId));
    return { added: added.map((o) => o.label) };
  });
}
