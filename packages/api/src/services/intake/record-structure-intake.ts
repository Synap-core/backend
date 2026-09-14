/**
 * recordStructureIntake — what `capture.structure` persists about ONE structure
 * call, composed from the three intake doors:
 *
 *   ensureIntakeSession → stageIntakeSource (per input) → recordSessionRunManifest
 *
 * Called on EVERY structure outcome that reached the assembler: a real plan, a
 * clarifying follow-up, an empty result and a degraded fallback. For a degraded
 * outcome the source is stored WITH the `degraded` marker and no proposal is
 * filed (`shouldPersistCapturePlan` still refuses) — "no queue debt, source
 * kept" (intake decision D6).
 *
 * Never throws: a capture must not fail because its room could not be
 * recorded. But a failure is never folded into success either — each step that
 * failed is named in `intake.errors` and `intake.status` says `partial` /
 * `failed`, and a degraded capture whose source could NOT be kept says so in
 * `degradedSourceKept: false`.
 */

import { createHash } from "crypto";
import { createLogger } from "@synap-core/core";
import type { db as DbType } from "@synap/database";
import {
  ensureIntakeSession,
  rememberIntakePlanKey,
  type EnsureIntakeSessionResult,
} from "./ensure-intake-session.js";
import { computeCaptureGraphIdempotencyKey } from "../../utils/pending-capture-dedup.js";
import { stageIntakeSource } from "./stage-intake-source.js";
import type { StagedSourceBlob } from "../../utils/store-entity-source-blob.js";
import {
  recordSessionRunManifest,
  type RunGuidelineRef,
  type RunSourceExtraction,
  type SessionRunManifest,
} from "./record-session-run-manifest.js";

/**
 * Keep a file's original bytes when the caller did not say? Photos: yes
 * (founder default 2026-09-13 — a photo run is reproducible only from its
 * stored source; "extract text only" is the per-run opt-out). Other files keep
 * today's rule: their extracted text.
 */
