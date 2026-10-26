/**
 * Document passages — keep each document's recall passages current (recall
 * plan A-W2; the recall leg that reads them is A-W3).
 *
 * TWO queues, ONE builder:
 *   • `document-passages` (on-demand) — `{ documentId }`. Enqueued through
 *     the one door `enqueueDocumentPassages` (`events/side-effects.ts`, a
 *     trailing debounce per document) by the `document-passages` reactor on
 *     every document create/update event, the sweep and the backfill.
 *   • `document-passages-sweep` (cron, every 15 min) — the floor: any document
 *     whose passages were built from an older `content_revision` than it has
 *     now is re-queued, so an edit whose event was missed self-heals. A
 *     document never built is left to the backfill script
 *     (`scripts/index-document-passages.ts`) — a first build is planned, never
 *     a side effect of a deploy.
 *
 * The build: read the STORED body (`loadDocumentBodyTexts`, markdown kept so
 * the splitter sees the headings), cut it with markdown-core
 * `segmentPassages` (the one splitter), embed "title › heading" + the
 * passage's prose through the IS, and replace the document's rows. A passage
 * whose embedded text is unchanged (`text_hash`) keeps its vector: an edit
 * costs only the passages it touched. When the passages changed, the entities
 * that own the document are re-embedded too (their vector reads the body).
 *
 * A body that cannot be read keeps its old passages and records the failure on
 * `document_passage_state` — never "no text". An embedding failure throws:
 * nothing is written and pg-boss retries.
 */

import { createHash } from "node:crypto";
import type PgBoss from "pg-boss";
import {
  db,
  drizzleSql,
  and,
  eq,
  isNull,
  inArray,
  documents,
  entities,
  documentPassages,
  documentPassageState,
  loadDocumentBodyTexts,
} from "@synap/database";
import { getBoss, enqueueDocumentPassages } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { segmentPassages } from "@synap-core/markdown-core/sections";
import { markdownToPlainText } from "@synap-core/markdown-core/plain-text";
import { generateEmbeddings } from "./is-embeddings.js";

const logger = createLogger({ module: "document-passages-worker" });

export const DOCUMENT_PASSAGES_QUEUE = "document-passages";
export const DOCUMENT_PASSAGES_SWEEP_QUEUE = "document-passages-sweep";
export const DOCUMENT_PASSAGES_SWEEP_CRON = "*/15 * * * *";

/** Documents re-queued per sweep tick. */
export const PASSAGES_SWEEP_BATCH = 50;

/**
 * Document types whose body is text to cut into passages. A Library item
 * (`metadata.importItem`) keeps its own recall lane and is left out.
 */
export const PASSAGE_DOCUMENT_TYPES = ["markdown", "text"] as const;

export interface DocumentPassagesJobData {
  documentId: string;
  /** Embed every passage again, ignoring kept vectors (a planned model change). */
  reembed?: boolean;
}

export type DocumentPassagesResult =
  | { status: "skipped"; reason: "missing" | "deleted" | "not-text" }
  | { status: "failed"; failure: string }
  | { status: "built"; passages: number; embedded: number; changed: boolean };

