"use client";

/**
 * A document's links to its proposals (§B3): where it came from ("Created
 * from a proposal · approved by Antoine, 2 Nov 2026") and what waits on it
 * ("2 changes waiting"), each a door to its proposal page. Words and rules
 * live in `document-lineage-model.ts`; this only reads and draws.
 *
 * Read door: `proposals.list({ subject })`, the viewer's own floor — every
 * proposal ABOUT the document they may see, the creating one pinned on the
 * first page. A failed read draws nothing: the document is the page, and
 * the lineage is a footnote to it.
 */

import Link from "next/link";
import { trpc } from "../../../lib/trpc";
import { documentLineage } from "./document-lineage-model";

/** Proposals read: the creating one is pinned whatever the page holds. */
const LINEAGE_LIMIT = 50;

const LINK_CLASS =
  "break-words rounded-sm text-[13px] text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function DocumentLineage({
  documentId,
  sourceProposalId,
}: {
  documentId: string;
  sourceProposalId: string | null | undefined;
}) {
  const list = trpc.proposals.list.useQuery(
    {
      subject: { kind: "document", id: documentId },
      status: "all",
      limit: LINEAGE_LIMIT,
    },
    { staleTime: 30_000, retry: false }
  );
  if (list.isLoading) return null;
  const lineage = documentLineage(
    sourceProposalId,
    list.error ? [] : (list.data?.items ?? [])
  );
  if (!lineage.createdFrom && !lineage.waitingLabel) return null;
  return (
    <section
      aria-label="Proposals about this document"
      className="flex flex-col gap-2 text-[13px] text-foreground/75"
    >
      {lineage.createdFrom && (
        <p>
          <Link href={lineage.createdFrom.href} className={LINK_CLASS}>
            {lineage.createdFrom.line}
          </Link>
        </p>
      )}
      {lineage.waitingLabel && (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-foreground">{lineage.waitingLabel}</p>
          <ul className="flex flex-col gap-1">
            {lineage.waiting.map((w) => (
              <li key={w.id}>
                <Link href={w.href} className={LINK_CLASS}>
                  {w.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
