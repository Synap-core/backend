/**
 * The VERB a proposal row performs — the ONE reading every request builder,
 * receipt writer and renderer shares.
 *
 * WHY THIS EXISTS. A proposal row says its verb in up to three places, and
 * the readers used to pick one and default the rest: `buildRequestFromProposal`
 * read only the envelope's `changeType` and fell back to `"update"`. An
 * auto-approved receipt is written FLAT with a dotted `proposalType`
 * (`entity.create`, `focus_session.create`, `facet.attach`) and no
 * `changeType`, so every receipt — a created entity, a started session, a
 * connected agent — read "Update". Pure.
 *
 * ORDER (first that exists wins):
 *   1. the dotted `proposalType`'s tail — `entity.create` → `create`,
 *      `capability.enable` → `enable`, `entity.transition` → `move`;
 *   2. the envelope's stored `changeType`;
 *   3. a bare `proposalType` (the column stores the bare verb: `run`, `create`);
 *   4. `"update"` — only when the row says nothing at all.
 */

/** Stored verbs renamed to the word the vocabulary speaks. */
const ACTION_ALIASES: Readonly<Record<string, string>> = {
  // A lifecycle move is stored as `transition` (the event), said as "move".
  transition: "move",
};

function normalize(verb: string): string {
  const v = verb.trim();
  return ACTION_ALIASES[v] ?? v;
}

/** The verb a proposal row performs (see the file header for the order). */
export function resolveProposalAction(row: {
  proposalType?: string | null;
  /** The stored envelope (`proposals.data`); only `changeType` is read. */
  data?: unknown;
}): string {
  const proposalType =
    typeof row.proposalType === "string" ? row.proposalType.trim() : "";
  const dot = proposalType.lastIndexOf(".");
  if (dot > 0 && dot < proposalType.length - 1) {
    return normalize(proposalType.slice(dot + 1));
  }
  const envelope =
    row.data && typeof row.data === "object"
      ? (row.data as Record<string, unknown>)
      : undefined;
  const stored = envelope?.changeType;
  if (typeof stored === "string" && stored.trim()) return normalize(stored);
  if (proposalType) return normalize(proposalType);
  return "update";
}
