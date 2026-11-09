/**
 * AWAIT on a `playbook_run` step (runner engine slice 5, spec 7111934d §4):
 * the timeout grammar, read the same way by the flow validator (author time)
 * and the executor (run time).
 */

/** The wait when a node says `await` and names no timeout. */
export const PLAYBOOK_RUN_AWAIT_DEFAULT = "7d";

/** The longest a step may wait for the run it started. */
export const PLAYBOOK_RUN_AWAIT_MAX_MS = 30 * 86_400_000;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * The timeout in milliseconds (`30m`, `12h`, `7d`, `2w`; absent ⇒ 7 days), or
 * null when it is not a duration or is longer than 30 days. Pure.
 */
export function parseAwaitTimeout(raw: unknown): number | null {
  const text =
    raw === undefined || raw === null ? PLAYBOOK_RUN_AWAIT_DEFAULT : raw;
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const ms = parseInt(match[1]!, 10) * UNIT_MS[match[2]!]!;
  return ms > 0 && ms <= PLAYBOOK_RUN_AWAIT_MAX_MS ? ms : null;
}
