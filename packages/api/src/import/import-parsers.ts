/**
 * Import parsers
 *
 * Reusable parsers for Markdown (frontmatter + body), CSV (headers + rows),
 * and JSON chat-shape detection. Used by the import router only; no UI dependency.
 */

import matter from "gray-matter";
import { parse } from "csv-parse/sync";

// ─── Markdown ─────────────────────────────────────────────────────────────────

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse markdown content into frontmatter and body.
 * Uses gray-matter; safe for content without frontmatter (returns empty object).
 */
export function parseMarkdown(content: string): ParsedMarkdown {
  if (typeof content !== "string") {
    return { frontmatter: {}, body: "" };
  }
  const parsed = matter(content);
  return {
    frontmatter: (parsed.data as Record<string, unknown>) ?? {},
    body: parsed.content?.trim() ?? "",
  };
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  /**
   * Lines that came BEFORE the header row and were skipped (an export's
   * "Notes:" preamble, a disclaimer paragraph). Empty for a plain CSV. Kept so
   * a caller can show what was not read as data instead of hiding it.
   */
  preambleLines: string[];
}

/**
 * The field count most data rows share — the table's width. Counted over the
 * records with at least two fields so a one-field preamble ("Notes:", a quoted
 * paragraph) can never outvote the table; a genuinely one-column CSV (every
 * record has one field) answers 1. Ties go to the wider count.
 */
function dominantFieldCount(records: string[][]): number {
  const multi = records.filter((r) => r.length >= 2);
  const pool = multi.length > 0 ? multi : records;
  const counts = new Map<number, number>();
  for (const r of pool) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [width, n] of counts) {
    if (n > bestN || (n === bestN && width > best)) {
      best = width;
      bestN = n;
    }
  }
  return best;
}

/**
 * Parse CSV content into headers and rows (each row as key-value by header).
 *
 * The header is the FIRST record whose field count equals the table's dominant
 * field count — not blindly the first line. Exports often open with a preamble
 * (LinkedIn's `Connections.csv` starts with "Notes:", a quoted paragraph and a
 * blank line before `First Name,Last Name,…`); taking line 1 as the header made
 * "Notes:" the only column and every row's title a fragment. Records before the
 * header are returned as `preambleLines`, never read as data.
 */
export function parseCsv(content: string): ParsedCsv {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { headers: [], rows: [], preambleLines: [] };
  }
  let records: string[][];
  try {
    records = parse(content, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as string[][];
  } catch {
    return { headers: [], rows: [], preambleLines: [] };
  }
  // A record of only empty cells (",,,") is a separator: it never decides the
  // table's width and is never the header.
  const isBlank = (r: string[]) => r.every((cell) => cell === "");
  const width = dominantFieldCount(records.filter((r) => !isBlank(r)));
  if (width === 0) return { headers: [], rows: [], preambleLines: [] };
  const headerIndex = records.findIndex(
    (r) => r.length === width && !isBlank(r)
  );
  const headers = records[headerIndex]!;
  const rows = records.slice(headerIndex + 1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      // Missing trailing cells read as "" (relaxed column count).
      row[h] = record[i] ?? "";
    });
    return row;
  });
  return {
    headers,
    rows,
    preambleLines: records
      .slice(0, headerIndex)
      .filter((r) => !isBlank(r))
      .map((r) => r.join(",")),
  };
}

// ─── Bookmarks HTML (Netscape format) ─────────────────────────────────────────

export interface ParsedBookmark {
  title: string;
  url: string;
  tags?: string;
}

/**
 * Parse Netscape bookmarks HTML into bookmark records.
 * This parser is intentionally lenient and regex-based to support exports
 * from Chrome/Firefox/Safari without DOM dependencies on the backend.
 */
export function parseBookmarksHtml(content: string): ParsedBookmark[] {
  if (typeof content !== "string" || content.trim().length === 0) return [];

  const results: ParsedBookmark[] = [];
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(content)) !== null) {
    const href = match[1]?.trim();
    const inner = match[2]?.replace(/<[^>]+>/g, "").trim();
    const fullTag = match[0] ?? "";
    const tagsMatch = fullTag.match(/\stags=["']([^"']*)["']/i);
    if (!href) continue;
    results.push({
      title: inner || href,
      url: href,
      tags: tagsMatch?.[1]?.trim() || undefined,
    });
  }
  return results;
}

// ─── JSON chat shape ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: string;
  content: string;
}

export interface JsonChatShape {
  messages: ChatMessage[];
}

/**
 * Detect if JSON is a chat-like structure (array of messages with role and content).
 * Accepts: { messages: [{ role, content }, ...] } or direct array [{ role, content }, ...].
 * Returns null if not detected or parse error.
 */
export function detectJsonChatShape(obj: unknown): JsonChatShape | null {
  if (obj == null || typeof obj !== "object") {
    return null;
  }
  let arr: unknown[] = [];
  if (Array.isArray(obj)) {
    arr = obj;
  } else if (
    "messages" in obj &&
    Array.isArray((obj as { messages: unknown[] }).messages)
  ) {
    arr = (obj as { messages: unknown[] }).messages;
  } else {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const item of arr) {
    if (item == null || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const role = o.role;
    const content = o.content ?? o.text ?? o.message;
    if (typeof role === "string" && typeof content === "string") {
      const normalizedRole =
        role.toLowerCase() === "assistant" || role.toLowerCase() === "ai"
          ? "assistant"
          : role.toLowerCase() === "user" || role.toLowerCase() === "human"
            ? "user"
            : role.toLowerCase() === "system"
              ? "system"
              : "user";
      messages.push({ role: normalizedRole, content });
    }
  }
  if (messages.length === 0) return null;
  return { messages };
}

/**
 * Flatten a chat-shaped JSON object into a readable transcript string.
 *
 * Uses {@link detectJsonChatShape} to recognise the conversation, then renders
 * "Speaker: text" one line per message, optionally prefixed by a title/date
 * header drawn from common top-level fields. The result is fed into the SAME
 * deep/prose structuring the markdown path uses, so the chat content yields an
 * ENTITY GRAPH (entities + relations extracted from the conversation) rather
 * than channels + messages.
 *
 * Returns null when the JSON is not chat-shaped — the caller then falls back to
 * treating the raw JSON as plain text content for structuring.
 */
export function flattenChatTranscript(obj: unknown): {
  title?: string;
  transcript: string;
} | null {
  const shape = detectJsonChatShape(obj);
  if (!shape || shape.messages.length === 0) return null;

  // Pull a human title + date header from common top-level fields when present.
  let title: string | undefined;
  let date: string | undefined;
  if (obj != null && typeof obj === "object" && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    const t = o.title ?? o.name ?? o.subject ?? o.conversation_title;
    if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 200);
    const d = o.date ?? o.created_at ?? o.createdAt ?? o.timestamp;
    if (typeof d === "string" && d.trim()) date = d.trim().slice(0, 100);
  }

  const roleLabel = (role: string): string =>
    role === "assistant" ? "Assistant" : role === "system" ? "System" : "User";

  const lines: string[] = [];
  if (title) lines.push(`# ${title}`);
  if (date) lines.push(`Date: ${date}`);
  if (lines.length > 0) lines.push("");
  for (const msg of shape.messages) {
    const text = msg.content.trim();
    if (!text) continue;
    lines.push(`${roleLabel(msg.role)}: ${text}`);
  }

  return { ...(title ? { title } : {}), transcript: lines.join("\n") };
}