export function defaultKeepOriginal(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

const logger = createLogger({ module: "intake/record-structure-intake" });

export interface IntakeEcho {
  /** The session this run ACTUALLY belongs to (null only when minting failed). */
  sessionId: string | null;
  intake: {
    status: "recorded" | "partial" | "failed";
    sessionSource: "provided" | "minted" | "failed";
    /** A session handle was sent but a different (verified/minted) one was used. */
    requestedSessionIgnored: boolean;
    sourceDocumentIds: string[];
    /** Present only for a degraded outcome: was the input kept for re-structure? */
    degradedSourceKept?: boolean;
    /**
     * Present whenever at least one source was attempted, on EVERY outcome:
     * false when any input could not be stored (the reason is in `errors`).
     */
    sourcesKept?: boolean;
    /** `keepRaw: false` was overridden — the file was not read, bytes kept. */
    originalRetainedUntilStructured?: true;
    errors?: string[];
  };
}

export interface RecordStructureIntakeInput {
  database: typeof DbType;
  userId: string;
  workspaceId: string | null;
  agentUserId?: string | null;
  verifiedHandle?: string | null;
  bodyHandle?: string | null;
  source: {
    text?: string;
    url?: string;
    html?: string;
    file?: {
      content: string;
      mimeType: string;
      filename?: string;
      encoding?: "base64" | "utf8";
    };
    /** Client-declared sha256 of the original asset (the second ledger key). */
    sourceSha256?: string;
  };
  /** `extraction.text` the IS returned for a file input, when it did. */
  extractedText?: string;
  extractedTextTruncated?: boolean;
  /** Set when the outcome is a degraded fallback (IS or pod reason). */
  degraded?: { reason: string };
  /**
   * The FILE was not read (IS `extraction.degraded`, e.g. a photo with no
   * vision model) while the outcome itself is NOT degraded — its caption
   * structured. Marks only the file source degraded, so the "already
   * imported" ledger reads it `kept_unanalyzed` and a re-send re-analyzes.
   */
  fileNotRead?: { reason: string };
  /**
   * Keep the file's ORIGINAL bytes. `undefined` → {@link defaultKeepOriginal}
   * (photos kept: rerun needs the source). `false` = "extract text only" —
   * honoured whenever the file WAS read. When nothing could be read (degraded
   * or no extracted text) the bytes are kept anyway and marked
   * `retainedUntilStructured` (founder rule 2026-09-14: raw is never lost
   * before it is structured); the echo says `originalRetainedUntilStructured`.
   */
  keepRaw?: boolean;
  /**
   * The session the door ALREADY ensured (e.g. the MCP graph lane, which must
   * file its graph into the room before recording). Skips a second ensure; a
   * `failed` result still stages the sources with no session.
   */
  ensuredSession?: EnsureIntakeSessionResult;
  /** Who read the file (IS `extraction.extractor` + the vision identity). */
  extraction?: {
    extractor: string | null;
    model: string | null;
    provider: string | null;
  };
  guidelines: RunGuidelineRef[];
  /** Absent when no guideline read happened (an agent-structured graph). */
  guidelineStatus?: "ok" | "unavailable";
  /**
   * Override the retry key. `undefined` → derived from the input content (a
   * retry of the same capture reuses its room); `null` → no reuse at all, for
   * a door whose input carries no stable identity of its own.
   */
  correlationKey?: string | null;
  /** Override the minted session's goal. */
  goal?: string;
  /** `capturePlanKey` of the plan structure returned — remembered on the room. */
  planKey?: string;
  /** A replay of a stored raw: staging reuses this row (see `stageCaptureSources`). */
  reuseSourceDocumentId?: string;
  runFacts: Pick<
    SessionRunManifest,
    "engine" | "model" | "provider" | "promptVersion" | "timings"
  >;
}

/**
 * The guideline `sourceKind` rung a capture structure call reads — the ONE
 * derivation, so a `screenshot`/`image` guideline reaches every capture door
 * identically. `import:<source>` is the import doors' spelling of the same rung.
 */
export function structureSourceKind(input: {
  file?: { mimeType: string } | null;
  url?: string | null;
}): "image" | "audio" | "file" | "url" | "text" {
  if (input.file) {
    if (input.file.mimeType.startsWith("image/")) return "image";
    if (input.file.mimeType.startsWith("audio/")) return "audio";
    return "file";
  }
  return input.url ? "url" : "text";
}

/**
 * THE plan key — one derivation for both halves of a capture (decision F).
 * `capture.structure` returns a plan (`proposals` + `relations`); the client
 * echoes it to `capture.execute` as `entities` + `relations`. Both carry the
 * same `tempId`/`profileSlug`/`title`/… fields, so the canonical content hash
 * (`computeCaptureGraphIdempotencyKey`, order-independent) matches across the
 * two calls — WITHOUT the raw text, which execute never receives.
 *
 * Workspace/project are deliberately NOT folded in (routing may move execute).
 * A client that EDITS the plan before executing gets a different key and a fresh
 * room — honest: it is a different plan. Day-bucketed like the retry keys.
 * `undefined` for an empty plan (nothing to match on).
 */
export function capturePlanKey(
  entities: unknown,
  relations: unknown
): string | undefined {
  const list = Array.isArray(entities)
    ? (entities as Array<Record<string, unknown>>)
    : [];
  if (list.length === 0) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const rels = Array.isArray(relations)
    ? (relations as Array<Record<string, unknown>>)
    : [];
  const key = computeCaptureGraphIdempotencyKey({
    workspaceId: null,
    projectId: null,
    entities: list.map((e) => ({
      ref: str(e.tempId) ?? "",
      profileSlug: str(e.profileSlug) ?? "",
      title: str(e.title),
      description: str(e.description),
      content: str(e.content),
      properties:
        e.properties && typeof e.properties === "object"
          ? (e.properties as Record<string, unknown>)
          : undefined,
    })),
    relations: rels.map((r) => ({
      sourceRef: str(r.sourceTempId) ?? "",
      targetRef: str(r.targetTempId) ?? "",
      type: str(r.relationType) ?? "",
    })),
  });
  return `plan:${new Date().toISOString().slice(0, 10)}:${key.slice(0, 40)}`;
}

/** A retry of the same capture on the same UTC day reuses the same room. */
function captureCorrelationKey(input: RecordStructureIntakeInput): string {
  const h = createHash("sha256");
  h.update(input.userId);
  h.update(`\0${input.source.text ?? ""}\0${input.source.url ?? ""}\0`);
  if (input.source.file) h.update(input.source.file.content);
  return `capture:${new Date().toISOString().slice(0, 10)}:${h
    .digest("hex")
    .slice(0, 40)}`;
}

function captureGoal(input: RecordStructureIntakeInput): string {
  const label =
    input.source.text?.trim().split("\n")[0] ||
    input.source.url ||
    input.source.file?.filename ||
    "capture";
  return `Capture · ${label.slice(0, 80)}`;
}

/** What {@link stageCaptureSources} stages — the staging half of a capture door. */
export interface StageCaptureSourcesInput {
  database: typeof DbType;
  userId: string;
  workspaceId: string | null;
  sessionId: string | null;
  /** Where the raw came in (`intakeSource.door`): "capture", "message.interpret", … */
  door: string;
  source: RecordStructureIntakeInput["source"];
  extractedText?: string;
  extractedTextTruncated?: boolean;
  degraded?: { reason: string };
  fileNotRead?: { reason: string };
  keepRaw?: boolean;
  extraction?: RecordStructureIntakeInput["extraction"];
  /** The plan structured from these inputs — stamped on each source (`planKeys`). */
  planKey?: string;
  /** Stamped on each source: the `messages.id` the raw came from. */
  sourceMessageId?: string;
  /** Stamped on each source: the outside system's id (a booking uid). */
  externalRef?: string;
  /**
   * A replay of an ALREADY-stored raw (rerun, structure again — one input per
   * replay): every input stages onto this row instead of a new one. A foreign
   * or missing id is named in `errors`; the capture itself carries on.
   */
  reuseSourceDocumentId?: string;
}

export interface StagedCaptureSources {
  sourceDocumentIds: string[];
  /** Inputs a staging was attempted for (a failure is counted here, not in ids). */
  attempted: number;
  fileExtraction?: RunSourceExtraction;
  originalRetainedUntilStructured?: true;
  /** The file's stored ORIGINAL bytes, when they were kept. */
  fileBlob?: StagedSourceBlob;
  /** One entry per input that could NOT be stored. Never only logged. */
  errors: string[];
}

/**
 * Stage every raw input of ONE capture through the one raw door
 * (`stageIntakeSource`): text, url, file. Never throws — each failed input is
 * named in `errors`, so a door decides whether a lost raw defers its work
 * (webhooks) or rides the response (interactive doors).
 */
export async function stageCaptureSources(
  input: StageCaptureSourcesInput
): Promise<StagedCaptureSources> {
  const errors: string[] = [];
  const sourceDocumentIds: string[] = [];
  let fileExtraction: RunSourceExtraction | undefined;
  let originalRetainedUntilStructured: true | undefined;
  let fileBlob: StagedSourceBlob | undefined;
  let attempted = 0;
  const stage = async (
    label: string,
    args: Omit<
      Parameters<typeof stageIntakeSource>[0],
      "database" | "userId" | "workspaceId" | "sessionId" | "door" | "degraded"
    >,
    degraded: { reason: string } | undefined = input.degraded
  ) => {
    attempted++;
    try {
      const staged = await stageIntakeSource({
        database: input.database,
        userId: input.userId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        door: input.door,
        ...(degraded ? { degraded } : {}),
        ...(input.planKey ? { planKey: input.planKey } : {}),
        ...(input.sourceMessageId
          ? { sourceMessageId: input.sourceMessageId }
          : {}),
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        ...(input.reuseSourceDocumentId
          ? { reuseDocumentId: input.reuseSourceDocumentId }
          : {}),
        ...args,
      });
      sourceDocumentIds.push(staged.documentId);
      if (staged.blob) fileBlob = staged.blob;
    } catch (err) {
      logger.error(
        { err, userId: input.userId, sessionId: input.sessionId, label },
        "intake source NOT stored"
      );
      errors.push(
        `source ${label}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const { text, url, html, file } = input.source;
  if (text?.trim()) await stage("text", { kind: "text", text });
  if (url) await stage("url", { kind: "url", url, text: html?.trim() || url });
  if (file) {
    const buffer = Buffer.from(
      file.content,
      file.encoding === "utf8" ? "utf8" : "base64"
    );
    // A file that was NOT read (degraded / nothing extracted) keeps its bytes —
    // even under `keepRaw: false`, or it could never be structured and the raw
    // would be lost (founder rule). A read file keeps its bytes when the caller
    // chose to (photos by default) — else only its text.
    const fileDegraded = input.degraded ?? input.fileNotRead;
    const notRead = Boolean(fileDegraded) || !input.extractedText?.trim();
    const keepBytes =
      notRead || (input.keepRaw ?? defaultKeepOriginal(file.mimeType));
    const retainedUntilStructured = notRead && input.keepRaw === false;
    const before = sourceDocumentIds.length;
    await stage(
      "file",
      {
        kind: "file",
        ...(keepBytes ? {} : { text: input.extractedText }),
        file: {
          buffer,
          mimeType: file.mimeType,
          ...(file.filename ? { filename: file.filename } : {}),
          ...(input.extractedText
            ? { extractedText: input.extractedText }
            : {}),
          ...(input.extractedTextTruncated
            ? { extractedTextTruncated: true }
            : {}),
          keepBytes,
          ...(input.source.sourceSha256
            ? { sourceSha256: input.source.sourceSha256 }
            : {}),
          ...(retainedUntilStructured ? { retainedUntilStructured: true } : {}),
        },
      },
      fileDegraded
    );
    if (sourceDocumentIds.length > before) {
      if (retainedUntilStructured) originalRetainedUntilStructured = true;
      fileExtraction = {
        sourceDocumentId: sourceDocumentIds[sourceDocumentIds.length - 1]!,
        extractor: input.extraction?.extractor ?? null,
        // A degraded outcome: nothing's answer was used, whatever was sent.
        model: fileDegraded ? null : (input.extraction?.model ?? null),
        provider: fileDegraded ? null : (input.extraction?.provider ?? null),
        originalKept: keepBytes,
      };
    }
  }
  return {
    sourceDocumentIds,
    attempted,
    ...(fileExtraction ? { fileExtraction } : {}),
    ...(originalRetainedUntilStructured
      ? { originalRetainedUntilStructured }
      : {}),
    ...(fileBlob ? { fileBlob } : {}),
    errors,
  };
}

export async function recordStructureIntake(
  input: RecordStructureIntakeInput
): Promise<IntakeEcho> {
  const errors: string[] = [];
  const session =
    input.ensuredSession ??
    (await ensureIntakeSession({
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentUserId: input.agentUserId ?? null,
      verifiedHandle: input.verifiedHandle ?? null,
      bodyHandle: input.bodyHandle ?? null,
      door: "capture",
      goal: input.goal ?? captureGoal(input),
      correlationKey:
        input.correlationKey === undefined
          ? captureCorrelationKey(input)
          : input.correlationKey,
    }));
  if (session.status === "failed") errors.push(`session: ${session.error}`);
  const sessionId = session.sessionId;
  if (sessionId && input.planKey) {
    try {
      await rememberIntakePlanKey({
        sessionId,
        userId: input.userId,
        planKey: input.planKey,
      });
    } catch (err) {
      errors.push(
        `planKey: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const staged = await stageCaptureSources({
    database: input.database,
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId,
    door: "capture",
    source: input.source,
    ...(input.extractedText !== undefined
      ? { extractedText: input.extractedText }
      : {}),
    ...(input.extractedTextTruncated ? { extractedTextTruncated: true } : {}),
    ...(input.degraded ? { degraded: input.degraded } : {}),
    ...(input.fileNotRead ? { fileNotRead: input.fileNotRead } : {}),
    ...(input.keepRaw !== undefined ? { keepRaw: input.keepRaw } : {}),
    ...(input.extraction ? { extraction: input.extraction } : {}),
    ...(input.planKey ? { planKey: input.planKey } : {}),
    ...(input.reuseSourceDocumentId
      ? { reuseSourceDocumentId: input.reuseSourceDocumentId }
      : {}),
  });
  errors.push(...staged.errors);
  const { sourceDocumentIds, fileExtraction, attempted } = staged;

  if (sessionId) {
    try {
      const recorded = await recordSessionRunManifest({
        database: input.database,
        sessionId,
        userId: input.userId,
        patch: {
          sourceDocumentIds,
          ...(fileExtraction ? { extractions: [fileExtraction] } : {}),
          guidelines: input.guidelines,
          ...(input.guidelineStatus
            ? { guidelineStatus: input.guidelineStatus }
            : {}),
          ...input.runFacts,
        },
      });
      if (!recorded.ok) errors.push(`manifest: ${recorded.reason}`);
    } catch (err) {
      logger.error(
        { err, userId: input.userId, sessionId },
        "intake run manifest NOT recorded"
      );
      errors.push(
        `manifest: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const status: IntakeEcho["intake"]["status"] =
    errors.length === 0
      ? "recorded"
      : sessionId || sourceDocumentIds.length > 0
        ? "partial"
        : "failed";
  const allKept = attempted > 0 && sourceDocumentIds.length === attempted;
  return {
    sessionId,
    intake: {
      status,
      sessionSource: session.status,
      requestedSessionIgnored: session.requestedSessionIgnored,
      sourceDocumentIds,
      ...(input.degraded ? { degradedSourceKept: allKept } : {}),
      ...(attempted > 0 ? { sourcesKept: allKept } : {}),
      ...(staged.originalRetainedUntilStructured
        ? { originalRetainedUntilStructured: true as const }
        : {}),
      ...(errors.length ? { errors } : {}),
    },
  };
}
