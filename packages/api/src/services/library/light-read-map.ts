/**
 * PURE: what a read produced (`Got`) and how the reader door's answer maps
 * onto the stored read (see the `light-read.ts` header for the table).
 */

import type {
  LibraryReadBlocked,
  LibraryReadStatus,
} from "@synap-core/types/imports";
import type {
  ReaderStamp,
  UrlRead,
  UrlReadFailureClass,
} from "@synap-core/types/url-read";

/** What the door said about the read, kept on the stored read. */
export interface DoorFacts {
  reader?: ReaderStamp;
  blocked?: LibraryReadBlocked;
  error?: string;
  transcript?: { source: "platform" | "stt"; lang?: string };
}

export type Got = DoorFacts &
  (
    | {
        kind: "text";
        text: string;
        usedAi: boolean;
        /** A summary the reading call already wrote (a file's extraction). */
        summary?: string;
      }
    | { kind: "status"; status: LibraryReadStatus; usedAi?: boolean }
    /**
     * The IS / the reader failed: try again later. Its CLASS decides how
     * (light-read.ts `finishUnread`): transient waits with backoff and never
     * ends `unreadable`; anything else counts an attempt.
     */
    | {
        kind: "retry";
        usedAi: boolean;
        failure: UrlReadFailureClass;
        /** Seconds the site / vendor asked to wait. */
        retryAfterSec?: number;
      }
  );

const TRANSCRIPT_LABEL = {
  platform: "Transcript (from the site)",
  stt: "Transcript (speech to text, by AI)",
} as const;

/** The read's text as stored: title, author, body, then a labelled transcript. */
export function composeDoorReadText(
  read: Pick<UrlRead, "title" | "author" | "text">,
  transcript?: { source: "platform" | "stt"; text: string }
): { full: string; body: string } {
  const body = [
    read.text?.trim() ?? "",
    transcript?.text.trim()
      ? `${TRANSCRIPT_LABEL[transcript.source]}:\n${transcript.text.trim()}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const full = [
    read.title?.trim() ?? "",
    read.author?.trim() ? `By ${read.author.trim()}` : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { full, body };
}

/**
 * The door's answer → the stored read (see the module header). PURE.
 * `transcript` is the one the read carried or the pod made from its video.
 */
export function mapDoorRead(
  read: UrlRead,
  contentStatus: string | undefined,
  transcript?: { source: "platform" | "stt"; text: string; lang?: string }
): Got {
  const facts: DoorFacts = { reader: read.via };
  const stagedTitleOnly = contentStatus === "title_only";
  if (read.status === "ok" || read.status === "partial") {
    const { full, body } = composeDoorReadText(read, transcript);
    const transcriptFact = transcript?.text.trim()
      ? {
          transcript: {
            source: transcript.source,
            ...(transcript.lang ? { lang: transcript.lang } : {}),
          },
        }
      : {};
    if (read.status === "ok" ? full.trim() : body.trim()) {
      return {
        ...facts,
        ...transcriptFact,
        kind: "text",
        text: full,
        usedAi: transcript?.source === "stt",
      };
    }
    return { ...facts, kind: "status", status: "title_only" };
  }
  if (read.status === "blocked" && read.blocked) {
    const blocked: LibraryReadBlocked = {
      reason: read.blocked.reason,
      ...(read.blocked.nextStep ? { nextStep: read.blocked.nextStep } : {}),
      ...(read.blocked.detail ? { detail: read.blocked.detail } : {}),
    };
    if (blocked.nextStep === "retry_later") {
      return {
        ...facts,
        blocked,
        kind: "retry",
        usedAi: false,
        failure: "rate_limited",
        ...(read.retryAfterSec ? { retryAfterSec: read.retryAfterSec } : {}),
      };
    }
    if (stagedTitleOnly) {
      return { ...facts, blocked, kind: "status", status: "title_only" };
    }
    const status: LibraryReadStatus =
      blocked.reason === "needs_reader" || blocked.reason === "unsupported"
        ? "needs_file"
        : "unreadable";
    return { ...facts, blocked, kind: "status", status };
  }
  // failed (or a blocked read with no reason — normalizeUrlRead never makes one)
  if (stagedTitleOnly) {
    // A staged title-only link was never promised more than its title: a
    // failed try is not retried into `unreadable`.
    return {
      ...facts,
      ...(read.error ? { error: read.error } : {}),
      kind: "status",
      status: "title_only",
    };
  }
  return {
    ...facts,
    ...(read.error ? { error: read.error } : {}),
    kind: "retry",
    usedAi: false,
    failure: read.errorClass ?? "unknown",
    ...(read.retryAfterSec ? { retryAfterSec: read.retryAfterSec } : {}),
  };
}
