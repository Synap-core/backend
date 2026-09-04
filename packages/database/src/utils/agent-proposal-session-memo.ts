/**
 * ONE-PER-REQUEST memo over `resolveOrCreateAgentProposalSession`.
 *
 * WHY THIS EXISTS. The ambient agent-session mint used to run only inside the
 * PENDING-proposal path (`createPendingProposalRow`), so an AUTO-APPROVED agent
 * write carried no `sessionId` at all — measured 2026-09-03 at 2.6% session
 * coverage across 2961 proposals. Hoisting the mint to a point BOTH governance
 * branches pass through fixes the coverage, but it also puts the resolver on the
 * hot path: a single capture can auto-approve ~1600 `entity.create` rows, and
 * the resolver costs up to two queries plus a possible `openRunSession` INSERT
 * per call.
 *
 * So the resolution is memoized on the identity that DECIDES it — the same
 * tuple the resolver's own reuse ladder keys on (operator + agent + workspace +
 * project + normalized goal). Every row of one burst shares that tuple, so the
 * resolver runs ONCE and the remaining rows read the memo.
 *
 * DELIBERATE PROPERTIES
 *  - TTL-bounded (60s). A session closed out-of-band goes stale for at most one
 *    TTL; grouping is a best-effort hint, never an authorization input, so a
 *    stale hit costs a mis-grouped row, never a wrong permission decision.
 *  - Size-bounded (500 entries, oldest evicted). This is a process-local cache
 *    in a long-lived API worker; unbounded would be a slow leak.
 *  - NEGATIVE results are memoized too. The resolver returns `null` on an empty
 *    goal or a failed mint, and re-attempting that per row is precisely the
 *    stampede this memo exists to prevent.
 *  - In-flight promises are shared, so concurrent rows of the same burst await
 *    ONE resolution instead of racing N mints.
 */

import {
  resolveOrCreateAgentProposalSession,
  type ResolveOrCreateAgentProposalSessionInput,
} from "./resolve-or-create-agent-proposal-session.js";

/** How long a resolved session id stays reusable without re-querying. */
const MEMO_TTL_MS = 60_000;
/** Hard cap on retained entries (oldest-first eviction). */
const MEMO_MAX_ENTRIES = 500;

interface MemoEntry {
  expiresAt: number;
  value: Promise<string | null>;
}

const memo = new Map<string, MemoEntry>();

function memoKey(input: ResolveOrCreateAgentProposalSessionInput): string {
  return [
    input.userId,
    input.agentUserId,
    input.workspaceId ?? "",
    input.projectId ?? "",
    input.stableCorrelation && input.correlationId ? input.correlationId : "",
    input.goal.replace(/\s+/g, " ").trim().slice(0, 240),
  ].join("|");
}

function evictExpired(now: number): void {
  for (const [key, entry] of memo) {
    if (entry.expiresAt <= now) memo.delete(key);
  }
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
}

/**
 * Resolve the agent's proposal-packaging session, at most once per
 * (operator, agent, workspace, project, goal) per {@link MEMO_TTL_MS}.
 *
 * Same contract as `resolveOrCreateAgentProposalSession`: best-effort, never
 * throws, `null` when no session could be resolved or minted.
 */
export async function resolveAgentProposalSessionOnce(
  input: ResolveOrCreateAgentProposalSessionInput
): Promise<string | null> {
  const now = Date.now();
  const key = memoKey(input);
  const hit = memo.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = resolveOrCreateAgentProposalSession(input);
  memo.set(key, { expiresAt: now + MEMO_TTL_MS, value });
  evictExpired(now);
  return value;
}

/** Test seam — drops every memoized resolution. Never called in production. */
export function __resetAgentProposalSessionMemo(): void {
  memo.clear();
}
