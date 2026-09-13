/**
 * stageIntakeSource — THE one door that turns an intake INPUT into a readable,
 * openable `documents` row (intake plan, locked decision 5 / D5 "full doc").
 *
 * Every input a capture or import structures — typed text, a URL, a file's
 * extracted text, an import item, a degraded capture — becomes a document with
 * a content hash, tagged with the run's session. Proposals and the run
 * manifest carry only the document ID: proposal LIST reads select `data`, so a
 * raw body inlined there would ride every list.
 *
 * ── Two storage shapes, one metadata contract ─────────────────────────────
 *   - TEXT (text / url / import_item / a file's extracted text): the body is
 *     uploaded as markdown and written as the v1 version through
 *     `DocumentRepository.create({ content })` — the same path the Hub
 *     documents door uses.
 *   - BYTES (`file.keepBytes`): the original file through `stageSourceBlob`,
 *     the one upload implementation, with the extracted text (when any) as v1.
 *     Used for a DEGRADED file capture: without its bytes it could never be
 *     re-structured, which is the whole point of keeping it.
 *
 * `documents.metadata.intakeSource` = {@link IntakeSourceMetadata}. A
 * `degraded` marker records that structuring did not run (spend guard, IS
 * down) so the source can be selected for re-structure later — it is NOT a
 * proposal and adds no queue debt (decision D6).
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * Same user + same session + same content hash ⇒ the existing document is
 * returned (`deduplicated: true`), so a retried capture does not store its
 * input twice. A later NON-degraded staging of a source that was stored
 * degraded clears the marker and records `restructuredAt`.
 */

import { createHash, randomUUID } from "crypto";
import {
  DocumentRepository,
  documents as documentsTable,
  eventRepository,
  and,
  eq,
  isNull,
  drizzleSql,
  type db as DbType,
} from "@synap/database";
import { stageSourceBlob } from "../../utils/store-entity-source-blob.js";

export const INTAKE_SOURCE_METADATA_KEY = "intakeSource";

export type IntakeSourceKind = "text" | "url" | "file" | "import_item";

export interface IntakeSourceMetadata {
  version: 1;
  kind: IntakeSourceKind;
  /** sha256 over kind + url + path + body (or the file bytes). */
  contentHash: string;
  sessionId: string | null;
  door: string;
  url?: string;
  path?: string;
  filename?: string;
  mimeType?: string;
  degraded?: { reason: string; at: string };
  restructuredAt?: string;
}

export interface StageIntakeSourceInput {
  database: typeof DbType;
  userId: string;
  workspaceId?: string | null;
  sessionId: string | null;
  door: string;
  kind: IntakeSourceKind;
  title?: string;
  /** The readable body (text, fetched/pasted html, extracted text, item content). */
  text?: string;
  url?: string;
  /** Import item path (folder/file.md). */
  path?: string;
  file?: {
    buffer: Buffer;
    mimeType: string;
    filename?: string;
    extractedText?: string;
    extractedTextTruncated?: boolean;
    /** Store the ORIGINAL bytes (degraded / re-structurable), not only text. */
    keepBytes: boolean;
  };
  /** Structuring did not run — the source is kept for re-structure. */
  degraded?: { reason: string };
}

export interface StagedIntakeSource {
  documentId: string;
  contentHash: string;
  deduplicated: boolean;
  degraded: boolean;
}

export class IntakeSourceEmptyError extends Error {
  readonly code = "INTAKE_SOURCE_EMPTY" as const;
  constructor() {
    super("Intake source has no body to store");
    this.name = "IntakeSourceEmptyError";
  }
}

const TITLE_MAX = 120;

function deriveTitle(input: StageIntakeSourceInput): string {
  if (input.title?.trim()) return input.title.trim().slice(0, TITLE_MAX);
  if (input.kind === "url" && input.url) return input.url.slice(0, TITLE_MAX);
  if (input.kind === "import_item" && input.path)
    return input.path.slice(0, TITLE_MAX);
  if (input.file?.filename) return input.file.filename.slice(0, TITLE_MAX);
  const firstLine = (input.text ?? "").trim().split("\n")[0] ?? "";
  return firstLine.slice(0, TITLE_MAX) || "Captured source";
}

