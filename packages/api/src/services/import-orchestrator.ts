import { randomUUID, createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import { db, messages, MessageRole, MessageAuthorType } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { detectJsonChatShape } from "../import/import-parsers.js";
import {
  adaptItems,
  parseCsvTable,
  csvRowsToTypedImportItems,
  type ImportSource as ImportAdapterSource,
  type CsvTablePlan,
} from "../import/import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
  type ImportItem,
} from "../import/import-items.js";
import { aiEnrichImportItems } from "../import/import-ai.js";
import {
  deepStructureImportItems,
  makeGraphResolver,
} from "../import/import-deep.js";
import { SharedGraphResolver } from "../import/shared-graph-resolver.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { searchService } from "@synap/search";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  buildAvailableProfiles,
  type AccessibleProfileLike,
} from "../routers/capture.js";
import {
  getDb,
  ProfileResolutionService,
  eq,
  workspaces,
  workspaceMembers,
} from "@synap/database";
import { sanitizeImportPath, mimeFromPath } from "../utils/import-path.js";
import { channelsRouter } from "../routers/channels.js";
import { createEventBackedProposal } from "../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../utils/materialize-composite.js";
import { makeExternalLinkIdempotency } from "../utils/entity-link-idempotency.js";
import { entitiesRouter as regularEntitiesRouter } from "../routers/entities.js";
import { relationsRouter } from "../routers/relations.js";
import { getBoss } from "@synap/jobs";
import {
  LINKEDIN_BULK_IMPORT_QUEUE,
  type LinkedInContactPayload,
} from "@synap/jobs/workers/linkedin-bulk-import.js";
import type {
  ImportModelingSuggestion,
  ImportRunResult,
  ImportSource,
} from "@synap-core/types/imports";
import { emitImportFileProgress } from "../utils/event-emit.js";

const logger = createLogger({ module: "import-orchestrator" });

/**
 * Build a human-readable proposal summary from composite import operations by
 * extracting entity titles — the same pattern as `buildCaptureSummary` in
 * capture.ts. Centralised, extendable: any new importer feeds the same helper.
 */
export function buildImportSummary(
  operations: ReadonlyArray<{ op?: unknown; title?: unknown }>,
  source?: string
): string {
  const titles: string[] = [];
  for (const op of operations) {
    if (op.op === "create_entity" && typeof op.title === "string") {
      titles.push(op.title);
    }
  }
  const prefix = source ? `${source} import` : "Import";
  if (titles.length === 0) return prefix;
  if (titles.length === 1) return `${prefix}: ${titles[0]}`;
  if (titles.length === 2) return `${prefix}: ${titles[0]}, ${titles[1]}`;
  return `${prefix}: ${titles[0]}, ${titles[1]}, +${titles.length - 2} more`;
}

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_BATCH_FILES = 50;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MIME_TRANSFORM = [
  "application/json",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/plain",
] as const;
const EXT_TRANSFORM: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
};

type OrchestratorContext = {
  workspaceId: string | null;
  userId: string;
  trpcCtx: Record<string, unknown>;
  /**
   * Active focus session this import belongs to. When set, every `import.graph`
   * proposal is stamped with it (via createEventBackedProposal), so the
   * session→produced-entity links + `proposals.list({sessionId})` light up. Null
   * → a session-agnostic import (unchanged behavior).
   */
  sessionId?: string | null;
  /**
   * Playbook to instantiate the import session from. When present,
   * `resolveImportSession` calls `instantiateSession({playbookId,...})` instead
   * of a bare session create. Threaded from `ImportAnalyzeInput.playbookId`.
   */
  playbookId?: string | null;
};

export type SubmitBatchItem = {
  path: string;
  contentBase64: string;
  mimeType?: string;
};

export type ImportRevealSource =
  | "obsidian"
  | "markdown"
  | "csv"
  | "bookmark"
  | "json"
  | "connector_sync";

export type ImportAnalyzeInput = {
  source: ImportRevealSource;
  items: Array<{ path: string; content: string }>;
  relationType?: string;
  aiStructure?: boolean;
  /**
   * Pre-existing session to attach this import's proposals to. When omitted on a
   * workspace-scoped analyze, `analyze()` creates a fresh `Import …` session and
   * returns its id so the client can thread it into applyImport.
   */
  sessionId?: string | null;
  /**
   * Playbook to template the import session from. When present, `analyze()`
   * instantiates a session FROM the playbook (goal, expectedOutputs, playbookId
   * FK, instantiated_from link) instead of a bare Import session. The playbook's
   * `expectedOutputs[0].kind` overrides the inferred CSV profileSlug so the
   * playbook is the single source of truth for entity typing.
   */
  playbookId?: string | null;
  /** Params to resolve the playbook's goalTemplate against (e.g. {source:"CSV"}). */
  playbookParams?: Record<string, string>;
};

export type ImportApplyInput = {
  source: ImportRevealSource;
  operations: CompositeProposalOperation[];
  /**
   * Client-stable idempotency namespace (U1). When set, materialization is keyed
   * per-op so a retry of this apply links the entities it already created instead
   * of duplicating them. Absent → unchanged (no idempotency).
   */
  idempotencyKey?: string;
};

/** Tuning for the chunked large-import variants. */
export type LargeImportOpts = {
  /** Items per analyze chunk (default 750). */
  analyzeChunkSize?: number;
  /** Operations per apply chunk (default 4000, under the 8000 schema max). */
  applyChunkSize?: number;
};

const ANALYZE_CHUNK_SIZE = 750;
const APPLY_CHUNK_SIZE = 4000;

