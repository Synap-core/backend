/**
 * Work guidelines for a BLOCKED slot — the read half of the compounding loop.
 *
 * Approving a `governance.work_guideline` proposal writes a `config_settings`
 * guideline scoped `workKind = <blockedReason>` (apply-approval.ts). Before this
 * module nothing ever READ one: `resolveGuidelines` matches a `workKind` row only
 * when the caller passes `workKind`, and no caller did — so an approval produced
 * a success receipt and changed nothing an agent could see.
 *
 * Two consumers, ONE lookup ({@link findWorkGuidelines}), no second matcher:
 *
 *   1. THE READ DOOR — an agent asks "is there standing guidance for this kind
 *      of block?" BEFORE declaring a human block (Hub REST `GET /guidelines`,
 *      taught in the `focus-sessions` skill). This is the primary path: the
 *      guideline is stored config and the agent is taught to consult it.
 *   2. THE SAFETY NET — every door that makes a slot human-owned with a
 *      `blockedReason` calls {@link guidanceForBlockedSlots} and returns any
 *      match beside its result, so an agent that skipped step 1 still hears
 *      "a guideline covers this" in the same response.
 *
 * WHAT A GUIDELINE DOES NOT DO (founder decisions, binding):
 *   - It never stops the slot being filed and never retires one. It annotates;
 *     the block has already landed when the note is attached.
 *   - It never votes in governance. `workKind` is deliberately NOT threaded into
 *     `resolveAgentGovernanceDecision`.
 *
 * FAILURE IS NOT "NO GUIDELINE". {@link findWorkGuidelines} throws on a failed
 * read so the read door can answer an error. The safety net must not fail the
 * block it rides on, so it logs and returns `status: "unavailable"` — a caller
 * can tell "looked, nothing applies" (no field) from "could not look".
 */

import { db, resolveGuidelines } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { BlockedReason, ExpectedOutput } from "@synap/playbooks";
import { normalizeExpectedLabel } from "./satisfy-expected-output.js";

const logger = createLogger({ module: "block-guidelines" });

/** One standing guideline for a kind of work, as an agent reads it. */
export interface WorkGuideline {
  id: string;
  text: string;
}

/**
 * The guidance attached to a block response. ABSENT when no lookup ran or
 * nothing matched — present only when there is something to say.
 */
export type BlockGuidance =
  | {
      status: "matched";
      matches: Array<{
        expectedLabel: string;
        blockedReason: BlockedReason;
        guidelines: WorkGuideline[];
        /** The sentence to relay: the slot is filed, and here is the guidance. */
        message: string;
      }>;
    }
  | { status: "unavailable"; message: string };

/**
 * The `workKind` guidelines that apply to one kind of block, in the caller's
 * lens. THE one lookup both consumers share. Throws on a failed read.
 *
 * Filtered to `scopeKind === "workKind"`: `resolveGuidelines` also returns
 * `default` rows (they match every context), and those are interpret-pass
 * instructions about messages, not standing guidance about this class of work.
 */
export async function findWorkGuidelines(params: {
  userId: string;
  workspaceId: string | null;
  blockedReason: BlockedReason;
}): Promise<WorkGuideline[]> {
  const resolved = await resolveGuidelines({
    db,
    userId: params.userId,
    workspaceId: params.workspaceId,
    workKind: params.blockedReason,
  });
  return resolved
    .filter((g) => g.scopeKind === "workKind")
    .map((g) => ({ id: g.id, text: g.text }));
}

/** A slot the caller has just made the human's, with its classified blocker. */
export interface BlockedSlotRef {
  label: string;
  owner?: ExpectedOutput["owner"];
  blockedReason?: ExpectedOutput["blockedReason"];
}

/**
 * The slots in `after` that are human-owned with a `blockedReason` and were NOT
 * already human-blocked for that same reason in `before` — i.e. the blocks this
 * write DECLARED. A re-sent array that merely echoes an old block is not a new
 * declaration and earns no second note. Pure.
 */
export function newlyBlockedSlots(
  before: readonly ExpectedOutput[] | null | undefined,
  after: readonly ExpectedOutput[] | null | undefined
): BlockedSlotRef[] {
  const prior = new Map<string, ExpectedOutput>();
  for (const o of before ?? []) {
    const key = normalizeExpectedLabel(o.label);
    if (key && !prior.has(key)) prior.set(key, o);
  }
  return (after ?? [])
    .filter((o) => o.owner === "human" && !!o.blockedReason)
    .filter((o) => {
      const was = prior.get(normalizeExpectedLabel(o.label) ?? "");
      return !(was?.owner === "human" && was.blockedReason === o.blockedReason);
    })
    .map((o) => ({
      label: o.label,
      owner: o.owner,
      blockedReason: o.blockedReason,
    }));
}

/**
 * THE SAFETY NET. Given the slots a write just blocked on the human, return the
 * guidance to attach to that write's response — or `undefined` when there is
 * nothing to say.
 *
 * No lookup at all for a slot that is agent-owned or carries no
 * `blockedReason`; one lookup per distinct reason otherwise. Never throws.
 */
export async function guidanceForBlockedSlots(params: {
  userId: string;
  workspaceId: string | null;
  slots: readonly BlockedSlotRef[];
}): Promise<BlockGuidance | undefined> {
  const blocked = params.slots.filter(
    (s): s is BlockedSlotRef & { blockedReason: BlockedReason } =>
      s.owner === "human" && !!s.blockedReason
  );
  if (blocked.length === 0) return undefined;

  const byReason = new Map<BlockedReason, WorkGuideline[]>();
  try {
    for (const reason of new Set(blocked.map((s) => s.blockedReason))) {
      byReason.set(
        reason,
        await findWorkGuidelines({
          userId: params.userId,
          workspaceId: params.workspaceId,
          blockedReason: reason,
        })
      );
    }
  } catch (err) {
    logger.warn(
      { err, userId: params.userId, workspaceId: params.workspaceId },
      "work-guideline lookup failed — block kept, guidance unavailable"
    );
    return {
      status: "unavailable",
      message:
        "The slot was handed to the human, but standing guidelines for this kind of block could not be read. Check them before relying on this block being the only option.",
    };
  }

  const matches = blocked.flatMap((s) => {
    const guidelines = byReason.get(s.blockedReason) ?? [];
    if (guidelines.length === 0) return [];
    return [
      {
        expectedLabel: s.label,
        blockedReason: s.blockedReason,
        guidelines,
        message: `"${s.label}" is filed on the human, and a guideline covers ${s.blockedReason} blocks: ${guidelines
          .map((g) => g.text)
          .join(
            " / "
          )}. If it tells you how to proceed, do so and reclaim the slot.`,
      },
    ];
  });
  return matches.length > 0 ? { status: "matched", matches } : undefined;
}
