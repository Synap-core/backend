/**
 * A computer's WAKER (plan v2 slice 4; finding 252fef7b): what can start the
 * agents on a computer when work is handed to them, read by THE wake rule
 * (`deriveAgentWake`, rules 9-12) through the hand-off roster.
 *
 * Two facts, each owned elsewhere, never a second mechanism:
 *   - `online`      the WAKE LEASE: a process on the computer's OWN key polled
 *                   as its waker (`X-Synap-Runner: synap-waker/<v>`, the same
 *                   per-key stamp a worker leaves, `worker-served.ts`) within
 *                   {@link WAKE_LEASE_MS}. The waker polls every 30 s, so a
 *                   lease is renewed four times before it lapses; the 15-min
 *                   pull window stays the agents' own;
 *   - `wakesAgents` the computer's "Wakes agents" switch, the person's act
 *                   (`machines.setWakesAgents`, `agentMetadata.wakesAgents`).
 * `null` = no waker ever stamped this computer: nothing on it can start agents.
 */

import { apiKeys, db, inArray } from "@synap/database";
import type { AgentMetadata } from "@synap/database/schema";
import type { ComputerWaker } from "./agent-dispatch/agent-wake.js";

/** How long a waker's last poll keeps its computer `online`. */
export const WAKE_LEASE_MS = 2 * 60_000;

/** The waker of one computer, from its two facts. Pure. */
export function computerWakerOf(
  p: { wakerSeenAt: Date | null; wakesAgents: boolean },
  now: Date
): ComputerWaker | null {
  if (!p.wakerSeenAt) return null;
  return {
    online: now.getTime() - p.wakerSeenAt.getTime() <= WAKE_LEASE_MS,
    wakesAgents: p.wakesAgents,
  };
}

/**
 * The newest waker stamp over each computer's own keys, whatever their type
 * (the device-flow key is a `user_pat`, `machine-connect.ts`): the same keys
 * the Computers roster reads (`machine-roster.ts`), so pod admin and the
 * hand-off roster never disagree. `worker_served_at` on a COMPUTER's key is
 * only ever its waker's (a worker runs on an agent's key). One read for every
 * computer of a roster. A failed read throws.
 */
export async function loadWakerSeenAt(
  machineUserIds: readonly string[]
): Promise<Map<string, Date>> {
  const ids = [...new Set(machineUserIds)].filter(Boolean);
  const out = new Map<string, Date>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: apiKeys.userId, servedAt: apiKeys.workerServedAt })
    .from(apiKeys)
    .where(inArray(apiKeys.userId, ids));
  for (const r of rows) {
    if (!r.servedAt) continue;
    const cur = out.get(r.userId);
    if (!cur || r.servedAt > cur) out.set(r.userId, r.servedAt);
  }
  return out;
}

/** The "Wakes agents" switch, read off the computer's metadata. */
export function wakesAgentsOf(meta: unknown): boolean {
  return (meta as AgentMetadata | null)?.wakesAgents === true;
}
