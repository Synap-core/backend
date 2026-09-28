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

/**
 * The one command that connects a person's own agents (Claude Code, Codex,
 * Cursor…) to their pod. Every surface that invites them to connect shows this
 * exact string, so the copy cannot drift from what the CLI accepts.
 */
export const AGENT_CONNECT_COMMAND = "npx @synap-core/cli init";

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
  /** No agent has ever called the pod (or the pod has no agents at all). */
  | { kind: "never" }
  /**
   * The pod has agents but does not report when they were last seen (a pod
   * older than the `lastSeenAt` field). NOT "never": nobody measured it.
   */
  | { kind: "unmeasured" }
  /** At least one agent has; `agent` is the one seen most recently. */
  | {
      kind: "seen";
      agent: { id: string; name: string | null; lastSeenAt: Date };
      /** How many OTHER agents have also been seen. */
      others: number;
    };

function seenAt(value: AgentPresenceLike["lastSeenAt"]): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Resolve the connection state from the roster rows.
 *
 * A row whose timestamp cannot be parsed counts as not seen: it proves
 * nothing, and "seen" is the state that hides the invite. Rows that do not
 * carry the field at all are `unmeasured`, never `never`: an older pod cannot
 * tell, and saying "no agent connected" to someone whose agent is working
 * would be a calm, wrong screen.
 */
export function resolveAgentConnection(
  rows: readonly AgentPresenceLike[]
): AgentConnection {
  let latest: { row: AgentPresenceLike; at: Date } | null = null;
  let seenCount = 0;
  for (const row of rows) {
    const at = seenAt(row.lastSeenAt);
    if (!at) continue;
    seenCount += 1;
    if (!latest || at.getTime() > latest.at.getTime()) latest = { row, at };
  }
  if (!latest) {
    const measured =
      rows.length === 0 || rows.some((row) => "lastSeenAt" in row);
    return measured ? { kind: "never" } : { kind: "unmeasured" };
  }
  return {
    kind: "seen",
    agent: { id: latest.row.id, name: latest.row.name, lastSeenAt: latest.at },
    others: seenCount - 1,
  };
}

// ---------------------------------------------------------------------------
// Agent WRITE MODE — how an agent's writes land, as ONE rule + ONE sentence.
// ---------------------------------------------------------------------------

/**
 * How one agent's writes land (founder, 2026-09-28: "reversible writes act"):
 *  - `pod-default`      — creates and edits apply directly with Undo;
 *  - `create-with-undo` — only creates apply directly (a stricter preset);
 *  - `ask-first`        — every change asks (the agent's "Require approval"
 *                          override, or the pod default switched off for a
 *                          strict agent).
 * Deletions and structural changes ask in every mode (engine floors).
 */
export type AgentWriteMode = "pod-default" | "create-with-undo" | "ask-first";

export interface AgentWriteModeInput {
  /** The agent's named override (`agentMetadata.governancePosture`), if any. */
  posture: string | null | undefined;
  /** Is the pod default (`@reversible` rule) on? */
  podDefaultEnabled: boolean;
  /** Legacy rung-5 flag — only matters when the pod default is off. */
  writesRequireProposal: boolean;
}

/** The ONE derivation — the pod computes it, every surface reads it. */
export function resolveAgentWriteMode(
  input: AgentWriteModeInput
): AgentWriteMode {
  if (input.posture === "ask-first") return "ask-first";
  if (input.posture === "create-with-undo") return "create-with-undo";
  if (input.podDefaultEnabled) return "pod-default";
  // Pod default off: a strict agent proposes everything; a non-strict one
  // (twin / capture) keeps the platform floor's creates and edits.
  return input.writesRequireProposal ? "ask-first" : "pod-default";
}

/** The ONE sentence per mode — summary line and switch caption both read it. */
export const AGENT_WRITE_MODE_LINE: Record<AgentWriteMode, string> = {
  "pod-default":
    "Creates and edits apply directly with Undo; deletions and structural changes ask you.",
  "create-with-undo":
    "Creates apply directly with Undo; edits, deletions and structural changes ask you.",
  "ask-first": "Every change asks you first.",
};
