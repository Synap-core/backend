/**
 * The lens an answer reports — `lens: { filter, boost, source }` on `ask`'s
 * envelope, on every door that returns it (MCP `synap_ask`, Hub
 * `/knowledge/search` + `/knowledge/answer`, tRPC `knowledge.search` +
 * `knowledge.answer`). PURE, and kept apart from `resolve-lens.ts` (which reads
 * the DB) so `ask()` can build it without that module's imports.
 */

/** What only RE-ORDERS recall: the calling agent's declared focus. */
export interface KnowledgeFocus {
  workspaceId: string | null;
  projectId: string | null;
  source: "agent_focus";
}

/** The lens an answer reports (`lens` on ask's envelope): what was applied. */
export interface AppliedLens {
  /** What NARROWED recall — the scope the caller passed (null = pod-wide). */
  filter: { workspaceId: string | null; projectId: string | null };
  /** What only RE-ORDERED recall; null when nothing was boosted. */
  boost: { workspaceId: string | null; projectId: string | null } | null;
  /** Where the boost came from. */
  source: KnowledgeFocus["source"] | "none";
}

/** The `lens` block an answer carries, from what recall actually ran with. */
export function describeAppliedLens(
  filter: { workspaceId?: string | null; projectId?: string | null },
  focus: KnowledgeFocus | null | undefined
): AppliedLens {
  return {
    filter: {
      workspaceId: filter.workspaceId ?? null,
      projectId: filter.projectId ?? null,
    },
    boost: focus
      ? { workspaceId: focus.workspaceId, projectId: focus.projectId }
      : null,
    source: focus ? focus.source : "none",
  };
}
