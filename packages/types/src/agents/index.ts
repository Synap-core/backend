/**
 * Agent connection — the ONE rule for "has an agent reached this pod, and
 * which one was seen last".
 *
 * Browser Home (the "Connect your agent" invite) and Relay's first-run screen
 * ("Your agents can reach you here") both answer this question. They read the
 * same `agentUsers.list` rows and must never disagree, so the rule lives here
 * and neither surface re-derives it.
 *
 * Zero imports on purpose: this leaf is loaded by Electron, React Native and
 * Node alike.
 */

/** The slice of an `agentUsers.list` row this rule reads. */
export interface AgentPresenceLike {
  id: string;
  name: string | null;
  /**
   * When the agent last called the pod. `null` / absent = it never has.
   * A string is accepted because tRPC without a transformer serialises dates.
   */
  lastSeenAt?: Date | string | null;
}

export type AgentConnection =
  /** No agent has ever called the pod. */
  | { kind: 'never' }
  /** At least one agent has; `agent` is the one seen most recently. */
  | {
      kind: 'seen';
      agent: { id: string; name: string | null; lastSeenAt: Date };
      /** How many OTHER agents have also been seen. */
      others: number;
    };

function seenAt(value: AgentPresenceLike['lastSeenAt']): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolve the connection state from the roster rows.
 *
 * A row whose timestamp cannot be parsed counts as not seen: it proves
 * nothing, and "seen" is the state that hides the invite.
 */
export function resolveAgentConnection(
  rows: readonly AgentPresenceLike[],
): AgentConnection {
  let latest: { row: AgentPresenceLike; at: Date } | null = null;
  let seenCount = 0;
  for (const row of rows) {
    const at = seenAt(row.lastSeenAt);
    if (!at) continue;
    seenCount += 1;
    if (!latest || at.getTime() > latest.at.getTime()) latest = { row, at };
  }
  if (!latest) return { kind: 'never' };
  return {
    kind: 'seen',
    agent: { id: latest.row.id, name: latest.row.name, lastSeenAt: latest.at },
    others: seenCount - 1,
  };
}
