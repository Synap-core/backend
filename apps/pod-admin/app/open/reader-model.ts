/**
 * Which `/open` objects read in the full-window READER instead of the
 * receiver card (founder, 27 Nov 2026): the ONE answer every hosted page asks.
 *
 * Big content (a view, a bento, a whiteboard, a document, an HTML page) gets a
 * slim bar and the rest of the window, its body owning the scroll; small
 * objects (a record, a person, a task, a playbook, a session…) keep the card.
 *
 * Only content that is actually DRAWN reads in the reader. Every other state
 * keeps today's card unchanged: loading, a failed read, a view no renderer
 * draws (its identity card and its one "Open view in the app" door), a
 * document the reader cannot see or a file only the app opens.
 *
 *   fill      full width, the body owns the scroll (page grammar §2, View
 *             template): views, bento, whiteboard
 *   document  80% of the window from 1024px, at most 72rem, running text at
 *             the prose measure (page grammar §2): documents, HTML pages
 */

export type ReaderLayout = "fill" | "document";

const READER_LAYOUTS: ReadonlyMap<string, ReaderLayout> = new Map<
  string,
  ReaderLayout
>([
  ["view", "fill"],
  ["document", "document"],
]);

export interface ReaderSubject {
  /** The object's content is drawn on this page (a renderer runs it, or its body reads here). */
  drawn: boolean;
}

/** The reader's layout for this object, or null when it keeps the card. */
export function readerLayout(
  type: string,
  object: ReaderSubject
): ReaderLayout | null {
  if (!object.drawn) return null;
  return READER_LAYOUTS.get(type) ?? null;
}

/** Whether this object opens in the reader (`readerLayout` is not null). */
export function isReaderObject(type: string, object: ReaderSubject): boolean {
  return readerLayout(type, object) !== null;
}

/**
 * The document frame's width classes: the receiver's `lg` reading width
 * (`receiverWidthClass("lg")`), spelled here because Tailwind reads class
 * names as literals.
 */
export function readerBodyClass(layout: ReaderLayout): string {
  if (layout === "fill") return "flex w-full flex-col px-2 py-3 sm:px-3";
  return "mx-auto flex w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:w-4/5";
}

/** The fill body's bottom padding in px (`py-3`): what a filling frame leaves under it. */
export const READER_FILL_BOTTOM_GAP = 12;
