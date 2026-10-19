/**
 * The pure half of `/open/channel/:id`: who wrote a message, in words, and
 * the transcript's reading order.
 */

import { humanizeToken } from "@synap-core/types/vocabulary";

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
