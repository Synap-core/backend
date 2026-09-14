/**
 * STRUCTURE AGAIN — "the first extraction is not the only chance" (W2).
 *
 * Takes an entity the caller can READ (a note, a raw capture that landed as a
 * plain entity) and runs its text through the SAME intake path a capture takes:
 *
 *   1. read the entity through the access layer (`scopedDb` — the caller's own
 *      visibility floor, never a raw id lookup) and its body (title + preview +
 *      the latest document content);
 *   2. mint a NEW intake run (`ensureIntakeSession`, origin human/agent from the
 *      caller), `subject_entity_id` = the entity — that column IS the link from
 *      the run to what it is about;
 *   3. stage the text as an intake source (`stageIntakeSource`) and record it on
 *      the run manifest BEFORE structuring, so a structure call that degrades or
 *      fails still leaves a run the room can show and Rerun can replay;
 *   4. replay it through the capture door (`replayCaptureSource` — the rerun
 *      door's own replayer: `capture.structure` → `submitCaptureGraph`). Its
 *      `recordStructureIntake` stages the identical text into the same session
 *      and dedups onto step 3's document (same session + content hash).
 *
 * No parallel pipeline: every write is filed by the governed capture door on its
 * own proposal, so an agent caller is governed exactly like an agent capture.
 *
 * A double-press inside {@link STRUCTURE_AGAIN_DEDUPE_WINDOW_MS} reuses the run
 * it already minted (`reused`) and replays nothing again.
 *
 * A STORED FILE (the entity's document is a kept photo/PDF with no extracted
 * text and no version row) is replayed as that file — base64, its own mime type,
 * `reanalyze` via the replayer — never its bytes decoded as text. Only a `text/*`
 * stored object is read as text.
 *
 * ONE source row per run: the replay names the row step 3 staged
 * (`sourceDocumentId` → staging's `reuseDocumentId`), so a body over the
 * structure text cap replayed as a markdown FILE, or a stored file whose text the
 * IS extracts, lands on that row instead of a second one with a different hash
 * (pinned by `intake/__tests__/replay-reuses-raw.pglite.test.ts`).
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  desc,
  eq,
  isNull,
  entities,
  documents as documentsTable,
  documentVersions,
} from "@synap/database";
import type { Context } from "../../types/context.js";
import { AccessContext } from "../../access/context.js";
import { scopedDb } from "../../access/scoped-db.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { ensureIntakeSession } from "./ensure-intake-session.js";
import { stageIntakeSource } from "./stage-intake-source.js";
import { recordSessionRunManifest } from "./record-session-run-manifest.js";
import {
  replayCaptureSource,
  STRUCTURE_TEXT_MAX,
  type RerunItemResult,
  type RerunSource,
} from "../focus-sessions/rerun-session.js";

const logger = createLogger({ module: "intake/structure-again" });

/** Identical requests (same entity + user) inside this window reuse one run. */
export const STRUCTURE_AGAIN_DEDUPE_WINDOW_MS = 60_000;

/** The source-document `door` marker for a run started from an entity. */
export const STRUCTURE_AGAIN_DOOR = "structure_again";

export type StructureAgainRefusal =
  "not_found" | "no_text" | "mint_failed" | "source_not_kept";

export type StructureAgainResult =
  | { ok: false; reason: StructureAgainRefusal; message: string }
  | {
      ok: true;
      /** The same request already started this run: nothing was replayed again. */
      status: "reused";
      sessionId: string;
      entityId: string;
    }
  | ({
      ok: true;
      status: "structured";
      sessionId: string;
      entityId: string;
      sourceDocumentId: string;
      /** False when the manifest could not record the source (rerun can't see it). */
      manifestRecorded: boolean;
    } & Omit<RerunItemResult, "sourceDocumentIds" | "door">);

type CaptureReplay = typeof replayCaptureSource;

