"use client";

import { trpc } from "../../../../lib/trpc";
import { useReauthOnUnauthorized } from "../use-reauth";
import { askEmbedRead, type EmbedAskRead } from "./ask-embed-model";

/**
 * An embedded question, read through `focusSessions.get`: the viewer's own
 * floor, the session page's own read (`getLean` carries neither the stored
 * slots, their answers nor the viewer's role). An expired sign-in re-auths
 * like every object page. The answer goes through the shared card.
 */
export function useEmbedAsk(sessionId: string, slot: string): EmbedAskRead {
  const query = trpc.focusSessions.get.useQuery(
    { id: sessionId },
    { retry: false, staleTime: 15_000 }
  );
  useReauthOnUnauthorized(query.error);
  return askEmbedRead(
    {
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      error: query.error,
      data: query.data,
      dataUpdatedAt: query.dataUpdatedAt,
      retry: () => void query.refetch(),
    },
    { sessionId, slot }
  );
}
