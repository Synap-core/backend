/**
 * Which objects' own page reads at a document's width: the ONE answer that
 * the object page (`openWidth`, `consoleWidth`) and the review of a proposal
 * that creates or changes one (`reviewReadsWide`) both read. A proposed
 * document opens as wide as the document it becomes (founder, 2026-11-03);
 * a record whose page keeps the default width is reviewed at that width.
 *
 * A document is read, not scanned: its page uses 80% of the window from
 * 1024px, at most 72rem (page grammar §2, founder 2026-10-22). A page that
 * draws a rail (a session) also reads wide, but that is the page's shape,
 * not its kind, so the frames decide it from `rail`, not from here.
 */
const WIDE_KINDS: ReadonlySet<string> = new Set(["document"]);

export function objectReadsWide(kind: string | null | undefined): boolean {
  return !!kind && WIDE_KINDS.has(kind);
}