export async function structureAgain(args: {
  entityId: string;
  userId: string;
  /** Set when an agent credential drives it (attribution + governance). */
  agentUserId?: string | null;
  /** The caller's tRPC context: the access floor AND the capture replay run under it. */
  callerContext: Context;
  /** Injected for tests; defaults to the capture door replay. */
  replay?: CaptureReplay;
  /** Injected for tests; the dedupe window's clock. */
  now?: Date;
  database?: typeof db;
}): Promise<StructureAgainResult> {
  const database = args.database ?? db;

  const entity = await scopedDb(
    AccessContext.from(args.callerContext)
  ).findFirst<{
    id: string;
    userId: string;
    workspaceId: string | null;
    title: string | null;
    preview: string | null;
    documentId: string | null;
  }>(entities, {
    where: and(eq(entities.id, args.entityId), isNull(entities.deletedAt)),
    columns: {
      id: true,
      userId: true,
      workspaceId: true,
      title: true,
      preview: true,
      documentId: true,
    },
  });
  if (!entity) {
    return {
      ok: false,
      reason: "not_found",
      message: `Entity ${args.entityId} not found`,
    };
  }

  const title = entity.title?.trim() ?? "";
  const body = entity.documentId
    ? await readDocumentBody(database, entity.documentId)
    : null;
  // A stored FILE (a kept photo/PDF whose text was never extracted) is replayed
  // as that file — never its bytes decoded as text.
  const storedFile = body && "file" in body ? body.file : null;
  const text = storedFile
    ? ""
    : composeEntityText({
        title,
        preview: entity.preview,
        content: body && "text" in body ? body.text : null,
      });
  if (!storedFile && !text) {
    return {
      ok: false,
      reason: "no_text",
      message:
        "This item has no text to structure — add a description or content first.",
    };
  }

  // The run files into the entity's placement: write access is checked on the
  // LOADED row, never a request-supplied workspace.
  await assertWorkspaceWrite(database, args.userId, {
    workspaceId: entity.workspaceId,
    ownerId: entity.userId,
  });

  const minted = await ensureIntakeSession({
    userId: args.userId,
    workspaceId: entity.workspaceId,
    agentUserId: args.agentUserId ?? null,
    door: "capture",
    goal: `Structure again · ${title || "untitled"}`,
    correlationKey: `structure-again:${entity.id}:${args.userId}:${Math.floor(
      (args.now ?? new Date()).getTime() / STRUCTURE_AGAIN_DEDUPE_WINDOW_MS
    )}`,
    subjectEntityId: entity.id,
  });
  if (minted.status === "failed") {
    return {
      ok: false,
      reason: "mint_failed",
      message: `The run could not be created, so nothing was structured: ${minted.error}`,
    };
  }
  const sessionId = minted.sessionId;
  if (minted.status === "minted" && minted.reused) {
    return { ok: true, status: "reused", sessionId, entityId: entity.id };
  }

  const replayText = text.length <= STRUCTURE_TEXT_MAX;
  let sourceDocumentId: string;
  try {
    const staged = await stageIntakeSource({
      database,
      userId: args.userId,
      workspaceId: entity.workspaceId,
      sessionId,
      door: STRUCTURE_AGAIN_DOOR,
      title: title || undefined,
      ...(storedFile
        ? {
            kind: "file" as const,
            file: {
              buffer: storedFile.buffer,
              mimeType: storedFile.mimeType,
              filename: storedFile.filename,
              keepBytes: true,
            },
          }
        : { kind: "text" as const, text }),
    });
    sourceDocumentId = staged.documentId;
  } catch (err) {
    logger.error(
      { err, entityId: entity.id, sessionId },
      "structure again: the source could not be kept — not structuring"
    );
    return {
      ok: false,
      reason: "source_not_kept",
      message: `The text could not be kept as this run's source, so nothing was structured: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let manifestRecorded = false;
  try {
    const recorded = await recordSessionRunManifest({
      database,
      sessionId,
      userId: args.userId,
      patch: { sourceDocumentIds: [sourceDocumentId] },
    });
    manifestRecorded = recorded.ok;
  } catch (err) {
    logger.error(
      { err, sessionId },
      "structure again: run manifest NOT recorded"
    );
  }

  const source: Extract<RerunSource, { door: "capture" }> = {
    sourceDocumentId,
    door: "capture",
    kind: storedFile ? "file" : "text",
    degraded: false,
    input: storedFile
      ? {
          file: {
            content: storedFile.buffer.toString("base64"),
            mimeType: storedFile.mimeType,
            filename: storedFile.filename,
            encoding: "base64",
          },
        }
      : replayText
        ? { text }
        : {
            file: {
              content: text,
              mimeType: "text/markdown",
              filename: `${title || "note"}.md`,
              encoding: "utf8",
            },
          },
  };
  const replay = args.replay ?? replayCaptureSource;
  let item: Omit<RerunItemResult, "sourceDocumentIds" | "door">;
  try {
    item = await replay(
      source,
      {
        childSessionId: sessionId,
        idempotencyNamespace: `structure-again:${sessionId}`,
        workspaceId: entity.workspaceId,
        projectId: null,
      },
      {
        userId: args.userId,
        agentUserId: args.agentUserId ?? null,
        callerContext: args.callerContext,
      }
    );
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "structure again: the capture door failed — the source stays in the run"
    );
    item = {
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    status: "structured",
    sessionId,
    entityId: entity.id,
    sourceDocumentId,
    manifestRecorded,
    ...item,
  };
}

/** Title, then preview, then content — a preview that the content already starts with is not repeated. */
export function composeEntityText(parts: {
  title: string | null | undefined;
  preview: string | null | undefined;
  content: string | null | undefined;
}): string {
  const title = parts.title?.trim() ?? "";
  const preview = parts.preview?.trim() ?? "";
  const content = parts.content?.trim() ?? "";
  const body = [
    preview && !content.startsWith(preview) ? preview : "",
    content,
  ].filter(Boolean);
  // A title alone is not raw material to structure.
  if (body.length === 0) return "";
  return [title, ...body].filter(Boolean).join("\n\n");
}

/**
 * An entity document's body: its latest version's text, else the stored object.
 * The stored object is read as TEXT only for a `text/*` mime type; any other
 * stored object (a kept photo/PDF with no extracted text — decision C sets such
 * a blob as `entities.documentId`) comes back as a FILE, so its bytes are never
 * decoded as text and sent to the structurer. No readable body ⇒ `null`.
 */
async function readDocumentBody(
  database: typeof db,
  documentId: string
): Promise<
  | { text: string }
  | { file: { buffer: Buffer; mimeType: string; filename: string } }
  | null
> {
  const [version] = await database
    .select({ content: documentVersions.content })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  if (version?.content?.trim()) return { text: version.content };
  const [doc] = await database
    .select({
      storageKey: documentsTable.storageKey,
      mimeType: documentsTable.mimeType,
      title: documentsTable.title,
    })
    .from(documentsTable)
    .where(
      and(eq(documentsTable.id, documentId), isNull(documentsTable.deletedAt))
    )
    .limit(1);
  // Locals, so the null checks narrow across the awaits below.
  const storageKey = doc?.storageKey ?? null;
  const mimeType = doc?.mimeType ?? null;
  if (!storageKey || !mimeType) return null;
  const { storage } = await import("@synap/storage");
  const buffer = await storage.downloadBuffer(storageKey);
  if (mimeType.startsWith("text/")) {
    const text = buffer.toString("utf8");
    return text.trim() ? { text } : null;
  }
  return {
    file: {
      buffer,
      mimeType,
      filename: doc?.title?.trim() || "source",
    },
  };
}
