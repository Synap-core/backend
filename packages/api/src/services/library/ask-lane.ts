/**
 * The Library lane of `ask` — what the person KEPT, found by its words.
 *
 * ONE search: `searchLibraryWithReadText` (owner-floored, the same rows and the
 * same visibility as the Library itself; archived items stay findable). A hit
 * carries what an agent needs to cite and open it: the item id, title, source
 * URL, a short snippet (said where from in `snippetFrom`), and who read it
 * (`LibraryItemRead.reader`, stamped by the reader door — absent on a read that
 * predates the stamp).
 *
 * Snippets cost no storage read when they need none: `ask` runs on every
 * non-trivial agent task, so the lane takes the snippet from the read SUMMARY
 * (already on the row) when the summary holds a query word, and fetches the
 * stored read TEXT only for the top {@link ASK_LIBRARY_TEXT_FETCH_MAX} hits whose
 * summary does not — at most that many storage reads per `ask`, never one per
 * hit. A hit past that, or whose text cannot be fetched, carries its summary.
 *
 * Failure is a fact, not an empty answer. The SQL search failing THROWS — `ask`
 * lists `library` in `degraded` and the block is `status: "error"`. The index
 * leg failing is partial: the SQL matches still stand, but an item findable only
 * by its read text may be missing, so `readTextSearch: "down"` is returned and
 * `ask` adds `library:text-down`. Neither is ever "found nothing".
 */

import type { LibraryItemView } from "@synap-core/types/imports";
import type { ReaderStamp } from "@synap-core/types/url-read";
import { createLogger } from "@synap-core/core";
import { libraryReadTextKey } from "@synap/database";
import { COMMON_STOPWORDS, QUESTION_WORDS } from "../retrieval/stopwords.js";
import { searchLibraryWithReadText } from "./search.js";
import {
  findLibraryReadTextIds,
  type LibraryReadTextLookup,
} from "./read-text-search.js";
import type { LibraryDb } from "./read-model.js";

const logger = createLogger({ module: "library/ask-lane" });

/** Characters of snippet a hit carries (a pointer to the item, not its body). */
export const ASK_LIBRARY_SNIPPET_MAX = 280;
/** Library hits one `ask` returns at most. */
const ASK_LIBRARY_LIMIT_MAX = 10;
/** Stored read texts one `ask` fetches at most (for the top hits only). */
export const ASK_LIBRARY_TEXT_FETCH_MAX = 3;

/** Who read a hit: the stamp's identity, not its bookkeeping. */
export type AskLibraryReader = Pick<
  ReaderStamp,
  "id" | "name" | "billed" | "readAt"
>;

export type AskLibraryHit = {
  id: string;
  title: string;
  /** The URL the item was kept from (absent for a file or pasted text). */
  sourceUrl?: string;
  /** A few words of the read text around the match (or the read summary). */
  snippet?: string;
  /** Where `snippet` came from; absent with it. */
  snippetFrom?: "read_text" | "summary";
  readStatus: string;
  /** Who read it, when the read was stamped. */
  reader?: AskLibraryReader;
  keptAt: string;
  archived?: true;
};

export interface AskLibraryLane {
  items: AskLibraryHit[];
  /** `down` = the read-text index could not be asked (see the header). */
  readTextSearch: "ok" | "down";
}

export interface AskLibraryDeps {
  database?: LibraryDb;
  lookup?: LibraryReadTextLookup;
  /** The stored read text of an item (throws when it cannot be read). */
  readText?: (storageKey: string) => Promise<string>;
}

const defaultReadText = async (storageKey: string): Promise<string> => {
  const { storage } = await import("@synap/storage");
  return (await storage.downloadBuffer(storageKey)).toString("utf-8");
};

const IGNORED = new Set<string>([...COMMON_STOPWORDS, ...QUESTION_WORDS]);

/** Content words of the query worth locating in a text (≥ 3 chars, no filler). */
export function snippetTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3 && !IGNORED.has(t))
    ),
  ];
}

/** A window of `text` around the first matched term, else its opening. */
export function snippetOf(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1 || flat.length <= ASK_LIBRARY_SNIPPET_MAX) {
    return flat.slice(0, ASK_LIBRARY_SNIPPET_MAX);
  }
  const start = Math.max(0, at - Math.floor(ASK_LIBRARY_SNIPPET_MAX / 3));
  const end = Math.min(flat.length, start + ASK_LIBRARY_SNIPPET_MAX);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** The read's stamp (already parsed by the read model), or absent. */
export function readerOf(item: LibraryItemView): AskLibraryReader | undefined {
  const r = item.read.reader;
  return r
    ? { id: r.id, name: r.name, billed: r.billed, readAt: r.readAt }
    : undefined;
}

/** Does the text hold one of the query's content words? */
function mentions(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t));
}

export async function searchLibraryForAsk(
  args: {
    userId: string;
    query: string;
    limit: number;
    projectId?: string | null;
  },
  deps: AskLibraryDeps = {}
): Promise<AskLibraryLane> {
  const limit = Math.min(Math.max(args.limit, 1), ASK_LIBRARY_LIMIT_MAX);
  const terms = snippetTerms(args.query);
  // The index is asked with the CONTENT words: a whole question ("what do my
  // branding references have in common?") makes the index drop words from the
  // right until something matches, which ends on "what".
  const baseLookup = deps.lookup ?? findLibraryReadTextIds;
  const found = await searchLibraryWithReadText({
    ...(deps.database ? { database: deps.database } : {}),
    lookup: (a) => baseLookup(terms.length ? { ...a, q: terms.join(" ") } : a),
    userId: args.userId,
    q: args.query,
    limit,
    ...(args.projectId ? { lens: { projectId: args.projectId } } : {}),
  });
  const readText = deps.readText ?? defaultReadText;
  // Which hits fetch their read text: read, the summary does not already hold
  // a query word, and among the first ASK_LIBRARY_TEXT_FETCH_MAX such hits.
  const fetchText = new Set(
    found.items
      .filter(
        (item) =>
          item.read.status === "read" &&
          !(item.read.summary && mentions(item.read.summary, terms))
      )
      .slice(0, ASK_LIBRARY_TEXT_FETCH_MAX)
      .map((item) => item.id)
  );
  const items = await Promise.all(
    found.items.map(async (item): Promise<AskLibraryHit> => {
      let snippet: string | undefined;
      let snippetFrom: AskLibraryHit["snippetFrom"];
      if (fetchText.has(item.id)) {
        try {
          const text = await readText(libraryReadTextKey(args.userId, item.id));
          snippet = snippetOf(text, terms) || undefined;
          if (snippet) snippetFrom = "read_text";
        } catch (err) {
          // The item is real and matched; only its snippet could not be fetched.
          logger.warn(
            { err, itemId: item.id },
            "ask library lane: read text unavailable — the summary stands in"
          );
        }
      }
      if (!snippet && item.read.summary?.trim()) {
        snippet = snippetOf(item.read.summary, terms) || undefined;
        if (snippet) snippetFrom = "summary";
      }
      const reader = readerOf(item);
      return {
        id: item.id,
        title: item.title,
        ...(item.source.url ? { sourceUrl: item.source.url } : {}),
        ...(snippet && snippetFrom ? { snippet, snippetFrom } : {}),
        readStatus: item.read.status,
        ...(reader ? { reader } : {}),
        keptAt: item.stagedAt,
        ...(item.archivedAt ? { archived: true as const } : {}),
      };
    })
  );
  return { items, readTextSearch: found.readTextSearch };
}
