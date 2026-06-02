/**
 * Import source adapters.
 *
 * The ONLY place source-specific parsing lives. Each adapter turns a raw source
 * (one note, one row, one file) into the source-agnostic ImportItem. Everything
 * downstream (buildImportProposal, the endpoint, the materializer) is generic.
 *
 * Adding a new source = adding an adapter here; nothing else changes.
 */

import {
  parseMarkdown,
  parseCsv,
  parseBookmarksHtml,
} from "./import-parsers.js";
import type { ImportItem, ImportLink } from "./import-items.js";

// ── Obsidian / wikilink-markdown adapter ───────────────────────────────────────

/**
 * Attachment/file extensions that appear in [[embeds]] but are NOT note links.
 * `[[pasted image.png]]`, `[[clip.mp4]]`, `[[doc.pdf]]` are file embeds, not
 * note-to-note references — excluding them keeps the relation graph clean and
 * stops them inflating the "unresolved links" count.
 */
const ATTACHMENT_EXT =
  /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|webm|avi|mkv|mp3|wav|m4a|ogg|flac|pdf|docx?|xlsx?|pptx?|zip|csv)$/i;

/**
 * Reduce a wikilink target to the NOTE NAME used for resolution.
 * Obsidian links can be bare (`Page`), path-qualified (`folder/sub/Page`), or
 * carry a heading (`Page#H`). Resolution matches on the basename (the note's
 * filename without folders), so `5. Projects/.../Hashguard` resolves to the
 * note `Hashguard`. Exported for reuse by the resolver + tests.
 */
export function wikilinkBasename(target: string): string {
  const noHeading = target.split("#")[0].trim();
  const segs = noHeading.split("/").filter(Boolean);
  return (segs.pop() ?? noHeading).trim();
}

/**
 * Extract [[wikilinks]] from markdown body.
 * Handles [[Page]], [[Page|Alias]], [[Page#Heading]], [[folder/Page]],
 * [[Page#Heading|Alias]]. De-duplicated by resolved basename. Skips attachment
 * embeds (images/pdfs/media) — those are files, not note relations.
 */
export function extractWikilinks(body: string): ImportLink[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const re = /\[\[([^\]\n]+?)\]\]/g;
  const byName = new Map<string, ImportLink>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    const [targetPart, alias] = raw.split("|").map((s) => s.trim());
    // Resolve to the note's basename so path-qualified links match.
    const targetName = wikilinkBasename(targetPart);
    if (!targetName) continue;
    if (ATTACHMENT_EXT.test(targetName)) continue; // file embed, not a note link
    const key = targetName.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        targetName,
        ...(alias ? { alias } : {}),
      });
    }
  }
  return [...byName.values()];
}

/**
 * Extract inline #tags from body (e.g. "#project", "#area/work").
 * Ignores headings and code spans/fences. De-duplicated.
 */
export function extractInlineTags(body: string): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const noCode = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const tags = new Set<string>();
  const re = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noCode)) !== null) {
    tags.add(m[1]);
  }
  return [...tags];
}

/**
 * Obsidian markdown note → ImportItem.
 *
 * @param path  Vault-relative path, e.g. "Projects/2026/Launch.md"
 * @param content  Raw file content
 */
export function obsidianNoteToImportItem(
  path: string,
  content: string
): ImportItem {
  const { frontmatter, body } = parseMarkdown(content);
  const segments = path.split("/").filter(Boolean);
  const file = segments.pop() ?? path;
  const title = file.replace(/\.md$/i, "");
  const typeHint =
    typeof frontmatter?.type === "string" ? frontmatter.type : undefined;
  return {
    title,
    path: segments,
    metadata: frontmatter ?? {},
    body,
    links: extractWikilinks(body),
    labels: extractInlineTags(body),
    ...(typeHint ? { typeHint } : {}),
  };
}

// ── Plain markdown adapter ─────────────────────────────────────────────────────

/**
 * Plain markdown file → ImportItem. Same as the obsidian adapter but used for
 * generic `.md` imports where wikilinks are not expected; still extracts
 * frontmatter + inline #tags. Wikilinks are extracted too (harmless when absent).
 */
export function markdownFileToImportItem(
  path: string,
  content: string
): ImportItem {
  return obsidianNoteToImportItem(path, content);
}

// ── CSV adapter ─────────────────────────────────────────────────────────────

/**
 * One CSV file → N ImportItems (one per row). Title comes from a name-ish column
 * (first matching `title`/`name`, else the first column); every other non-empty
 * cell becomes metadata. No body, links, or labels — a CSV row is flat data.
 */
export function csvFileToImportItems(content: string): ImportItem[] {
  const { headers, rows } = parseCsv(content);
  if (headers.length === 0 || rows.length === 0) return [];
  const titleHeader =
    headers.find((h) => /^(title|name)$/i.test(h)) ?? headers[0];
  return rows.map((row) => {
    const metadata: Record<string, unknown> = {};
    for (const h of headers) {
      if (h && h !== titleHeader && row[h] !== undefined && row[h] !== "") {
        metadata[h] = row[h];
      }
    }
    const title = String(row[titleHeader] ?? "Untitled").slice(0, 500);
    return {
      title,
      path: [],
      metadata,
      body: "",
      links: [],
      labels: [],
    };
  });
}

// ── Bookmark (Netscape HTML) adapter ──────────────────────────────────────────

/**
 * One bookmarks HTML file → N ImportItems (one per link). Each becomes a
 * `bookmark`-typed item with the url in metadata and any export tags as labels.
 */
export function bookmarksFileToImportItems(content: string): ImportItem[] {
  return parseBookmarksHtml(content).map((b) => ({
    title: b.title.slice(0, 500),
    path: [],
    metadata: { url: b.url },
    body: "",
    links: [],
    labels: b.tags
      ? b.tags
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    typeHint: "bookmark",
  }));
}

// ── Adapter registry ───────────────────────────────────────────────────────────

export type ImportSource = "obsidian" | "markdown" | "csv" | "bookmark";

/**
 * Resolve a batch of raw `{ path, content }` records to ImportItems for a given
 * source. New sources (apple-notes, notion, folder) plug in here.
 *
 * Note: file-shaped sources (csv, bookmark) expand a SINGLE file into many items
 * (one per row/link), so this flat-maps rather than mapping 1:1.
 */
export function adaptItems(
  source: ImportSource,
  raw: Array<{ path: string; content: string }>
): ImportItem[] {
  switch (source) {
    case "obsidian":
      return raw.map((r) => obsidianNoteToImportItem(r.path, r.content));
    case "markdown":
      return raw.map((r) => markdownFileToImportItem(r.path, r.content));
    case "csv":
      return raw.flatMap((r) => csvFileToImportItems(r.content));
    case "bookmark":
      return raw.flatMap((r) => bookmarksFileToImportItems(r.content));
    default:
      // Exhaustive: TS errors here if a new ImportSource is added without a case.
      return ((_: never) => [])(source);
  }
}
