/**
 * Import source adapters.
 *
 * The ONLY place source-specific parsing lives. Each adapter turns a raw source
 * (one note, one row, one file) into the source-agnostic ImportItem. Everything
 * downstream (buildImportProposal, the endpoint, the materializer) is generic.
 *
 * Adding a new source = adding an adapter here; nothing else changes.
 */

import { parseMarkdown } from "./import-parsers.js";
import type { ImportItem, ImportLink } from "./import-items.js";

// ── Obsidian / wikilink-markdown adapter ───────────────────────────────────────

/**
 * Extract [[wikilinks]] from markdown body.
 * Handles [[Page]], [[Page|Alias]], [[Page#Heading]], [[Page#Heading|Alias]].
 * De-duplicated by target page name.
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
    const targetName = targetPart.split("#")[0].trim();
    if (!targetName) continue;
    if (!byName.has(targetName)) {
      byName.set(targetName, {
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

// ── Adapter registry ───────────────────────────────────────────────────────────

export type ImportSource = "obsidian";

/**
 * Resolve a batch of raw `{ path, content }` records to ImportItems for a given
 * source. New sources (apple-notes, notion, folder) plug in here.
 */
export function adaptItems(
  source: ImportSource,
  raw: Array<{ path: string; content: string }>
): ImportItem[] {
  switch (source) {
    case "obsidian":
      return raw.map((r) => obsidianNoteToImportItem(r.path, r.content));
    default:
      // Exhaustive: TS errors here if a new ImportSource is added without a case.
      return ((_: never) => [])(source);
  }
}
