"use client";

import { trpc } from "../../../../lib/trpc";
import { useReauthOnUnauthorized } from "../use-reauth";
import { documentContent, type DocumentContent } from "./document-model";

/**
 * One document's body for a read-only page, through the viewer's own floor
 * (`documents.get`, raw: embeds kept, so `markdown-view` draws them). Never
 * an admin door: what the pod would not show this person, the console does
 * not show either. `null` while it loads; nothing is asked without an id.
 */
export function useDocumentContent(
  documentId: string | null | undefined
): DocumentContent | null {
  const query = trpc.documents.get.useQuery(
    { documentId: documentId ?? "", format: "raw" },
    { enabled: Boolean(documentId), retry: false }
  );
  useReauthOnUnauthorized(query.error);
  if (!documentId) return null;
  if (query.isLoading) return null;
  return documentContent(query.error, query.data);
}