/** What a passage is embedded as: "title › heading", then its prose. */
function embedInput(title: string, heading: string, prose: string): string {
  const path =
    heading && heading.trim().toLowerCase() !== title.trim().toLowerCase()
      ? `${title} › ${heading}`
      : title;
  return `${path}\n\n${prose}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function handleDocumentPassages(
  job: Pick<PgBoss.Job<DocumentPassagesJobData>, "data">
): Promise<DocumentPassagesResult> {
  const { documentId, reembed = false } = job.data;

  // The revision is read BEFORE the body: an edit landing in between stamps
  // the older revision on the newer text, and the sweep builds it once more.
  // The other order would stamp a newer revision on older text, for good.
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      type: documents.type,
      metadata: documents.metadata,
      contentRevision: documents.contentRevision,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) return { status: "skipped", reason: "missing" };
  if (doc.deletedAt) return { status: "skipped", reason: "deleted" };
  const meta = doc.metadata as { importItem?: unknown } | null;
  if (
    !(PASSAGE_DOCUMENT_TYPES as readonly string[]).includes(doc.type) ||
    (meta && typeof meta === "object" && meta.importItem)
  ) {
    return { status: "skipped", reason: "not-text" };
  }

  const bodies = await loadDocumentBodyTexts(db, [documentId], {
    markdownText: (markdown) => markdown,
  });
  const failure = bodies.failed.get(documentId);
  if (failure !== undefined) {
    await db
      .insert(documentPassageState)
      .values({ documentId, failure, failedAt: new Date() })
      .onConflictDoUpdate({
        target: documentPassageState.documentId,
        set: { failure, failedAt: new Date(), updatedAt: new Date() },
      });
    logger.warn(
      { documentId, failure },
      "document-passages: body unreadable, previous passages kept"
    );
    return { status: "failed", failure };
  }
  // No text (an empty body, legacy editor state) = no passages: a fact.
  const markdown = bodies.texts.get(documentId) ?? "";

  const next = segmentPassages(markdown)
    .map((p) => ({ passage: p, prose: markdownToPlainText(p.text).trim() }))
    .filter(({ prose }) => prose.length > 0)
    .map(({ passage, prose }, ordinal) => {
      const input = embedInput(doc.title, passage.heading, prose);
      return {
        documentId,
        ordinal,
        sectionId: passage.id,
        headingPath: passage.heading,
        charStart: passage.start,
        charEnd: passage.end,
        text: prose,
        textHash: sha256(input),
        sourceRevision: doc.contentRevision,
        input,
      };
    });

  const existing = await db
    .select({
      ordinal: documentPassages.ordinal,
      textHash: documentPassages.textHash,
      embedding: documentPassages.embedding,
      embeddingModel: documentPassages.embeddingModel,
    })
    .from(documentPassages)
    .where(eq(documentPassages.documentId, documentId));
  const kept = new Map<string, { embedding: number[]; model: string }>();
  if (!reembed) {
    for (const row of existing) {
      kept.set(row.textHash, {
        embedding: row.embedding,
        model: row.embeddingModel,
      });
    }
  }

  const toEmbed = next.filter((p) => !kept.has(p.textHash));
  const fresh = new Map<string, { embedding: number[]; model?: string }>();
  if (toEmbed.length > 0) {
    const { embeddings, model } = await generateEmbeddings(
      toEmbed.map((p) => p.input)
    );
    toEmbed.forEach((p, i) =>
      fresh.set(p.textHash, { embedding: embeddings[i]!, model })
    );
  }

  const before = new Map(existing.map((r) => [r.ordinal, r.textHash]));
  const changed =
    reembed ||
    existing.length !== next.length ||
    next.some((p) => before.get(p.ordinal) !== p.textHash);

  await db.transaction(async (tx) => {
    if (changed) {
      await tx
        .delete(documentPassages)
        .where(eq(documentPassages.documentId, documentId));
      if (next.length > 0) {
        await tx.insert(documentPassages).values(
          next.map(({ input: _input, ...row }) => {
            const vector = fresh.get(row.textHash) ?? kept.get(row.textHash)!;
            return {
              ...row,
              embedding: vector.embedding,
              ...(vector.model ? { embeddingModel: vector.model } : {}),
            };
          })
        );
      }
    } else {
      // Same passages: only the revision they reflect moves.
      await tx
        .update(documentPassages)
        .set({ sourceRevision: doc.contentRevision })
        .where(eq(documentPassages.documentId, documentId));
    }
    await tx
      .insert(documentPassageState)
      .values({
        documentId,
        sourceRevision: doc.contentRevision,
        passageCount: next.length,
      })
      .onConflictDoUpdate({
        target: documentPassageState.documentId,
        set: {
          sourceRevision: doc.contentRevision,
          passageCount: next.length,
          failure: null,
          failedAt: null,
          updatedAt: new Date(),
        },
      });
  });

  if (changed) {
    // The owning entities' vectors read the body too: re-embed them, with the
    // same per-entity debounce as the entity reactor.
    const owners = await db
      .select({ id: entities.id, userId: entities.userId })
      .from(entities)
      .where(
        and(eq(entities.documentId, documentId), isNull(entities.deletedAt))
      );
    const boss = getBoss();
    for (const owner of owners) {
      await boss.send(
        "entity-embedding",
        { entityId: owner.id, userId: owner.userId },
        {
          singletonKey: `entity-embedding:${owner.id}`,
          singletonSeconds: 30,
        }
      );
    }
  }

  logger.info(
    { documentId, passages: next.length, embedded: toEmbed.length, changed },
    "document-passages built"
  );
  return {
    status: "built",
    passages: next.length,
    embedded: toEmbed.length,
    changed,
  };
}

/**
 * The sweep's candidate predicate (exported so a PGlite test drives the real
 * one): a live text document whose passages were built from an older
 * revision than it has now.
 */
export function passagesSweepCandidatesWhere() {
  return drizzleSql`(
    ${documents.deletedAt} IS NULL
    AND ${documentPassageState.sourceRevision} IS DISTINCT FROM ${documents.contentRevision}
  )`;
}

export async function handleDocumentPassagesSweep(
  _job?: PgBoss.Job
): Promise<{ queued: number }> {
  // A failed read throws: pg-boss records the tick as failed, never as a
  // calm "nothing to do".
  const rows = await db
    .select({ id: documents.id })
    .from(documentPassageState)
    .innerJoin(documents, eq(documents.id, documentPassageState.documentId))
    .where(
      and(
        passagesSweepCandidatesWhere(),
        inArray(documents.type, [...PASSAGE_DOCUMENT_TYPES])
      )
    )
    .orderBy(documentPassageState.updatedAt)
    .limit(PASSAGES_SWEEP_BATCH);
  const boss = getBoss();
  for (const row of rows) {
    await enqueueDocumentPassages({ documentId: row.id }, boss);
  }
  return { queued: rows.length };
}