export function computeIntakeContentHash(input: {
  kind: IntakeSourceKind;
  url?: string;
  path?: string;
  text?: string;
  bytes?: Buffer;
}): string {
  const h = createHash("sha256");
  h.update(`${input.kind}\0${input.url ?? ""}\0${input.path ?? ""}\0`);
  if (input.bytes) h.update(input.bytes);
  else h.update(input.text ?? "");
  return h.digest("hex");
}

export async function stageIntakeSource(
  input: StageIntakeSourceInput
): Promise<StagedIntakeSource> {
  const { database, userId } = input;
  const keepBytes = Boolean(input.file?.keepBytes);
  const body =
    input.text ??
    input.file?.extractedText ??
    (input.kind === "url" ? input.url : undefined);
  if (!keepBytes && !body?.trim()) throw new IntakeSourceEmptyError();

  const contentHash = computeIntakeContentHash({
    kind: input.kind,
    url: input.url,
    path: input.path,
    ...(keepBytes ? { bytes: input.file!.buffer } : { text: body }),
  });
  const now = new Date().toISOString();

  if (input.sessionId) {
    const [existing] = await database
      .select({ id: documentsTable.id, metadata: documentsTable.metadata })
      .from(documentsTable)
      .where(
        and(
          eq(documentsTable.userId, userId),
          isNull(documentsTable.deletedAt),
          drizzleSql`${documentsTable.metadata} #>> '{intakeSource,sessionId}' = ${input.sessionId}`,
          drizzleSql`${documentsTable.metadata} #>> '{intakeSource,contentHash}' = ${contentHash}`
        )
      )
      .limit(1);
    if (existing) {
      const meta = (existing.metadata ?? {}) as Record<string, unknown>;
      const source = meta[INTAKE_SOURCE_METADATA_KEY] as
        IntakeSourceMetadata | undefined;
      const wasDegraded = Boolean(source?.degraded);
      if (wasDegraded && !input.degraded && source) {
        const { degraded: _cleared, ...rest } = source;
        await new DocumentRepository(database, eventRepository).update(
          existing.id,
          {
            metadata: {
              ...meta,
              [INTAKE_SOURCE_METADATA_KEY]: { ...rest, restructuredAt: now },
            },
          },
          userId
        );
      }
      return {
        documentId: existing.id,
        contentHash,
        deduplicated: true,
        degraded: wasDegraded && Boolean(input.degraded),
      };
    }
  }

  const sourceMeta: IntakeSourceMetadata = {
    version: 1,
    kind: input.kind,
    contentHash,
    sessionId: input.sessionId,
    door: input.door,
    ...(input.url ? { url: input.url } : {}),
    ...(input.path ? { path: input.path } : {}),
    ...(input.file?.filename ? { filename: input.file.filename } : {}),
    ...(input.file?.mimeType ? { mimeType: input.file.mimeType } : {}),
    ...(input.degraded
      ? { degraded: { reason: input.degraded.reason, at: now } }
      : {}),
  };
  const title = deriveTitle(input);

  if (keepBytes) {
    const staged = await stageSourceBlob({
      database,
      userId,
      buffer: input.file!.buffer,
      mimeType: input.file!.mimeType,
      filename: input.file!.filename ?? title,
      workspaceId: input.workspaceId ?? null,
      keyScope: `intake-${contentHash.slice(0, 16)}`,
      ...(input.file!.extractedText
        ? { extractedText: input.file!.extractedText }
        : {}),
      ...(input.file!.extractedTextTruncated
        ? { extractedTextTruncated: true }
        : {}),
      metadata: { [INTAKE_SOURCE_METADATA_KEY]: sourceMeta },
    });
    return {
      documentId: staged.documentId,
      contentHash,
      deduplicated: false,
      degraded: Boolean(input.degraded),
    };
  }

  const { storage } = await import("@synap/storage");
  const documentId = randomUUID();
  const content = body as string;
  const uploaded = await storage.upload(
    storage.buildPath(userId, "document", documentId, "md"),
    content,
    { contentType: "text/markdown" }
  );
  await new DocumentRepository(database, eventRepository).create(
    {
      id: documentId,
      title,
      type: "markdown",
      storageUrl: uploaded.url,
      storageKey: uploaded.path,
      size: uploaded.size,
      mimeType: "text/markdown",
      metadata: { [INTAKE_SOURCE_METADATA_KEY]: sourceMeta },
      userId,
      workspaceId: input.workspaceId ?? null,
      content,
    },
    userId
  );
  return {
    documentId,
    contentHash,
    deduplicated: false,
    degraded: Boolean(input.degraded),
  };
}
