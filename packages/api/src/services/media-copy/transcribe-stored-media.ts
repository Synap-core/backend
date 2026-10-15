/**
 * Transcribe a STORED video's (or audio's) speech with the existing
 * transcription service — the IS `POST /api/transcribe` the dictation door
 * and the Library light read already use. No ffmpeg: the container goes as
 * it is (MP4/WebM carry their audio track; the provider decodes it), exactly
 * as the light read sends a kept video file.
 *
 * Limits (why some videos answer `too_large`): the IS / provider take one
 * upload of ≤ 20 MB here ({@link TRANSCRIBE_STORED_MEDIA_MAX_BYTES}), whole — no audio extraction or chunking happens on the
 * pod. A short reel fits; a long video does not.
 *
 * Budget: this function SPENDS (one transcription call) and does not reserve
 * the person's light-read budget itself — the caller does, as the light read
 * does before its own transcription. Never throws.
 */

import { db as defaultDb, documents, and, eq, isNull } from "@synap/database";
import { INLINE_VIDEO_MIME_TYPES } from "@synap-core/types/presentation";

/**
 * One upload's ceiling — the light read's own (`LIGHT_READ_FILE_BYTES_MAX`,
 * pinned equal by a test; not imported, so the light read can import THIS
 * module without a cycle), under the 25 MB provider limit.
 */
export const TRANSCRIBE_STORED_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export type TranscribeStoredMediaResult =
  | { text: string; lang?: string }
  | {
      failed:
        | "not_found" // not this person's live stored document
        | "not_media" // not audio/* or an inline video type
        | "too_large" // over the one-upload ceiling
        | "empty" // no speech came back
        | "not_configured" // no transcription provider (or an older IS)
        | "refused" // the IS refused it (budget, undecodable…) — final
        | "unavailable"; // IS unreachable / 5xx / 429 — try again later
      detail?: string;
    };

export interface TranscribeStoredMediaDeps {
  database?: typeof defaultDb;
  download?: (storageKey: string) => Promise<Buffer>;
  transcribe?: (
    userId: string,
    workspaceId: string | null,
    input: { content: string; mimeType: string }
  ) => Promise<
    | { ok: true; text: string; language?: string }
    | { ok: false; status: number; code: string; error: string }
  >;
}

export async function transcribeStoredMedia(
  documentId: string,
  userId: string,
  deps: TranscribeStoredMediaDeps = {}
): Promise<TranscribeStoredMediaResult> {
  try {
    const database = deps.database ?? defaultDb;
    const [doc] = await database
      .select({
        storageKey: documents.storageKey,
        mimeType: documents.mimeType,
        size: documents.size,
        workspaceId: documents.workspaceId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.userId, userId),
          isNull(documents.deletedAt)
        )
      )
      .limit(1);
    if (!doc?.storageKey || !doc.mimeType) return { failed: "not_found" };
    const mimeType = doc.mimeType.toLowerCase();
    const isVideo = (INLINE_VIDEO_MIME_TYPES as readonly string[]).includes(
      mimeType
    );
    if (!isVideo && !mimeType.startsWith("audio/"))
      return { failed: "not_media" };
    if (doc.size > TRANSCRIBE_STORED_MEDIA_MAX_BYTES)
      return { failed: "too_large" };
    const download =
      deps.download ??
      (async (key: string) => {
        const { storage } = await import("@synap/storage");
        return storage.downloadBuffer(key);
      });
    const bytes = await download(doc.storageKey);
    if (bytes.byteLength > TRANSCRIBE_STORED_MEDIA_MAX_BYTES)
      return { failed: "too_large" };
    const transcribe = deps.transcribe ?? transcribeViaIs;
    const got = await transcribe(userId, doc.workspaceId ?? null, {
      content: bytes.toString("base64"),
      mimeType,
    });
    if (got.ok) {
      const text = got.text.trim();
      if (!text) return { failed: "empty" };
      return { text, ...(got.language ? { lang: got.language } : {}) };
    }
    if (
      got.code === "transcription_not_configured" ||
      got.code === "is_route_missing"
    )
      return { failed: "not_configured", detail: got.error };
    if (got.status >= 500 || got.status === 429)
      return { failed: "unavailable", detail: got.code };
    return { failed: "refused", detail: got.code };
  } catch (err) {
    return {
      failed: "unavailable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function transcribeViaIs(
  userId: string,
  workspaceId: string | null,
  input: { content: string; mimeType: string }
) {
  const { resolveIntelligenceService } =
    await import("../../utils/intelligence-routing.js");
  const { client } = await resolveIntelligenceService({
    userId,
    workspaceId: workspaceId ?? undefined,
    capability: "default",
  });
  return client.transcribe(input);
}
