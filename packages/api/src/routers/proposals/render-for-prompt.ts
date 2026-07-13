/**
 * renderProposalForPrompt — a DB-light leaf (no router side effects).
 *
 * Renders a proposal as a compact prompt block for an AI thread bound to it
 * (`contextObjectType:'proposal'`, the on-demand "discuss/refine this proposal"
 * flow). It flattens `data.operations` (composite/graph) into readable lines so
 * the agent "sees" what it may refine, WITHOUT the heavy review-model machinery
 * (events, roles, title resolution) — the agent can call read tools for detail.
 *
 * Kept as a leaf (not in the `proposals.ts` router) so `getThreadContext` can
 * import it without dragging the router's import-time `registerApproveExecutors()`
 * side effect onto the hot IS context path. Mirrors the `graph-dispositions.ts`
 * extraction pattern.
 */
import { db, eq, proposals } from "@synap/database";
import {
  isCompositeProposalData,
  type StoredProposalData,
  type CompositeProposalData,
} from "@synap-core/types/proposals";

export interface ProposalPromptContext {
  id: string;
  status: string;
  summary: string | null;
  rendered: string;
}

export async function renderProposalForPrompt(
  proposalId: string
): Promise<ProposalPromptContext | null> {
  const row = await db.query.proposals.findFirst({
    where: eq(proposals.id, proposalId),
  });
  if (!row) return null;
  const raw = row.data as StoredProposalData | null | undefined;
  const summary =
    (raw && typeof raw === "object" && "summary" in raw
      ? ((raw as { summary?: unknown }).summary as string | undefined)
      : undefined) ?? null;
  const lines: string[] = [];
  if (isCompositeProposalData(raw)) {
    const ops = (raw as CompositeProposalData).operations ?? [];
    let rel = 0;
    for (const op of ops as unknown as Array<Record<string, unknown>>) {
      if (op.op === "create_relation") {
        rel += 1;
        lines.push(
          `- $rel${rel}: link ${String(op.sourceRef)} --[${String(op.type)}]--> ${String(op.targetRef)}`
        );
      } else if (op.op === "create_entity") {
        const label = op.existingEntityId
          ? `use existing ${String(op.profileSlug)}`
          : `create ${String(op.profileSlug)}`;
        const ref = op.ref ? ` (ref ${String(op.ref)})` : "";
        lines.push(`- ${label}: "${String(op.title ?? "")}"${ref}`);
      }
    }
  }
  const rendered = [
    `Proposal ${row.id} — status: ${row.status}`,
    summary ? `Summary: ${summary}` : null,
    lines.length ? `Operations:\n${lines.join("\n")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { id: row.id, status: row.status, summary, rendered };
}
