/**
 * The pure half of `/open/channel/:id`: who wrote a message, in words, and
 * the transcript's reading order.
 */

import { humanizeToken, resolveObjectNoun } from "@synap-core/types/vocabulary";

/** The slice of a `channels.getMessages` row this reads. */
export interface TranscriptMessage {
  id: string;
  role: string;
  authorType?: string | null;
  externalSource?: string | null;
  content: string;
  timestamp: Date | string;
}

/** How many recent messages the page reads. */
export const TRANSCRIPT_LIMIT = 30;

/** One message's length cap: a pasted log must not bury the rest. */
export const MESSAGE_MAX_CHARS = 20_000;

/** Who wrote a message, as a reader names them. */
export function messageAuthor(message: TranscriptMessage): string {
  if (message.role === "system" || message.authorType === "bot") {
    return "Synap";
  }
  if (message.authorType === "ai_agent" || message.role === "assistant") {
    return "Agent";
  }
  if (message.authorType === "external") {
    const source = message.externalSource?.trim();
    return source ? `${humanizeToken(source)} contact` : "Outside contact";
  }
  return "Person";
}

/** Newest-first rows (the door's order) → oldest first, the newest last. */
export function readingOrder<T>(newestFirst: readonly T[]): T[] {
  return [...newestFirst].reverse();
}

/** The slice of `chat.getChannel`'s `linkedObject` this reads. */
export interface LinkedObjectWire {
  type: string;
  id: string;
  title: string | null;
}

/** The chip a conversation's page draws for the object it belongs to. */
export interface LinkedObjectChip {
  objectKind: string;
  id: string;
  /** Its name, else its kind's noun: never empty, never a raw token. */
  label: string;
}

/** What the conversation belongs to, as a chip; null when it belongs to nothing. */
export function linkedObjectChip(
  linked: LinkedObjectWire | null | undefined
): LinkedObjectChip | null {
  if (!linked?.type || !linked.id) return null;
  return {
    objectKind: linked.type,
    id: linked.id,
    label: linked.title?.trim() || resolveObjectNoun(linked.type),
  };
}
