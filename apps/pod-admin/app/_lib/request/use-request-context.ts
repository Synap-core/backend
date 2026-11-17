"use client";

/**
 * The page's REQUEST CONTEXT, read once for every row
 * (`signals.needsYou({ include: ["context"] })`, founder decision 1 A: no
 * per-row reads) and handed to `requestStory` for the one request open.
 *
 * Read lazily: only once a request's story is drawn (`enabled`), then kept
 * for the page (`staleTime`), so opening the next request reads nothing.
 * The rows themselves stay on Review's one list read (`signals.list`, the
 * order and population every tray shares); this read adds only the context,
 * keyed by the same row ids. A row the read does not cover yet (it arrived
 * after the cached read) is read again once (`covers` + `refetch`): a read
 * that did not cover a row is not a failed read.
 */

import type { NeedsYouContextRead } from "@synap-core/types/needs-you";
import { trpc } from "../../../lib/trpc";
import type { NeedsYouSignal } from "./api";
import type { StoryRead } from "./request-story-view";

/** Review's page size, the same as its list read (`NEEDS_YOU_PAGE_LIMIT`). */
const CONTEXT_PAGE_LIMIT = 100;

export interface RequestContext {
  context: NeedsYouContextRead | null;
  read: StoryRead;
  /** The rows the read classified, every fold flattened (for a page with no list read). */
  rows: NeedsYouSignal[];
  /** Read it again (a row it does not cover yet). */
  refetch: () => void;
  /** When the read last answered (ms; 0 = never). */
  updatedAt: number;
}

export function useRequestContext({
  sessionId,
  enabled,
}: {
  /** Narrow the read to one session (the page's `?session=`, a proposal's session). */
  sessionId?: string | null;
  enabled: boolean;
}): RequestContext {
  const query = trpc.signals.needsYou.useQuery(
    {
      limit: CONTEXT_PAGE_LIMIT,
      include: ["context"],
      ...(sessionId ? { sessionId } : {}),
    },
    { enabled, staleTime: 30_000, retry: 1 }
  );
  const refetch = () => void query.refetch();
  const updatedAt = query.dataUpdatedAt ?? 0;
  if (!enabled)
    return {
      context: null,
      read: { status: "off" },
      rows: [],
      refetch,
      updatedAt,
    };
  if (query.isError)
    return {
      context: null,
      read: { status: "error", retry: refetch },
      rows: [],
      refetch,
      updatedAt,
    };
  if (!query.data)
    return {
      context: null,
      read: { status: "loading" },
      rows: [],
      refetch,
      updatedAt,
    };
  const rows = Object.values(query.data.rows).flat();
  const context = query.data.context ?? null;
  // Asked and not answered (a pod older than the context read): the story's
  // parts are unknown, said as a failed read, never drawn as an empty past.
  if (!context)
    return {
      context: null,
      read: { status: "error", retry: refetch },
      rows,
      refetch,
      updatedAt,
    };
  return { context, read: { status: "ok" }, rows, refetch, updatedAt };
}