/**
 * The `data` payload for an `import.graph` proposal. Centralised so the three
 * proposal-creation sites (submitBatch / analyze / analyzeLarge) cannot drift —
 * a new provenance field is added ONCE, here. These keys are read by
 * `buildRequestFromProposal` → the proposal review UI:
 *   source     — where it came from
 *   sourceId   — stable id of this import unit (batchId, else the proposal target)
 *   contentRef — object-storage location of the raw uploaded blob, when one exists
 *   reasoning  — human-readable justification, when a producer has one
 */
function buildImportGraphProposalData(input: {
  operations: CompositeProposalOperation[];
  source: string;
  sourceId: string;
  contentRef?: { storageKey: string; mimeType?: string; size?: number };
  reasoning?: string;
}): Record<string, unknown> {
  return {
    operations: input.operations,
    source: input.source,
    sourceId: input.sourceId,
    ...(input.contentRef ? { contentRef: input.contentRef } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
  };
}

export class ImportOrchestrator {
  constructor(private readonly ctx: OrchestratorContext) {}

  async submitBatch(items: SubmitBatchItem[]) {
    if (items.length < 1 || items.length > MAX_BATCH_FILES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `items must contain 1-${MAX_BATCH_FILES} files`,
      });
    }

    const { workspaceId, userId, trpcCtx } = this.ctx;
    const batchId = randomUUID();
    const stats = {
      filesReceived: 0,
      // Retained for caller compatibility. Import no longer DIRECT-WRITES
      // entities — every parsed entity becomes a PENDING proposal instead, so
      // this stays 0 and `proposalsCreated` reflects what was enqueued for review.
      entitiesCreated: 0,
      proposalsCreated: 0,
      documentsCreated: 0,
      channelsCreated: 0,
      messagesCreated: 0,
      filesStoredOnly: 0,
      errors: [] as Array<{ path: string; message: string }>,
    };

    const decoded: Array<{ path: string; content: string; mimeType: string }> =
      [];
    let totalBytes = 0;
    for (const item of items) {
      try {
        const buf = Buffer.from(item.contentBase64, "base64");
        if (buf.length > MAX_FILE_SIZE_BYTES) {
          stats.errors.push({
            path: item.path,
            message: `File exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`,
          });
          continue;
        }
        totalBytes += buf.length;
        const path = sanitizeImportPath(item.path);
        const mimeType =
          item.mimeType || mimeFromPath(path) || "application/octet-stream";
        decoded.push({ path, content: buf.toString("utf-8"), mimeType });
      } catch (e) {
        stats.errors.push({
          path: item.path,
          message: e instanceof Error ? e.message : "Failed to decode file",
        });
      }
    }

    if (totalBytes > MAX_BATCH_BYTES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Batch total size exceeds ${MAX_BATCH_BYTES / 1024 / 1024}MB limit`,
      });
    }

    const callerCtx = { ...trpcCtx, workspaceId, userId };
    const chatCaller = channelsRouter.createCaller(callerCtx as never);

    let _fileIndex = 0;
    const _totalFiles = decoded.length;
    for (const { path, content, mimeType } of decoded) {
      const _idx = _fileIndex++;
      stats.filesReceived++;
      void emitImportFileProgress(
        {
          batchId,
          path,
          index: _idx,
          total: _totalFiles,
          status: "processing",
        },
        userId
      ).catch(() => {});
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const canTransform =
        (MIME_TRANSFORM as readonly string[]).includes(mimeType) ||
        EXT_TRANSFORM[ext];

      let _fileFailed = false;
      try {
        const storageKey = `imports/${userId}/${batchId}/${path}`;
        await storage.upload(storageKey, Buffer.from(content, "utf-8"), {
          contentType: mimeType,
          metadata: { batchId, workspaceId: workspaceId ?? "" },
        });

        if (!canTransform) {
          stats.filesStoredOnly++;
          continue;
        }

        if (mimeType === "application/json" || ext === "json") {
          try {
            const obj = JSON.parse(content) as unknown;
            const chatShape = detectJsonChatShape(obj);
            if (chatShape && chatShape.messages.length > 0) {
              const title =
                path.replace(/\.[^.]+$/, "").slice(0, 200) || "Imported chat";
              const externalId = `import-${batchId}-${path.replace(/[^a-z0-9]/gi, "-")}`;
              const { channelId, status } =
                await chatCaller.createExternalChannel({
                  externalSource: "import",
                  externalChannelId: externalId,
                  title,
                  metadata: { batchId, path },
                });
              if (status === "created") {
                stats.channelsCreated++;
                let previousHash: string | null = null;
                for (const msg of chatShape.messages) {
                  const role =
                    msg.role === "assistant"
                      ? MessageRole.ASSISTANT
                      : msg.role === "system"
                        ? MessageRole.SYSTEM
                        : MessageRole.USER;
                  const authorType =
                    role === MessageRole.ASSISTANT
                      ? MessageAuthorType.AI_AGENT
                      : MessageAuthorType.HUMAN;
                  const ts = new Date();
                  const hash = createHash("sha256")
                    .update(
                      JSON.stringify({
                        channelId,
                        content: msg.content,
                        role,
                        timestamp: ts.toISOString(),
                      })
                    )
                    .digest("hex");
                  await db.insert(messages).values({
                    id: randomUUID(),
                    channelId,
                    role,
                    authorType,
                    content: msg.content,
                    userId,
                    previousHash,
                    hash,
                    timestamp: ts,
                  });
                  previousHash = hash;
                  stats.messagesCreated++;
                }
              }
            } else {
              stats.filesStoredOnly++;
            }
          } catch {
            stats.filesStoredOnly++;
          }
          continue;
        }

        // Markdown / CSV / bookmark files route through the canonical import
        // ENGINE: each file becomes ONE governed `import.graph` composite
        // proposal (N entities + M relations, AI-structured + workspace-scoped
        // on approve) instead of N per-row pending proposals. JSON-chat and
        // LinkedIn are handled separately (they are channels/messages + a queue,
        // not entity imports).
        const engineSource: ImportAdapterSource | null =
          mimeType === "text/markdown" || ext === "md" || ext === "markdown"
            ? "markdown"
            : mimeType === "text/csv" || ext === "csv"
              ? "csv"
              : mimeType === "text/html" || ext === "html" || ext === "htm"
                ? "bookmark"
                : null;

        if (engineSource) {
          try {
            const { proposalId } = await this.proposeImportGraph(
              engineSource,
              [{ path, content }],
              { sourceId: batchId, contentRef: { storageKey, mimeType } }
            );
            if (proposalId) {
              // ONE composite graph proposal per file (was N per-row proposals).
              // entitiesCreated stays 0 — nothing materializes until approval.
              stats.proposalsCreated++;
            } else {
              stats.filesStoredOnly++;
            }
          } catch (e) {
            stats.errors.push({
              path,
              message:
                e instanceof Error ? e.message : "Proposal create failed",
            });
          }
          continue;
        }

        stats.filesStoredOnly++;
      } catch (e) {
        _fileFailed = true;
        const message = e instanceof Error ? e.message : "Import failed";
        stats.errors.push({ path, message });
        void emitImportFileProgress(
          {
            batchId,
            path,
            index: _idx,
            total: _totalFiles,
            status: "error",
            error: message,
          },
          userId
        ).catch(() => {});
      } finally {
        if (!_fileFailed) {
          void emitImportFileProgress(
            { batchId, path, index: _idx, total: _totalFiles, status: "done" },
            userId
          ).catch(() => {});
        }
      }
    }

    logger.info(
      { batchId, workspaceId, userId, ...stats },
      "Import batch completed"
    );
    return { batchId, ...stats };
  }

  /**
   * Resolve the target workspace's REAL profiles → typed hints for the
   * structuring model + the allow-list of slugs assignable as a type. Same
   * resolution rest/capture.ts uses for /import/analyze + /import/apply.
   * Cached per-batch so we resolve once across all file branches.
   */
  private profileHints?: {
    availableProfiles: ReturnType<typeof buildAvailableProfiles>;
    validSlugs: Set<string>;
    availableWorkspaces: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  };
  private async resolveProfileHints() {
    if (this.profileHints) return this.profileHints;
    const { workspaceId, userId } = this.ctx;
    const db2 = await getDb();
    const accessible = await new ProfileResolutionService(
      db2
    ).getAccessibleProfiles(userId, workspaceId);
    const availableProfiles = buildAvailableProfiles(
      accessible as unknown as AccessibleProfileLike[]
    );
    // The user's workspaces — lets the structuring model suggest where notes belong.
    const wsRows = await db2
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, workspaces.id)
      )
      .where(eq(workspaceMembers.userId, userId))
      .limit(8);
    this.profileHints = {
      availableProfiles,
      validSlugs: new Set(availableProfiles.map((p) => p.slug)),
      availableWorkspaces: wsRows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? undefined,
      })),
    };
    return this.profileHints;
  }

  /**
   * Derive a TABLE-aware plan for a CSV import: ONE profile for the whole table
   * + a column→property routing plan, via the IS `analyze-bulk-mapping`
   * capability (the SAME endpoint capture.analyzeBulkMapping drives). The
   * inferred profile is gated against the workspace's real `validSlugs` so a
   * recognized profile (e.g. `person`) sticks and an unknown one falls back to
   * `note`. Returns null when the IS is unreachable / returns no plan — the
   * caller then keeps the existing shallow CSV behavior.
   *
   * Best-effort + non-destructive: a CSV import never fails because the planner
   * is down; it degrades to the prior shallow path.
   */
  private async buildCsvTablePlan(
    rawCsv: string,
    validSlugs: Set<string>,
    availableProfiles: ReturnType<typeof buildAvailableProfiles>
  ): Promise<CsvTablePlan | null> {
    const { headers, sampleRows } = parseCsvTable(rawCsv);
    if (headers.length === 0 || sampleRows.length === 0) return null;

    const { workspaceId, userId } = this.ctx;
    const wsId = workspaceId ?? undefined;
    try {
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: wsId,
        capability: "default",
      });
      const plan = await client.analyzeBulkMapping({
        headers,
        sampleRows,
        intent:
          "Import this CSV table as typed entities (one row = one entity).",
        availableProfiles,
      });
      if (!plan) return null;

      // Gate the inferred profile against the workspace's real slugs — an
      // unknown slug would fail profile validation on create and dump the row
      // back to a bare note, dropping its properties. Fall back to `note`.
      const inferred = (plan.rowEntityType ?? "").trim().toLowerCase();
      const profileSlug = validSlugs.has(inferred) ? inferred : "note";

      return {
        profileSlug,
        titleColumn: plan.titleColumn ?? null,
        columns: plan.columnMappings.map((c) => ({
          header: c.header,
          slug: c.slug,
          valueType: c.valueType,
          scope: c.scope,
        })),
      };
    } catch (e) {
      logger.warn(
        { e, userId, workspaceId },
        "import buildCsvTablePlan failed — falling back to shallow CSV"
      );
      return null;
    }
  }

  /**
   * Route a parsed source through the canonical import ENGINE: adapt raw records
   * → ImportItems → (best-effort AI structuring) → buildImportProposal →
   * importProposalToComposite → ONE governed `import.graph` composite proposal.
   *
   * This replaces the old per-row entity-proposal loop: a whole file (or batch
   * of files) for a source becomes a SINGLE reviewable graph proposal that, on
   * approval, materializes N entities + M relations atomically and (because the
   * proposal is workspace-bound) workspace-scoped via proposals.approve.
   *
   * AI enrichment is on by default and best-effort: any IS failure falls back to
   * the deterministic proposal (items unchanged). Returns the created proposal id
   * or null when the source produced no items.
   */
  private async proposeImportGraph(
    source: ImportAdapterSource,
    raw: Array<{ path: string; content: string }>,
    provenance?: {
      /** Stable id for this import unit (batchId) — used as `data.sourceId`. */
      sourceId?: string;
      /** Object-storage location of the raw uploaded blob, if any. */
      contentRef?: { storageKey: string; mimeType?: string; size?: number };
    }
  ): Promise<{ proposalId: string | null; itemCount: number }> {
    const { workspaceId, userId } = this.ctx;
    // IS routing + the live-search resolver take an optional workspaceId; a
    // pod-wide import (null) resolves the user-default service and an
    // unscoped search.
    const wsId = workspaceId ?? undefined;

    const { availableProfiles, validSlugs, availableWorkspaces } =
      await this.resolveProfileHints();

    // CSV is a TABLE: infer ONE profile + column→property mapping for the whole
    // file and build TYPED items, instead of the shallow row→untyped-note path.
    // Best-effort — if the planner is unavailable, `items` stays empty here and
    // we fall through to the shallow adapter below.
    let items: ImportItem[] = [];
    if (source === "csv" && raw.length > 0) {
      // Infer the plan from the first file (submitBatch sends one CSV per call);
      // apply it to every file's rows.
      const plan = await this.buildCsvTablePlan(
        raw[0].content,
        validSlugs,
        availableProfiles
      );
      if (plan) {
        for (const r of raw) {
          const { rows } = parseCsvTable(r.content);
          items.push(...csvRowsToTypedImportItems(rows, plan));
        }
      }
    }
    if (items.length === 0) items = adaptItems(source, raw);
    if (items.length === 0) return { proposalId: null, itemCount: 0 };

    // Prose (markdown/obsidian) → DEEP extraction: decompose each note into
    // multiple typed entities + relations, merged + deduplicated across notes.
    // Structured rows (csv/bookmark) stay on the SHALLOW path (1 row = 1 entity,
    // which is correct for them). Deep is best-effort: if it yields nothing
    // (IS down, all timeouts), we fall back to shallow so an import never fails.
    // Prose sources go through DEEP extraction (note/transcript → entity graph).
    // JSON-chat imports are flattened to a transcript by the json adapter, so
    // they belong here too — the conversation content yields entities+relations.
    const isProse =
      source === "obsidian" || source === "markdown" || source === "json";
    let operations: CompositeProposalOperation[] | undefined;
    let summary: string | undefined;
    let itemCount = items.length;

    if (isProse) {
      try {
        const { client } = await resolveIntelligenceService({
          userId,
          workspaceId: wsId,
          capability: "default",
        });
        const deep = await deepStructureImportItems(
          items,
          client,
          {
            availableProfiles,
            validSlugs,
            availableWorkspaces,
            resolveExisting: makeGraphResolver(searchService, {
              userId,
              workspaceId: wsId,
            }),
          },
          { logger }
        );
        if (deep.stats.entityCount > 0) {
          operations = deep.operations;
          itemCount = deep.stats.itemsProcessed;
          summary = buildImportSummary(deep.operations, source);
          logger.info(
            { ...deep.stats, userId, source },
            "deep import structured"
          );
        } else {
          logger.warn(
            { userId, source },
            "deep import produced no entities — falling back to shallow"
          );
        }
      } catch (e) {
        logger.warn(
          { e, userId, source },
          "deep import failed — falling back to shallow"
        );
      }
    }

    if (!operations) {
      // Shallow path: best-effort AI typing (1 item → 1 typed entity). Any IS
      // failure leaves items unchanged and the deterministic proposal stands.
      try {
        const { client } = await resolveIntelligenceService({
          userId,
          workspaceId: wsId,
          capability: "default",
        });
        await aiEnrichImportItems(
          items,
          client,
          { availableProfiles },
          { logger }
        );
      } catch (e) {
        logger.warn(
          { e, userId, source },
          "import submitBatch AI enrich failed, using deterministic"
        );
      }
      const proposal = buildImportProposal(items, "references", validSlugs);
      operations = importProposalToComposite(proposal).operations;
      itemCount = proposal.stats.itemCount;
      summary = buildImportSummary(operations, source);
    }

    const targetId = randomUUID();
    const { proposal: created } = await createEventBackedProposal({
      userId,
      workspaceId,
      targetType: "entity",
      targetId,
      proposalType: "import.graph",
      action: "create",
      source: "intelligence",
      summary,
      sessionId: this.ctx.sessionId ?? null,
      data: buildImportGraphProposalData({
        operations,
        source,
        sourceId: provenance?.sourceId ?? targetId,
        contentRef: provenance?.contentRef,
      }),
    });

    return {
      proposalId: (created as { id?: string })?.id ?? null,
      itemCount,
    };
  }

  /**
   * Preview-before-apply: structure the supplied items into a composite graph
   * (deep for prose, shallow for structured), record it as a governed
   * `import.graph` proposal, AND return the operations so the caller can render
   * the reveal inline (CompositeProposalGraph) without a round-trip. Pure read +
   * one proposal row; nothing materializes here. The caller then passes the SAME
   * `operations` to `apply()` so what the user previewed is exactly what is
   * created (no re-structuring drift).
   */
  async analyze(input: ImportAnalyzeInput) {
    const { workspaceId, userId } = this.ctx;
    // Optional workspaceId for IS routing + the live-search resolver — a pod-wide
    // analyze (null) resolves the user-default service and an unscoped search.
    const wsId = workspaceId ?? undefined;
    const { availableProfiles, validSlugs, availableWorkspaces } =
      await this.resolveProfileHints();

    // CSV is a TABLE: infer ONE profile + a column→property routing plan for the
    // whole file (so a CSV of people → `person` entities, not flat `note`s), and
    // build TYPED items. `tablePlan` is returned so the client can show + later
    // override the mapping. Best-effort: a null plan keeps the shallow path.
    let tablePlan: CsvTablePlan | null = null;
    let items: ImportItem[];
    if (
      input.source === "csv" &&
      input.aiStructure !== false &&
      input.items[0]
    ) {
      tablePlan = await this.buildCsvTablePlan(
        input.items[0].content,
        validSlugs,
        availableProfiles
      );

      // When a playbook templates this import, its `expectedOutputs[0].kind`
      // OVERRIDES the inferred CSV profileSlug — the playbook is the single
      // source of truth for entity typing.
      if (tablePlan && (input.playbookId || this.ctx.playbookId)) {
        const playbookId = (input.playbookId ?? this.ctx.playbookId) as string;
        try {
          const playbook = await this.resolvePlaybookOutputKind(playbookId);
          if (playbook && validSlugs.has(playbook.profileSlug)) {
            tablePlan = { ...tablePlan, profileSlug: playbook.profileSlug };
          }
        } catch {
          // Best-effort override — keep the inferred slug if lookup fails.
        }
      }
    }
    if (tablePlan) {
      items = [];
      for (const it of input.items) {
        const { rows } = parseCsvTable(it.content);
        items.push(...csvRowsToTypedImportItems(rows, tablePlan));
      }
    } else {
      items = adaptItems(input.source as ImportAdapterSource, input.items);
    }

    let aiTyped = 0;
    // JSON-chat (flattened to a transcript by the json adapter) joins the prose
    // deep-extraction path so the conversation becomes an entity graph.
    const isProse =
      input.source === "obsidian" ||
      input.source === "markdown" ||
      input.source === "json";
    let operations: CompositeProposalOperation[] | undefined;
    let summary = "";
    let droppedReferences = 0;
    let stats: Record<string, unknown> = {};
    let mode: "deep" | "shallow" = "shallow";

    if (isProse && input.aiStructure !== false) {
      try {
        const { client } = await resolveIntelligenceService({
          userId,
          workspaceId: wsId,
          capability: "default",
        });
        const deep = await deepStructureImportItems(
          items,
          client,
          {
            availableProfiles,
            validSlugs,
            availableWorkspaces,
            resolveExisting: makeGraphResolver(searchService, {
              userId,
              workspaceId: wsId,
            }),
          },
          { logger }
        );
        if (deep.stats.entityCount > 0) {
          operations = deep.operations;
          aiTyped = deep.stats.entityCount;
          mode = "deep";
          stats = { ...deep.stats };
          summary = buildImportSummary(deep.operations, input.source);
        }
      } catch (e) {
        logger.warn(
          { e, userId },
          "import.analyze deep failed, falling back to shallow"
        );
      }
    }

    if (mode === "shallow") {
      // CSV with a table plan is ALREADY typed per-column (the plan is the
      // typing) — skip the per-row enrich that would re-call the IS and clobber
      // the table-wide profile. Other shallow sources still get per-item enrich.
      if (input.aiStructure !== false && !tablePlan) {
        try {
          const { client } = await resolveIntelligenceService({
            userId,
            workspaceId: wsId,
            capability: "default",
          });
          const enriched = await aiEnrichImportItems(
            items,
            client,
            { availableProfiles },
            { logger }
          );
          aiTyped = enriched.aiTyped;
        } catch (e) {
          logger.warn(
            { e, userId },
            "import.analyze AI enrich failed, using deterministic"
          );
        }
      }
      const proposal = buildImportProposal(
        items,
        input.relationType,
        validSlugs
      );
      const composite = importProposalToComposite(proposal);
      operations = composite.operations;
      droppedReferences = composite.droppedReferences;
      stats = { ...proposal.stats };
      summary = buildImportSummary(composite.operations, input.source);
    }

    const ops = operations ?? [];

    // Attach to a session so this import's proposals + produced entities group
    // under one goal. Reuse the supplied session, else (workspace-scoped only —
    // focusSessions.create requires a workspaceId) create an `Import …` session.
    // Best-effort: a session hiccup must never fail the import.
    const sessionId = await this.resolveImportSession(input, tablePlan);

    const targetId = randomUUID();
    const { proposal: created } = await createEventBackedProposal({
      userId,
      workspaceId,
      targetType: "entity",
      targetId,
      proposalType: "import.graph",
      action: "create",
      source: "intelligence",
      summary,
      sessionId: sessionId ?? null,
      data: buildImportGraphProposalData({
        operations: ops,
        source: input.source,
        sourceId: targetId,
      }),
    });

    logger.info(
      {
        userId,
        workspaceId,
        source: input.source,
        mode,
        proposalId: (created as { id?: string })?.id,
        sessionId,
        droppedReferences,
        aiTyped,
        ...stats,
      },
      "import.analyze"
    );
    return {
      workspaceId,
      source: input.source,
      mode,
      proposalId: (created as { id?: string })?.id ?? null,
      sessionId: sessionId ?? null,
      tablePlan,
      operations: ops,
      summary,
      stats,
      droppedReferences,
      aiTyped,
    };
  }

  /**
   * Resolve the session this import attaches to:
   * 1. Caller-supplied sessionId (e.g. from a prior analyze call).
   * 2. When `input.playbookId` is present, instantiate a NEW session FROM the
   *    playbook — goal resolved from goalTemplate, expectedOutputs from the
   *    playbook, `playbookId` FK + `instantiated_from` link written. This makes
   *    the import a first-class playbook-templated session.
   * 3. When `input.sessionId` is set and no playbook, use it directly.
   * 4. Otherwise null — session-agnostic import (e.g. pod-wide).
   *
   * The playbook is the single source of truth for a session's goal/outputs;
   * when present, the caller MUST NOT also pass a bare sessionId.
   */
  private async resolveImportSession(
    input: ImportAnalyzeInput,
    _tablePlan: CsvTablePlan | null
  ): Promise<string | null> {
    // Existing session — pass through unchanged.
    if (input.sessionId) return input.sessionId;

    // Playbook-templated session: instantiate FROM the playbook, which sets
    // goal (resolved), expectedOutputs, playbookId FK, and the
    // instantiated_from link.
    if (input.playbookId && this.ctx.workspaceId) {
      const { instantiateSession } =
        await import("../services/playbooks/playbook-lifecycle.js");
      try {
        const session = await instantiateSession({
          playbookId: input.playbookId,
          workspaceId: this.ctx.workspaceId,
          userId: this.ctx.userId,
          params: input.playbookParams,
        });
        return session.id;
      } catch (err) {
        // Session instantiation is best-effort — an import must not fail
        // because a playbook instantiation hiccupped. Log and return null
        // (the import still completes; it just won't be session-attached).
        logger.warn(
          { err, playbookId: input.playbookId },
          "import: playbook session instantiation failed (import preserved)"
        );
        return null;
      }
    }

    return null;
  }

  /**
   * Resolve a playbook's target profileSlug from its `expectedOutputs[0].kind`,
   * so the playbook is the single source of truth for entity typing (overriding
   * the IS-inferred slug). Returns null when the playbook has no declared output
   * kind or is not found.
   */
  private async resolvePlaybookOutputKind(
    playbookId: string
  ): Promise<{ profileSlug: string } | null> {
    await import("@synap/database/schema");
    const { db: db2 } = await import("@synap/database");
    const row = await db2.query.playbooks.findFirst({
      where: (fields, { eq }) => eq(fields.id, playbookId),
      columns: { expectedOutputs: true },
    });
    if (!row) return null;
    const outputs = row.expectedOutputs as Array<{ kind?: string }> | null;
    const kind = outputs?.[0]?.kind;
    return kind ? { profileSlug: kind } : null;
  }

  /**
   * Materialize the EXACT operations the user previewed in `analyze()` — N
   * entities + linked documents + M relations, workspace-scoped (pinned to this
   * workspace, purged with it). This is a user-confirmed direct write of their
   * own data (the preview WAS the review), so it follows the same "human UI
   * action = direct write" rule as the REST /import/apply path and reuses the
   * identical composite materializer the proposal-approve loop uses.
   */
  async apply(input: ImportApplyInput) {
    const { workspaceId, userId, trpcCtx } = this.ctx;

    const callerCtx = { ...trpcCtx, workspaceId, userId };
    const entityCaller = regularEntitiesRouter.createCaller(callerCtx as never);
    const relationCaller = relationsRouter.createCaller(callerCtx as never);

    const { created, linked } = await materializeCompositeGraph(
      input.operations,
      entityCaller,
      relationCaller,
      (err, type) =>
        logger.warn({ err, type }, "import.apply: relation create failed"),
      {
        // !!workspaceId: an active workspace pins entities to it; a pod-wide
        // apply (null) lets each profile land in its natural scope (pod-default
        // NULL), mirroring capture.
        workspaceScoped: !!workspaceId,
        // U1: when the caller supplies a stable key, retries link instead of
        // duplicating. Absent → no idempotency (unchanged).
        ...(input.idempotencyKey
          ? {
              idempotency: makeExternalLinkIdempotency(db, {
                // userId-scoped so the global (provider, externalId) index can
                // never collide across tenants.
                namespace: `${this.ctx.userId}:${input.idempotencyKey}`,
                provider: "import",
                userId: this.ctx.userId,
              }),
            }
          : {}),
      }
    );

    logger.info(
      { userId, workspaceId, source: input.source, created, linked },
      "import.apply materialized"
    );
    return { workspaceId, source: input.source, created, linked };
  }

  /**
   * No-cap, quality-preserving large analyze. Mirrors `analyze()` (deep prose
   * structuring → ONE governed `import.graph` proposal) but CHUNKS the items so
   * an arbitrarily large corpus never blows the per-call ceilings — WITHOUT
   * losing the cross-note dedup that makes the import a single graph.
   *
   * The trick: `deepStructureImportItems` only dedups within its own call. Here a
   * single `SharedGraphResolver` lives ACROSS chunks, so a person named in chunk
   * 1 and chunk 5 resolves to ONE entity (chunk 5 links to chunk 1's creation
   * instead of re-creating). After each chunk we `registerCreated` every
   * create_entity op and feed the accumulated names forward as the next chunk's
   * `existingEntityNames` hint.
   *
   * Returns the same shape family as `analyze()`: one proposal id + the merged
   * operations + summary/stats. Prose-only (deep path); structured sources should
   * keep using `analyze()` where 1 row = 1 entity is already correct.
   */
  async analyzeLarge(input: ImportAnalyzeInput, opts?: LargeImportOpts) {
    const { workspaceId, userId } = this.ctx;
    // Optional workspaceId for IS routing + the live-search resolver — a pod-wide
    // analyze (null) resolves the user-default service and an unscoped search.
    const wsId = workspaceId ?? undefined;
    const chunkSize = Math.max(1, opts?.analyzeChunkSize ?? ANALYZE_CHUNK_SIZE);
    const { availableProfiles, validSlugs, availableWorkspaces } =
      await this.resolveProfileHints();
    const items = adaptItems(input.source as ImportAdapterSource, input.items);

    const { client } = await resolveIntelligenceService({
      userId,
      workspaceId: wsId,
      capability: "default",
    });

    // ONE shared resolver across all chunks — wraps the live-search resolver and
    // adds earlier-chunk-created + memoized state (cross-chunk dedup).
    const shared = new SharedGraphResolver(
      makeGraphResolver(searchService, { userId, workspaceId: wsId })
    );

    const batchId = randomUUID();
    const operations: CompositeProposalOperation[] = [];
    const byType: Record<string, number> = {};
    let entityCount = 0;
    let relationCount = 0;
    let duplicatesMerged = 0;
    let linkedToExisting = 0;
    let documentCount = 0;
    let sourceDocCount = 0;
    let itemsProcessed = 0;
    let itemsFailed = 0;
    let wikilinkLinksResolved = 0;
    let wikilinkLinksUnresolved = 0;

    const totalChunks = Math.max(1, Math.ceil(items.length / chunkSize));
    for (let c = 0; c < totalChunks; c++) {
      const chunk = items.slice(c * chunkSize, (c + 1) * chunkSize);
      if (chunk.length === 0) continue;
      void emitImportFileProgress(
        {
          batchId,
          path: `chunk ${c + 1}/${totalChunks}`,
          index: c,
          total: totalChunks,
          status: "processing",
        },
        userId
      ).catch(() => {});

      const deep = await deepStructureImportItems(
        chunk,
        client,
        {
          availableProfiles,
          validSlugs,
          availableWorkspaces,
          resolveExisting: (slug, title) => shared.resolveExisting(slug, title),
          seedExistingNames: shared.getExistingEntityNames(),
        },
        { logger }
      );

      // Re-namespace this chunk's refs so they never collide with another
      // chunk's `e0`/`src0`/… and stay stable for the cross-chunk apply.
      const prefix = `c${c}_`;
      for (const op of deep.operations) {
        if (op.op === "create_entity") {
          const newRef = op.ref ? `${prefix}${op.ref}` : undefined;
          operations.push({ ...op, ref: newRef });
          // Feed every created (non-linked) entity into the shared resolver so
          // the NEXT chunk dedups against it. Linked ops already point at a real
          // id, so registering them would shadow the live entity needlessly.
          if (!op.existingEntityId && newRef)
            shared.registerCreated(
              op.profileSlug,
              op.title || "Untitled",
              newRef
            );
        } else {
          operations.push({
            ...op,
            sourceRef: `${prefix}${op.sourceRef}`,
            targetRef: `${prefix}${op.targetRef}`,
          });
        }
      }

      entityCount += deep.stats.entityCount;
      relationCount += deep.stats.relationCount;
      duplicatesMerged += deep.stats.duplicatesMerged;
      linkedToExisting += deep.stats.linkedToExisting;
      documentCount += deep.stats.documentCount;
      sourceDocCount += deep.stats.sourceDocCount;
      itemsProcessed += deep.stats.itemsProcessed;
      itemsFailed += deep.stats.itemsFailed;
      wikilinkLinksResolved += deep.stats.wikilinkLinksResolved;
      wikilinkLinksUnresolved += deep.stats.wikilinkLinksUnresolved;
      for (const [t, n] of Object.entries(deep.stats.byType))
        byType[t] = (byType[t] ?? 0) + n;

      void emitImportFileProgress(
        {
          batchId,
          path: `chunk ${c + 1}/${totalChunks}`,
          index: c,
          total: totalChunks,
          status: "done",
        },
        userId
      ).catch(() => {});
    }

    const summary = buildImportSummary(operations, input.source);

    const stats = {
      itemsProcessed,
      itemsFailed,
      entityCount,
      relationCount,
      duplicatesMerged,
      linkedToExisting,
      documentCount,
      sourceDocCount,
      byType,
      wikilinkLinksResolved,
      wikilinkLinksUnresolved,
      chunks: totalChunks,
    };

    const { proposal: created } = await createEventBackedProposal({
      userId,
      workspaceId,
      targetType: "entity",
      targetId: batchId,
      proposalType: "import.graph",
      action: "create",
      source: "intelligence",
      summary,
      sessionId: input.sessionId ?? this.ctx.sessionId ?? null,
      data: buildImportGraphProposalData({
        operations,
        source: input.source,
        sourceId: batchId,
      }),
    });

    logger.info(
      {
        userId,
        workspaceId,
        source: input.source,
        mode: "deep",
        proposalId: (created as { id?: string })?.id,
        sessionId: input.sessionId ?? this.ctx.sessionId ?? null,
        ...stats,
      },
      "import.analyzeLarge"
    );

    return {
      workspaceId,
      source: input.source,
      mode: "deep" as const,
      proposalId: (created as { id?: string })?.id ?? null,
      sessionId: input.sessionId ?? this.ctx.sessionId ?? null,
      operations,
      summary,
      stats,
      aiTyped: entityCount,
    };
  }

  /**
   * No-cap apply. Mirrors `apply()` (materialize exact operations,
   * workspace-scoped) but CHUNKS the operations so an arbitrarily large graph
   * stays under the per-call ceiling. A cumulative `refToRealId` is carried
   * across chunks (seeded into each `materializeCompositeGraph` call) so a
   * relation whose endpoints were created in an EARLIER chunk still resolves.
   *
   * Safe because the analyze path always emits an entity op BEFORE any relation
   * that references it (no forward references), so chunking in operation order +
   * the cumulative seed never strands a relation.
   */
  async applyLarge(input: ImportApplyInput, opts?: LargeImportOpts) {
    const { workspaceId, userId, trpcCtx } = this.ctx;
    const chunkSize = Math.max(1, opts?.applyChunkSize ?? APPLY_CHUNK_SIZE);

    const callerCtx = { ...trpcCtx, workspaceId, userId };
    const entityCaller = regularEntitiesRouter.createCaller(callerCtx as never);
    const relationCaller = relationsRouter.createCaller(callerCtx as never);

    const batchId = randomUUID();
    const refToRealId: Record<string, string> = {};
    let created = 0;
    let linked = 0;

    // U1: build the idempotency hooks ONCE (stable namespace) and pass them to
    // every chunk. Chunk refs are already re-namespaced (c0_e0, c1_e0, …) so
    // per-op keys stay distinct across chunks and stable on retry. Absent key →
    // no idempotency (unchanged).
    const idempotency = input.idempotencyKey
      ? makeExternalLinkIdempotency(db, {
          // userId-scoped (see apply()) — global index, no cross-tenant collision.
          namespace: `${this.ctx.userId}:${input.idempotencyKey}`,
          provider: "import",
          userId: this.ctx.userId,
        })
      : undefined;
    // One dedup guard shared across all chunks of THIS apply, so a duplicate
    // op.ref split across two chunks can't merge two distinct entities (the
    // per-call Set would otherwise reset each chunk). Fresh per apply → retries
    // (a new applyLarge call) still link correctly via the registered keys.
    const idemSeen = idempotency ? new Set<string>() : undefined;

    const totalChunks = Math.max(
      1,
      Math.ceil(input.operations.length / chunkSize)
    );
    for (let c = 0; c < totalChunks; c++) {
      const chunk = input.operations.slice(c * chunkSize, (c + 1) * chunkSize);
      if (chunk.length === 0) continue;
      void emitImportFileProgress(
        {
          batchId,
          path: `chunk ${c + 1}/${totalChunks}`,
          index: c,
          total: totalChunks,
          status: "processing",
        },
        userId
      ).catch(() => {});

      const res = await materializeCompositeGraph(
        chunk,
        entityCaller,
        relationCaller,
        (err, type) =>
          logger.warn(
            { err, type },
            "import.applyLarge: relation create failed"
          ),
        {
          // !!workspaceId: pin to active workspace, else pod-wide (NULL) — see apply().
          workspaceScoped: !!workspaceId,
          seedRefToRealId: refToRealId,
          ...(idempotency ? { idempotency } : {}),
          ...(idemSeen ? { idemSeen } : {}),
        }
      );
      // Carry this chunk's ref→id mappings forward for cross-chunk relations.
      Object.assign(refToRealId, res.refToRealId);
      created += res.created;
      linked += res.linked;

      void emitImportFileProgress(
        {
          batchId,
          path: `chunk ${c + 1}/${totalChunks}`,
          index: c,
          total: totalChunks,
          status: "done",
        },
        userId
      ).catch(() => {});
    }

    logger.info(
      {
        userId,
        workspaceId,
        source: input.source,
        created,
        linked,
        chunks: totalChunks,
      },
      "import.applyLarge materialized"
    );
    return {
      workspaceId,
      source: input.source,
      created,
      linked,
      chunks: totalChunks,
    };
  }

  async queueLinkedInContacts(contacts: LinkedInContactPayload[]) {
    // LinkedIn contacts import is workspace-bound (the router uses
    // workspaceProcedure) — unlike the reveal path it requires an active
    // workspace, so reject a pod-wide call rather than queue a null workspace.
    if (!this.ctx.workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Workspace ID required for LinkedIn contacts import.",
      });
    }
    const jobId = await getBoss().send(LINKEDIN_BULK_IMPORT_QUEUE, {
      workspaceId: this.ctx.workspaceId,
      userId: this.ctx.userId,
      contacts,
      runId: randomUUID(),
      source: "linkedin_archive" satisfies ImportSource,
    });
    return { jobId, total: contacts.length, status: "queued" as const };
  }

  previewModeling(
    sampleRows: Array<Record<string, unknown>>,
    source: ImportSource
  ) {
    const keys = new Set<string>();
    for (const row of sampleRows.slice(0, 100)) {
      for (const key of Object.keys(row)) keys.add(key);
    }
    const lower = Array.from(keys).map((k) => k.toLowerCase());
    const looksLikeContacts =
      lower.some((k) => k.includes("email")) ||
      lower.some((k) => k.includes("phone")) ||
      lower.some((k) => k.includes("company"));

    const suggestions: ImportModelingSuggestion[] = looksLikeContacts
      ? [
          {
            profileSlug: "contact",
            profileLabel: "Contact",
            confidence: 0.82,
            suggestedProperties: Array.from(keys)
              .slice(0, 20)
              .map((key) => ({
                slug: key
                  .replace(/\s+/g, "_")
                  .toLowerCase()
                  .replace(/[^a-z0-9_]/g, ""),
                label: key,
                valueType: "string",
                reason: "Detected from imported column",
              })),
            suggestedViews: [
              {
                type: "table",
                title: "Imported Contacts",
                reason: "Best for tabular review",
              },
              {
                type: "kanban",
                title: "Contacts Pipeline",
                reason: "Useful for relationship stages",
              },
            ],
          },
        ]
      : [
          {
            profileSlug: "note",
            profileLabel: "Imported Note",
            confidence: 0.61,
            suggestedProperties: Array.from(keys)
              .slice(0, 20)
              .map((key) => ({
                slug: key
                  .replace(/\s+/g, "_")
                  .toLowerCase()
                  .replace(/[^a-z0-9_]/g, ""),
                label: key,
                valueType: "string",
              })),
            suggestedViews: [
              {
                type: "table",
                title: "Imported Data",
                reason: "General-purpose review",
              },
            ],
          },
        ];

    return {
      source,
      analyzedRows: sampleRows.length,
      suggestions,
    } satisfies {
      source: ImportSource;
      analyzedRows: number;
      suggestions: ImportModelingSuggestion[];
    };
  }

  finalizeRunResult(params: {
    runId: string;
    source: ImportSource;
    startedAt: string;
    finishedAt: string;
    summary: ImportRunResult["summary"];
    status: "completed" | "failed";
    errors: Array<{ path?: string; message: string }>;
  }): ImportRunResult {
    return {
      runId: params.runId,
      source: params.source,
      status: params.status,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
      summary: params.summary,
      errors: params.errors,
    };
  }
}
