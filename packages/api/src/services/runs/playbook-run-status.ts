/**
 * A `playbook_runs.status` → the unified run vocabulary (`RunStatus`).
 *
 * Identity for every value the feed already speaks, except `stale` (D6,
 * 2026-10-11): a run an EXTERNAL agent holds that the reaper found quiet.
 * It projects exactly as a stale SESSION already does in this same feed
 * (`sessionStatus` in ./index.ts) — `cancelled`, the "stopped" reading — so the
 * two halves of one quiet unit of work wear one mark, and the wire vocabulary
 * (`RunStatus`, generated into `@synap/api-types`) does not grow a member.
 * Never `failed`: nothing failed. Never `running`: nothing is moving. The next
 * write to its session revives the row to `running` (`reviveStaleSession`).
 */
import type { RunStatus } from "./types.js";

export function runStatusOfPlaybookRun(status: string): RunStatus {
  return status === "stale" ? "cancelled" : (status as RunStatus);
}
