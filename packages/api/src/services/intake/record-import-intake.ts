/**
 * recordImportIntake — what an import analyze persists about its run:
 * every item as a source document (`stageIntakeSource`, kind `import_item`),
 * then the run manifest on the import's session.
 *
 * Before this, an import item's content lived only in the request (and, for a
 * background corpus, in the pg-boss job payload), so a rerun could not find its
 * input (intake plan B6).
 *
 * Bounded concurrency; a failed item is COUNTED and named in `errors`, never
 * silently dropped, and never fails the import.
 */

import { createLogger } from "@synap-core/core";
import type { db as DbType } from "@synap/database";
import { stageIntakeSource } from "./stage-intake-source.js";
import {
  recordSessionRunManifest,
  runFactsFromStructureMeta,
  type RunManifestPatch,
  type SessionRunManifest,
  type StructureRunMeta,
} from "./record-session-run-manifest.js";

/**
 * The engine facts of an import analyze, by the path it actually took:
 *  - deep structuring → the IS facts of its structure calls (`unknown` when no
 *    call carried `meta`, i.e. an older IS — never guessed);
 *  - shallow with AI enrichment → `unknown` (the enrich call sends no facts);
 *  - shallow with AI switched off → `deterministic`, nothing answered.
 */
export function importRunFacts(
  mode: "deep" | "shallow",
  aiStructure: boolean | undefined,
  deepMeta: StructureRunMeta | null | undefined
): Pick<SessionRunManifest, "engine" | "model" | "provider" | "promptVersion"> {
  if (mode === "deep") return runFactsFromStructureMeta(deepMeta ?? undefined);
  if (aiStructure === false) {
    return {
      engine: "deterministic",
      model: null,
      provider: null,
      promptVersion: "none",
    };
  }
  return runFactsFromStructureMeta(undefined);
}

const logger = createLogger({ module: "intake/record-import-intake" });

const STAGE_CONCURRENCY = 8;
const MAX_ERRORS_REPORTED = 20;

export interface RecordImportIntakeResult {
  sourceDocumentIds: string[];
  sourcesFailed: number;
  /** Items with no content to store (nothing to fail, nothing stored). */
  sourcesEmpty: number;
  manifest: "recorded" | "not_found" | "failed" | "no_session";
  errors?: string[];
}

export async function recordImportIntake(input: {
  database: typeof DbType;
  userId: string;
  workspaceId: string | null;
  sessionId: string | null;
  source: string;
  items: ReadonlyArray<{ path: string; content: string }>;
  /** Manifest facts beyond the sources (guidelines, engine, model, …). */
  run: Omit<RunManifestPatch, "sourceDocumentIds">;
}): Promise<RecordImportIntakeResult> {
  const ids: Array<string | undefined> = new Array(input.items.length);
  const errors: string[] = [];
  let failed = 0;
  let empty = 0;

  for (let start = 0; start < input.items.length; start += STAGE_CONCURRENCY) {
    const wave = input.items.slice(start, start + STAGE_CONCURRENCY);
    await Promise.all(
      wave.map(async (item, offset) => {
        if (!item.content?.trim()) {
          empty++;
          return;
        }
        try {
          const staged = await stageIntakeSource({
            database: input.database,
            userId: input.userId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            door: "import",
            kind: "import_item",
            path: item.path,
            title: item.path.split("/").pop() || item.path,
            text: item.content,
          });
          ids[start + offset] = staged.documentId;
        } catch (err) {
          failed++;
          if (errors.length < MAX_ERRORS_REPORTED) {
            errors.push(
              `${item.path}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      })
    );
  }
  const sourceDocumentIds = ids.filter((v): v is string => Boolean(v));
  if (failed > 0) {
    logger.error(
      { userId: input.userId, sessionId: input.sessionId, failed },
      "import intake: some item sources NOT stored"
    );
  }

  let manifest: RecordImportIntakeResult["manifest"] = "no_session";
  if (input.sessionId) {
    try {
      const recorded = await recordSessionRunManifest({
        database: input.database,
        sessionId: input.sessionId,
        userId: input.userId,
        patch: { ...input.run, sourceDocumentIds },
      });
      manifest = recorded.ok ? "recorded" : recorded.reason;
    } catch (err) {
      manifest = "failed";
      logger.error(
        { err, userId: input.userId, sessionId: input.sessionId },
        "import intake: run manifest NOT recorded"
      );
      errors.push(
        `manifest: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    sourceDocumentIds,
    sourcesFailed: failed,
    sourcesEmpty: empty,
    manifest,
    ...(errors.length ? { errors } : {}),
  };
}
