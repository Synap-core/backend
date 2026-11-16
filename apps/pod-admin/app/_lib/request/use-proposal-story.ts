"use client";

/**
 * A proposal's STORY where no Review row hands one over (`/proposal/[id]`):
 * the needs-you read with its context (`useRequestContext`), narrowed to the
 * proposal's session when the pod named one, the row that stands for this
 * proposal found in it, and the shared model over it (`requestStory`).
 *
 * A proposal no longer waiting (decided) has no row: the story then has no
 * Before or Next, said by `read: off` — not as a failure.
 */

import {
  lensRowOfNeedsYou,
  type LensNeedsYouSignal,
} from "@synap-core/types/lens";
import { requestStory, type RequestStory } from "@synap-core/types/needs-you";
import { useConsoleLocale } from "../../../lib/i18n/locale-provider";
import type { StoryRead } from "./request-story-view";
import { useRequestContext } from "./use-request-context";

type ClusterSignal = LensNeedsYouSignal & {
  proposalIds?: string[] | null;
  source?: { kind: string; id: string; label: string } | null;
};

/** The needs-you row that stands for this proposal, if it still waits. */
export function proposalSignalOf(
  rows: readonly unknown[],
  proposalId: string
): ClusterSignal | null {
  for (const r of rows as ClusterSignal[]) {
    if (r.kind !== "proposal-cluster") continue;
    if (r.proposalIds?.includes(proposalId)) return r;
    if (r.target?.kind === "proposal" && r.target.id === proposalId) return r;
  }
  return null;
}

export function useProposalStory({
  proposalId,
  sessionId,
  sessionTitle,
  enabled,
}: {
  proposalId: string;
  sessionId: string | null;
  sessionTitle: string | null;
  /** Read only while the proposal waits: a decided one has no story ahead. */
  enabled: boolean;
}): { story: RequestStory | null; read: StoryRead } {
  const locale = useConsoleLocale();
  const { context, read, rows } = useRequestContext({ sessionId, enabled });
  if (read.status !== "ok") return { story: null, read };
  const signal = proposalSignalOf(rows, proposalId);
  if (!signal) return { story: null, read: { status: "off" } };
  const lens = lensRowOfNeedsYou(
    {
      kind: "item",
      key: signal.id,
      signal,
      session: sessionId
        ? { id: sessionId, title: sessionTitle, projectId: null }
        : null,
    },
    "blocking"
  );
  return { story: requestStory(lens, context, { locale }), read };
}
