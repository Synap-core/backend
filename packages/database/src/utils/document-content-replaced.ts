/**
 * `document:content-replaced` — tell open editors the server replaced a
 * document's content (an approved edit, a version restore, a section write).
 *
 * An open editor holds its own copy of the content and autosaves it. Without
 * this event, it would overwrite the replacement on its next save. On receipt,
 * the client blocks its own autosave and offers "reload" (plan D-open,
 * `useDocumentCollaborationRoom`).
 *
 * Delivered through the realtime bridge (`POST ${REALTIME_URL}/bridge/emit`),
 * the same contract `domain-event-bridge` uses. It targets the document's
 * workspace room, or the owner's user room for a pod-wide document. Call it
 * AFTER the claiming transaction commits, never inside it.
 *
 * Returns the outcome instead of throwing: a missed emit must not undo a
 * committed write. Callers log a failure; they never treat it as success.
 */

export const DOCUMENT_CONTENT_REPLACED_EVENT = "document:content-replaced";

export interface DocumentContentReplacedPayload {
  documentId: string;
  /** The `content_revision` the document now holds. */
  revision: number;
}

export async function emitDocumentContentReplaced(target: {
  documentId: string;
  revision: number;
  workspaceId: string | null;
  ownerUserId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const realtimeUrl = process.env.REALTIME_URL || "http://localhost:4001";
  const data: DocumentContentReplacedPayload = {
    documentId: target.documentId,
    revision: target.revision,
  };
  try {
    const response = await fetch(`${realtimeUrl}/bridge/emit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.BRIDGE_SECRET
          ? { "X-Bridge-Secret": process.env.BRIDGE_SECRET }
          : {}),
      },
      body: JSON.stringify({
        event: DOCUMENT_CONTENT_REPLACED_EVENT,
        ...(target.workspaceId
          ? { workspaceId: target.workspaceId }
          : { userId: target.ownerUserId }),
        data,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { ok: false, error: `bridge answered ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
