/**
 * REACH — what something that acts on its own can touch outside the pod, and
 * the ONE set of words every surface says it with.
 *
 * Two readers share these words: the marketplace preflight (what a package
 * brings: "Can reach: api.acme.test", "Uses your existing Gmail connection")
 * and the review of a mixed proposal (what each part that acts on its own can
 * reach once approved). The pod's review projection measures a part's reach
 * (`buildProposalGraph`, `ProposalReviewGraph.automations[].reach` and
 * `.updates[].reach`); the web desk, the phone and pod-admin draw it through
 * {@link partReachWords}, so the three never say it differently.
 *
 * Pure and dependency-free.
 */

/**
 * What a part can reach outside the pod, as the pod read it for this review.
 *
 * Measured, never guessed: a step the pod could not read (a verb the viewer
 * cannot see, a URL built while it runs, another automation it starts) is
 * COUNTED in `unreadSteps`, so a surface never turns "could not tell" into
 * "reaches nothing". An absent `reach` on a part means the pod did not
 * measure it (an older pod): draw nothing, never "nothing outside your pod".
 */
export interface ProposalPartReach {
  /**
   * Hosts it may call directly: a code skill's `allowedHosts`, a fetch or
   * webhook step's URL host, a provider verb's fixed base URL.
   */
  hosts: string[];
  /**
   * Services whose EXISTING connection on this pod it uses, by name
   * ("Apify"): the provider a declarative verb calls through.
   */
  connections: string[];
  /** Steps whose reach could not be read. Non-zero: the lists may be short. */
  unreadSteps: number;
}

/** The label of the reach fact, on every surface. */
export const CAN_REACH_LABEL = "Can reach";

/** "Gmail" / "Gmail and Slack" / "Gmail, Notion and Slack". */
export function joinNames(names: readonly string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "my existing Gmail connection" / "your existing Gmail and Slack connections". */
export function existingConnections(
  names: readonly string[],
  owner: "my" | "your"
): string {
  return `${owner} existing ${joinNames(names)} connection${names.length === 1 ? "" : "s"}`;
}

/** "Can reach: api.acme.test, hooks.acme.test" — the preflight's line. */
export function canReachLine(hosts: readonly string[]): string {
  return `${CAN_REACH_LABEL}: ${hosts.join(", ")}`;
}

/**
 * The value of a part's "Can reach" fact:
 *   - "api.apify.com, your existing Apify connection"
 *   - "Nothing outside your pod" (measured, every step read)
 *   - "api.apify.com; not known for 1 step" / "Not known for 2 steps"
 */
export function partReachWords(reach: ProposalPartReach): string {
  const known = [
    ...reach.hosts,
    ...(reach.connections.length
      ? [existingConnections(reach.connections, "your")]
      : []),
  ].join(", ");
  if (reach.unreadSteps <= 0) return known || "Nothing outside your pod";
  const n = reach.unreadSteps;
  const unread = `not known for ${n} ${n === 1 ? "step" : "steps"}`;
  return known
    ? `${known}; ${unread}`
    : `${unread.charAt(0).toUpperCase()}${unread.slice(1)}`;
}
