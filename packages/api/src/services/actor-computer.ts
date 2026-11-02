/**
 * WHICH COMPUTER an actor is named by — the ONE attribution order (plan v2
 * S10, "computers and adjuncts"): the computer the agent runs on
 * (`users.host_user_id` → the machine's name) first; else the label of a key
 * it used (`api_keys.instance_label`), which only says where it was LAST SEEN.
 * A key label is something a client sent, not where the agent runs, so it is
 * never worded "on <computer>".
 *
 * Read by every reader that names an actor with a computer: the proposal
 * surfaces (`actorDisplayName`), the session and goal rosters through it, and
 * the hand-off picker (`agents-for-handoff.ts`).
 */
import { agentDisplayName } from "@synap-core/types/agents";

export type ActorComputer =
  { source: "host"; name: string } | { source: "key"; name: string };

export function actorComputer(p: {
  /** The name of the computer the agent runs on (`host_user_id`), if any. */
  hostName?: string | null;
  /** The label of the key it used, if any. */
  keyLabel?: string | null;
}): ActorComputer | null {
  const host = p.hostName?.trim();
  if (host) return { source: "host", name: host };
  const key = p.keyLabel?.trim();
  return key ? { source: "key", name: key } : null;
}

/** "Claude Code on devbox" for its host; "Claude Code, last seen on MacBook" for a key label. */
export function nameWithComputer(
  name: string | null | undefined,
  computer: ActorComputer
): string {
  return computer.source === "host"
    ? agentDisplayName({ name, hostName: computer.name })
    : `${agentDisplayName({ name })}, last seen on ${computer.name}`;
}
