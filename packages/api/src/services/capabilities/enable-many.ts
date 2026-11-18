/**
 * Turn several verbs and tools of a capability ON with ONE confirmation
 * (founder, 18 Nov 2026: "turn all on" asked a passkey per tool).
 *
 * The gate is asked ONCE, for `capability_batch:<presenceBatchId>`: the id is
 * a digest of the exact, sorted set, so a proof made for one set never turns
 * on another (add, drop or swap one id and it no longer fits), and it is
 * spent once like every proof. Each item then goes through the SAME body as
 * its single door (`setSkillApproved`, `setToolApproved`), so the owner
 * checks are per item, exactly as before: an item the caller may not turn on
 * is reported, and the others still apply. Nothing is swallowed: every item
 * comes back with its own result.
 *
 * Approval is the human step: an acting agent is refused before the gate.
 */
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  PRESENCE_BATCH_MAX,
  presenceBatchId,
  type PresenceProof,
} from "@synap-core/types/presence";
import { assertPresenceForRequest } from "../presence/gate.js";
import { refuseAgentApprover, setSkillApproved } from "./set-skill-approved.js";
import { setToolApproved } from "./set-tool-approved.js";

const logger = createLogger({ module: "enable-many" });

export type EnableManyItemResult =
  | { kind: "skill" | "tool"; id: string; ok: true }
  | { kind: "skill" | "tool"; id: string; ok: false; error: string };

export async function enableMany(input: {
  userId: string;
  skillIds: readonly string[];
  toolIds: readonly string[];
  agentUserId?: string | null;
  presence?: PresenceProof | null;
  door?: string;
}): Promise<{ results: EnableManyItemResult[] }> {
  refuseAgentApprover(input.agentUserId);
  const skillIds = [...new Set(input.skillIds)];
  const toolIds = [...new Set(input.toolIds)];
  const total = skillIds.length + toolIds.length;
  if (total === 0 || total > PRESENCE_BATCH_MAX) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Turn on between 1 and ${PRESENCE_BATCH_MAX} at a time.`,
    });
  }
  // ONE proof for the whole set. It throws like every other gate.
  await assertPresenceForRequest({
    userId: input.userId,
    kind: "capability_batch",
    id: await presenceBatchId({ skillIds, toolIds }),
    proof: input.presence ?? null,
    door: input.door ?? "trpc.capabilities.enableMany",
  });

  const results: EnableManyItemResult[] = [];
  for (const id of skillIds) {
    results.push(
      await one("skill", id, () =>
        setSkillApproved({
          userId: input.userId,
          skillId: id,
          approved: true,
          agentUserId: input.agentUserId,
          presenceChecked: "capabilityBatch",
          door: input.door ?? "trpc.capabilities.enableMany",
        })
      )
    );
  }
  for (const id of toolIds) {
    results.push(
      await one("tool", id, () =>
        setToolApproved({ userId: input.userId, toolId: id, approved: true })
      )
    );
  }
  return { results };
}

async function one(
  kind: "skill" | "tool",
  id: string,
  run: () => Promise<unknown>
): Promise<EnableManyItemResult> {
  try {
    await run();
    return { kind, id, ok: true };
  } catch (err) {
    if (err instanceof TRPCError) {
      return { kind, id, ok: false, error: err.message };
    }
    logger.error({ err, kind, id }, "a batch item failed unexpectedly");
    return {
      kind,
      id,
      ok: false,
      error: "The pod couldn’t turn this one on.",
    };
  }
}
