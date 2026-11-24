/**
 * The gate proposals of a narrowed `work` answer that the calling key may
 * read (`status-of-narrowed-work.ts` keeps a gate's proposal only then).
 */
import { inArray, proposals } from "@synap/database";
import { statusAccess } from "./status-floor.js";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every gate proposal id the answers name. */
function gateProposalIds(answers: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const a of answers) {
    const work = isRec(a) ? a.work : undefined;
    if (!isRec(work) || !Array.isArray(work.items)) continue;
    for (const item of work.items) {
      const gates = isRec(item) ? item.gates : undefined;
      if (!isRec(gates) || !Array.isArray(gates.items)) continue;
      for (const g of gates.items)
        if (isRec(g) && typeof g.proposalId === "string") ids.add(g.proposalId);
    }
  }
  return [...ids];
}

/**
 * The gate proposals of these answers that THIS key may read: the access
 * layer's own rule for `proposals` (`statusAccess`, `scopedDb`), which ANDs
 * the key's grant (a space pin, `proposal.read`). THROWS on a failed read:
 * the caller answers an error, never an answer with every gate shown.
 */
export async function readableWorkProposalIds(
  userId: string,
  answers: readonly unknown[]
): Promise<Set<string>> {
  const ids = gateProposalIds(answers);
  if (ids.length === 0) return new Set();
  const rows = await statusAccess(userId).findMany<{ id: string }>(proposals, {
    where: inArray(proposals.id, ids),
    columns: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}
