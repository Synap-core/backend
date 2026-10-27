"use client";

import { trpc } from "../../../../lib/trpc";
import { useReauthOnUnauthorized } from "../use-reauth";
import { documentContent, type DocumentContent } from "./document-model";

/**
 * One document's body for a read-only page, through the viewer's own floor
 * (`documents.get`, raw: embeds kept, so `markdown-view` draws them; a stored
 * HTML page runs in its frame). Never an admin door: what the pod would not
 * show this person, the console does not show either. `content` is `null`
 * while it loads; nothing is asked without an id. `retry` reads it again.
 */
export function useDocumentContent(documentId: string | null | undefined): {
  content: DocumentContent | null;
  retry: () => void;
} {
  const query = trpc.documents.get.useQuery(
    { documentId: documentId ?? "", format: "raw" },
    { enabled: Boolean(documentId), retry: false }
  );
  useReauthOnUnauthorized(query.error);
  const retry = () => void query.refetch();
  if (!documentId || query.isLoading) return { content: null, retry };
  return { content: documentContent(query.error, query.data), retry };
}
