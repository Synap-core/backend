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
