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
}

/**
 * Parse CSV content into headers and rows (each row as key-value by header).
 * Uses csv-parse; first row is treated as header.
 */
export function parseCsv(content: string): ParsedCsv {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { headers: [], rows: [] };
  }
  try {
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as Record<string, string>[];
    const headers = records.length > 0 ? Object.keys(records[0]) : [];
    return { headers, rows: records };
  } catch {
    return { headers: [], rows: [] };
  }
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
