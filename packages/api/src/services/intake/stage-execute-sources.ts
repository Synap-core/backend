/**
 * stageExecuteSources — the raw door for `capture.execute` (founder rule
 * 2026-09-14: the raw capture is always kept).
 *
 * `capture.structure` stages its raw inputs and stamps each with the plan it
 * structured (`intakeSource.planKeys`). An execute of THAT plan finds them here
 * by run session + plan key and stages nothing. An execute with no such source —
 * relay's offline queue, a hub/CLI caller that skipped structure, a plan the
 * client edited before executing — stages what it RECEIVED (the plan it was
 * handed, and its file) through `stageCaptureSources`, door `capture.execute`.
 *
 * Why the plan key and not the session: a person's own session holds many
 * captures, so "the session already has sources" would attribute every one of
 * them to this capture's writes.
 *
 * Never throws. A failed lookup is named in `errors` and the raw is staged
 * anyway — a failed read is never read as "no source".
 */

import {
  documents as documentsTable,
  and,
  eq,
  isNull,
  drizzleSql,
  type db as DbType,
} from "@synap/database";
import type { StagedSourceBlob } from "../../utils/store-entity-source-blob.js";
import { stageCaptureSources } from "./record-structure-intake.js";
import { recordSessionRunManifest } from "./record-session-run-manifest.js";

export const EXECUTE_SOURCE_DOOR = "capture.execute";

export interface ExecutePlanEntity {
  profileSlug: string;
  title: string;
  description?: string;
  content?: string;
  properties?: Record<string, unknown>;
}

export interface StageExecuteSourcesInput {
  database: typeof DbType;
  userId: string;
  workspaceId: string | null;
  /** The run room execute ensured; `null` when minting failed. */
  sessionId: string | null;
  /** `capturePlanKey(entities, relations)`; `undefined` for an empty plan. */
  planKey: string | undefined;
  entities: ReadonlyArray<ExecutePlanEntity>;
  file?: {
    content: string;
    mimeType: string;
    filename?: string;
    extractedText?: string;
    extractedTextTruncated?: boolean;
  };
  keepRaw?: boolean;
}

export interface ExecuteSources {
  /** The raw documents this capture was made from. Empty ⇒ nothing was kept. */
  sourceDocumentIds: string[];
  /** `run`: structure had staged them; `staged`: this execute did. */
  origin: "run" | "staged";
  /** The file's kept ORIGINAL bytes, when this execute staged them. */
  fileBlob?: StagedSourceBlob;
  errors: string[];
}

/** The plan as received, rendered readable — what an execute-only capture's raw IS. */
export function renderExecutePlanText(
  entities: ReadonlyArray<ExecutePlanEntity>
): string {
  return entities
    .map((e) => {
      const props = Object.entries(e.properties ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(
          ([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`
        );
      return [
        `# ${e.title.trim() || "Untitled"} (${e.profileSlug})`,
        e.description?.trim(),
        e.content?.trim(),
        props.length ? props.join("\n") : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
    })
    .join("\n\n---\n\n");
}

export async function stageExecuteSources(
  input: StageExecuteSourcesInput
): Promise<ExecuteSources> {
  const errors: string[] = [];
  if (input.sessionId && input.planKey) {
    try {
      const rows = await input.database
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(
          and(
            eq(documentsTable.userId, input.userId),
            isNull(documentsTable.deletedAt),
            drizzleSql`${documentsTable.metadata} #>> '{intakeSource,sessionId}' = ${input.sessionId}`,
            drizzleSql`${documentsTable.metadata} -> 'intakeSource' -> 'planKeys' @> ${JSON.stringify([input.planKey])}::jsonb`
          )
        )
        .orderBy(documentsTable.createdAt);
      if (rows.length > 0) {
        return {
          sourceDocumentIds: rows.map((r) => r.id),
          origin: "run",
          errors,
        };
      }
    } catch (err) {
      errors.push(
        `run sources: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const text = renderExecutePlanText(input.entities);
  const staged = await stageCaptureSources({
    database: input.database,
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    door: EXECUTE_SOURCE_DOOR,
    source: {
      ...(input.entities.length ? { text } : {}),
      ...(input.file
        ? {
            file: {
              content: input.file.content,
              mimeType: input.file.mimeType,
              ...(input.file.filename ? { filename: input.file.filename } : {}),
            },
          }
        : {}),
    },
    ...(input.file?.extractedText
      ? { extractedText: input.file.extractedText }
      : {}),
    ...(input.file?.extractedTextTruncated
      ? { extractedTextTruncated: true }
      : {}),
    ...(input.keepRaw !== undefined ? { keepRaw: input.keepRaw } : {}),
    ...(input.planKey ? { planKey: input.planKey } : {}),
  });
  errors.push(...staged.errors);

  if (input.sessionId && staged.sourceDocumentIds.length > 0) {
    try {
      const recorded = await recordSessionRunManifest({
        database: input.database,
        sessionId: input.sessionId,
        userId: input.userId,
        patch: {
          sourceDocumentIds: staged.sourceDocumentIds,
          ...(staged.fileExtraction
            ? { extractions: [staged.fileExtraction] }
            : {}),
        },
      });
      if (!recorded.ok) errors.push(`manifest: ${recorded.reason}`);
    } catch (err) {
      errors.push(
        `manifest: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    sourceDocumentIds: staged.sourceDocumentIds,
    origin: "staged",
    ...(staged.fileBlob ? { fileBlob: staged.fileBlob } : {}),
    errors,
  };
}
