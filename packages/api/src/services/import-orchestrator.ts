import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  computeMessageHash,
  resolveGraphWorkspaceFromSlugs,
  proposals,
  ProposalStatus,
  eq,
} from "@synap/database";
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
import {
  buildCorpusMap,
  corpusMapToOperations,
  linkProvenanceToContainers,
  orderItemsByCorpusMap,
} from "../import/corpus-map.js";
import { buildImportQualityReport } from "../import/quality-report.js";
import { SharedGraphResolver } from "../import/shared-graph-resolver.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { searchService } from "@synap/search";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
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
import {
  resolveImportSession,
  resolvePlaybookOutputKind,
  stampProjectMembership,
  closeImportProposalOnApply,
} from "./import/session.js";
import {
  resolveProfileHints,
  buildCsvTablePlan,
  proposeImportGraph,
  buildImportSummary,
  buildImportGraphProposalData,
  computeImportHomes,
  majorityWorkspaceFromHomes,
  stampWorkspaceOnUnpinnedOps,
  type ProfileHints,
} from "./import/structuring.js";
import { suggestViewsFromImportGraph } from "./import/suggest-views.js";
// Re-exported to preserve the prior public named export from this module.
export { buildImportSummary, computeImportHomes };
export type { ImportHomesSummary } from "./import/structuring.js";
import type { OrchestratorContext } from "./import/types.js";
export type { OrchestratorContext };

const logger = createLogger({ module: "import-orchestrator" });

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

export type SubmitBatchItem = {
  path: string;
  contentBase64: string;
  mimeType?: string;
};

export type ImportRevealSource =
  "obsidian" | "markdown" | "csv" | "bookmark" | "json" | "connector_sync";

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
  /** Active project lens → threaded onto the orchestrator ctx + import proposals. */
  projectId?: string | null;
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
  /**
   * Force minting an Import focus session even when N&lt;2.
   * Default mint still runs for N≥2 (see resolveImportSession).
   */
  forceSession?: boolean;
  /**
   * Structure + quality only — do NOT persist an `import.graph` proposal.
   * Used by CLI `--dry-run` and any preview that must not spam the inbox.
   * Returns `proposalId: null`; ops/quality/homes are still fully populated.
   */
  previewOnly?: boolean;
};

export type ImportApplyInput = {
  source: ImportRevealSource;
  /**
   * Operations to materialize. Optional when `proposalId` is set — the stored
   * proposal is SSOT for ops (HITL: preview === commit). Client ops are only
   * used when the proposal has no stored ops (back-compat) or when proposalId
   * is omitted.
   */
  operations?: CompositeProposalOperation[];
  /**
   * Client-stable idempotency namespace (U1). When set, materialization is keyed
   * per-op so a retry of this apply links the entities it already created instead
   * of duplicating them. When omitted, server defaults to `proposalId` or a
   * stable hash of operation refs so retries never double-create by accident.
   */
  idempotencyKey?: string;
  /** Analyze proposal id — SSOT for ops when present; default idempotencyKey. */
  proposalId?: string | null;
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
 * Always resolve a stable idempotency namespace for import materialize.
 * Preference: explicit key → analyze proposalId → hash of op refs.
 */
export function resolveImportIdempotencyKey(
  input: Pick<ImportApplyInput, "idempotencyKey" | "proposalId" | "operations">
): string {
  if (input.idempotencyKey && input.idempotencyKey.length > 0) {
    return input.idempotencyKey.slice(0, 200);
  }
  if (input.proposalId && input.proposalId.length > 0) {
    return input.proposalId.slice(0, 200);
  }
  // Content-aware fallback: op + ref + profileSlug + title so two different
  // graphs with the same ref skeleton never share a namespace.
  const ops = input.operations ?? [];
  const parts: string[] = [];
  for (const op of ops) {
    const rec = op as {
      op?: string;
      ref?: string;
      profileSlug?: string;
      title?: string;
      properties?: { title?: string };
    };
    const title =
      typeof rec.title === "string"
        ? rec.title
        : typeof rec.properties?.title === "string"
          ? rec.properties.title
          : "";
    parts.push(
      `${rec.op ?? "?"}:${rec.ref ?? ""}:${rec.profileSlug ?? ""}:${title}`
    );
  }
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `ops:${(h >>> 0).toString(16)}:${ops.length}`;
}

/**
 * Resolve materialize ops for apply / applyLarge.
 *
 * HITL SSOT: when `proposalId` is set, load the analyze-time proposal and use
 * `proposal.data.operations` (buildImportGraphProposalData shape) so what was
 * previewed is what commits — client cannot substitute a different graph.
 * Client ops are only accepted when stored ops are missing (back-compat) or
 * when `proposalId` is omitted.
 */
export async function resolveApplyOperations(
  input: Pick<ImportApplyInput, "proposalId" | "operations">
): Promise<CompositeProposalOperation[]> {
  const clientOps = input.operations ?? [];

  if (!input.proposalId) {
    if (clientOps.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "operations required when proposalId is omitted",
      });
    }
    return clientOps;
  }

  const [row] = await db
    .select({ data: proposals.data, status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId))
    .limit(1);

  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Import proposal ${input.proposalId} not found`,
    });
  }

  // HITL: only a PENDING analyze proposal may be applied. Re-applying an
  // approved/rejected id used to re-run materialize (idempotent) AND re-file
  // view suggestions — flooding the inbox with To-dos / Note list clones.
  if (row.status !== ProposalStatus.PENDING) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Import proposal ${input.proposalId} is not pending (status: ${row.status})`,
    });
  }

  const data = row.data as { operations?: unknown } | null;
  const stored = Array.isArray(data?.operations)
    ? (data!.operations as CompositeProposalOperation[])
    : [];
  if (stored.length > 0) {
    // Proposal is SSOT — ignore client-supplied ops (preview = commit).
    return stored;
  }

  // Back-compat: client ops when stored ops missing on a still-pending row.
  if (clientOps.length > 0) {
    return clientOps;
  }

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Import proposal ${input.proposalId} has no operations`,
  });
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
                  const id = randomUUID();
                  // Canonical tamper-hash: computeMessageHash(id, content,
                  // previousHash) — the ONE formula (see message-hash.ts). This
                  // import path chains each message to the prior one.
                  const hash = computeMessageHash(
                    id,
                    msg.content,
                    previousHash ?? ""
                  );
                  await db.insert(messages).values({
                    id,
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
            // Resolve the workspace's profile hints once (memoized across all
            // file branches) and pass them into the structuring helper.
            const profileHints = await this.resolveProfileHints();
            const { proposalId } = await proposeImportGraph(
              this.ctx,
              profileHints,
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
  // Cached per-batch so we resolve once across all file branches. The actual
  // resolution lives in `resolveProfileHints(ctx)` (import/structuring.ts); the
  // class only owns the singular memo.
  private profileHints?: ProfileHints;
  private async resolveProfileHints(): Promise<ProfileHints> {
    if (this.profileHints) return this.profileHints;
    this.profileHints = await resolveProfileHints(this.ctx);
    return this.profileHints;
  }

  /**
   * WORKSPACE PLACEMENT (routing fix): `analyze`/`analyzeLarge` build the
   * `import.graph` pending proposal with whatever `this.ctx.workspaceId` was —
   * `null` when the caller supplied no explicit lens/focus (a hub write with no
   * lens deliberately lands pod-personal, `_shared.ts:303-309`), which stranded
   * agent-generated leads pod-wide instead of the CRM workspace. Collect every
   * `create_entity` op's profileSlug in the graph and run the shared
   * `resolveGraphWorkspaceFromSlugs` helper (ONE door + deterministic accept
   * policy). A deterministic ontology hit (rung ≤4, single candidate) re-lenses
   * the whole graph; ambiguous / no-signal ABSTAINS — staying pod-wide is the
   * honest default over an arbitrary guess. Only called when
   * `this.ctx.workspaceId` is null — an explicit lens/focus always wins.
   */
  private async resolveGraphPlacement(
    operations: CompositeProposalOperation[],
    sessionId?: string | null
  ): Promise<string | null> {
    const { userId } = this.ctx;
    const routingSlugs = Array.from(
      new Set(
        operations
          .filter(
            (
              op
            ): op is Extract<
              CompositeProposalOperation,
              { op: "create_entity" }
            > => op.op === "create_entity"
          )
          .flatMap((op) => [
            op.profileSlug,
            ...(op.facets?.map((f) => f.profileSlug) ?? []),
          ])
          .filter((s): s is string => typeof s === "string" && s.length > 0)
      )
    );
    try {
      // Shared graph policy: deterministic hit only (rung ≤4, no candidates,
      // workspaceId set); ambiguous / no-signal → null. Never invent membership[0].
      return await resolveGraphWorkspaceFromSlugs(db, {
        userId,
        routingSlugs,
        sessionId,
      });
    } catch (err) {
      logger.warn(
        { err, userId },
        "import.analyze: workspace placement resolve failed — staying pod-wide"
      );
      return null;
    }
  }

  /**
   * Preview-before-apply: structure the supplied items into a composite graph
   * (deep for prose, shallow for structured), optionally record it as a governed
   * `import.graph` proposal, AND return the operations so the caller can render
   * the reveal inline (CompositeProposalGraph) without a round-trip.
   * When `previewOnly` is true (CLI `--dry-run`), no proposal/session is
   * persisted — structure + quality only. Otherwise one proposal row; nothing
   * materializes until `apply()`. The caller then passes the SAME `operations`
   * (or proposalId SSOT) so what the user previewed is exactly what is created.
   */
  async analyze(input: ImportAnalyzeInput) {
    let { workspaceId } = this.ctx;
    const { userId } = this.ctx;
    // Optional workspaceId for IS routing + the live-search resolver — a pod-wide
    // analyze (null) resolves the user-default service and an unscoped search.
    const wsId = workspaceId ?? undefined;
    const {
      availableProfiles,
      validSlugs,
      availableWorkspaces,
      validateEntity,
    } = await this.resolveProfileHints();

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
      tablePlan = await buildCsvTablePlan(
        this.ctx,
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
          const playbook = await resolvePlaybookOutputKind(playbookId);
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

    // Phase 0 — corpus map (folder tree → container intents). Runs for any
    // multi-file prose import so hierarchy is first-class, not only path homes.
    const corpusMap = buildCorpusMap(
      items.map((it) => ({ pathSegments: it.path, title: it.title }))
    );
    const { operations: containerOps, containerRefByPath } =
      corpusMapToOperations(corpusMap, {
        targetWorkspaceId: workspaceId ?? undefined,
      });
    // Prefer structuring leaves under higher-priority containers first.
    // Rebuild mapItems AFTER reorder so srcN indices match deep structure.
    items = orderItemsByCorpusMap(
      items.map((it) => ({ ...it, pathSegments: it.path })),
      corpusMap
    );
    const mapItems = items.map((it) => ({
      pathSegments: it.path,
      title: it.title,
    }));

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
            validateEntity,
          },
          { logger }
        );
        if (deep.stats.entityCount > 0) {
          const linkOps = linkProvenanceToContainers(
            deep.operations,
            mapItems,
            corpusMap,
            containerRefByPath
          );
          // Containers first (parents before children), then content graph, then hierarchy links.
          operations = [...containerOps, ...deep.operations, ...linkOps];
          aiTyped = deep.stats.entityCount;
          mode = "deep";
          stats = {
            ...deep.stats,
            corpusMap: {
              folders: corpusMap.folders.length,
              containers: containerOps.filter((o) => o.op === "create_entity")
                .length,
              intentCounts: corpusMap.intentCounts,
            },
          };
          summary = buildImportSummary(operations, input.source);
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
      // Containers still first even on shallow path.
      operations = [...containerOps, ...composite.operations];
      droppedReferences = composite.droppedReferences;
      stats = {
        ...proposal.stats,
        corpusMap: {
          folders: corpusMap.folders.length,
          containers: containerOps.filter((o) => o.op === "create_entity")
            .length,
          intentCounts: corpusMap.intentCounts,
        },
      };
      summary = buildImportSummary(operations, input.source);
    }

    // Deep path failed entirely but we still have containers from the map.
    if ((!operations || operations.length === 0) && containerOps.length > 0) {
      operations = containerOps;
      stats = {
        ...stats,
        corpusMap: {
          folders: corpusMap.folders.length,
          containers: containerOps.filter((o) => o.op === "create_entity")
            .length,
          intentCounts: corpusMap.intentCounts,
        },
      };
      summary = buildImportSummary(operations, input.source);
    }

    const ops = operations ?? [];

    // Attach to a session so this import's proposals + produced entities group
    // under one goal. Reuse the supplied session, else (workspace-scoped only —
    // focusSessions.create requires a workspaceId) create an `Import …` session.
    // Best-effort: a session hiccup must never fail the import.
    // previewOnly dry-runs: do not mint sessions either (no durable side effects).
    const sessionId = input.previewOnly
      ? (input.sessionId ?? this.ctx.sessionId ?? null)
      : await resolveImportSession(this.ctx, input, tablePlan);
    // Thread minted/passed session onto orchestrator so a same-instance apply
    // (or apply that reuses this.ctx) stamps produced-links correctly.
    if (sessionId) this.ctx.sessionId = sessionId;

    // Homes / placement (Wave 1.5):
    // - Multi-home graphs (per-op targetWorkspaceIds already diverge, or mix of
    //   pod-wide + pins): leave per-op homes alone; file the proposal row under
    //   majority workspace when every entity is pinned, else null (preserve
    //   pod-wide ambient so apply doesn't re-home unpinned ops).
    // - Single-home / all pod-wide with no explicit lens: resolveGraphPlacement,
    //   then stamp the resolved workspace onto unpinned create_entity ops so
    //   apply's multi-home materialize path is consistent with the proposal.
    let homes = computeImportHomes(ops);
    if (workspaceId === null) {
      if (homes.multiHome) {
        workspaceId =
          homes.podWide > 0 ? null : majorityWorkspaceFromHomes(homes);
      } else {
        const placed = await this.resolveGraphPlacement(ops, sessionId);
        if (placed) {
          workspaceId = placed;
          this.ctx.workspaceId = placed;
          stampWorkspaceOnUnpinnedOps(ops, placed);
          homes = computeImportHomes(ops);
        }
      }
    }

    const corpusMapMeta =
      stats && typeof stats === "object" && "corpusMap" in stats
        ? (stats.corpusMap as {
            folders?: number;
            containers?: number;
            intentCounts?: Record<string, number>;
          })
        : {
            folders: corpusMap.folders.length,
            containers: containerOps.filter((o) => o.op === "create_entity")
              .length,
            intentCounts: corpusMap.intentCounts,
            filesLinkedToContainer: Object.keys(corpusMap.fileToContainerPath)
              .length,
          };

    const quality = buildImportQualityReport({
      operations: ops,
      homes,
      stats,
      corpusMap: {
        ...corpusMapMeta,
        filesLinkedToContainer: Object.keys(corpusMap.fileToContainerPath)
          .length,
      },
      itemCount: input.items.length,
    });

    // Dry-run / previewOnly: return the full graph + quality without filing a
    // durable proposal. Dogfood showed every --dry-run left a pending
    // import.graph clone in the inbox (WineSafe × N).
    let proposalId: string | null = null;
    if (input.previewOnly) {
      logger.info(
        {
          userId,
          workspaceId,
          source: input.source,
          mode,
          sessionId,
          previewOnly: true,
          qualityScore: quality.score,
          ...stats,
        },
        "import.analyze previewOnly (no proposal)"
      );
    } else {
      const targetId = randomUUID();
      const { proposal: created } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: "entity",
        targetId,
        proposalType: "import.graph",
        action: "create",
        source: "intelligence",
        summary: `${summary} · ${quality.summary}`,
        sessionId: sessionId ?? null,
        data: buildImportGraphProposalData({
          operations: ops,
          source: input.source,
          sourceId: targetId,
          quality,
          homes,
          corpusMap: corpusMapMeta,
        }),
      });
      proposalId = (created as { id?: string })?.id ?? null;
      logger.info(
        {
          userId,
          workspaceId,
          source: input.source,
          mode,
          proposalId,
          sessionId,
          droppedReferences,
          aiTyped,
          multiHome: homes.multiHome,
          qualityScore: quality.score,
          ...stats,
        },
        "import.analyze"
      );
    }
    return {
      workspaceId,
      source: input.source,
      mode,
      proposalId,
      sessionId: sessionId ?? null,
      tablePlan,
      operations: ops,
      summary,
      stats,
      droppedReferences,
      aiTyped,
      homes,
      quality,
    };
  }

  /**
   * Materialize the import graph the user confirmed — N entities + linked
   * documents + M relations, workspace-scoped. Ops SSOT is the analyze-time
   * proposal when `proposalId` is set (HITL: preview = commit); otherwise the
   * client-echoed operations. Same "human UI action = direct write" rule as
   * REST /import/apply; reuses the composite materializer approve uses.
   */
  async apply(input: ImportApplyInput) {
    const { workspaceId, userId, trpcCtx } = this.ctx;

    // HITL SSOT: prefer proposal.data.operations over client-supplied ops.
    const operations = await resolveApplyOperations(input);

    // Thread the import's session onto the entity-create ctx: entities.create
    // reads ctx.sessionId to (a) write the `session --produced--> entity` link
    // and (b) stamp sessionId on the entity-create side-effect so the playbook
    // automation matcher fires this session's `member_of` automations. Without
    // it, import-materialized entities have no session and playbook automations
    // never run for them.
    const callerCtx = {
      ...trpcCtx,
      workspaceId,
      userId,
      sessionId: this.ctx.sessionId ?? null,
    };
    const entityCaller = regularEntitiesRouter.createCaller(callerCtx as never);
    const relationCaller = relationsRouter.createCaller(callerCtx as never);

    const idempotencyKey = resolveImportIdempotencyKey({
      ...input,
      operations,
    });

    const {
      created,
      linked,
      entities: materialized,
    } = await materializeCompositeGraph(
      operations,
      entityCaller,
      relationCaller,
      (err, type) =>
        logger.warn({ err, type }, "import.apply: relation create failed"),
      {
        // !!workspaceId: an active workspace pins entities to it; a pod-wide
        // apply (null) lets each profile land in its natural scope (pod-default
        // NULL), mirroring capture.
        workspaceScoped: !!workspaceId,
        // U1: always key materialize so retries link instead of duplicating.
        idempotency: makeExternalLinkIdempotency(db, {
          // userId-scoped so the global (provider, externalId) index can
          // never collide across tenants.
          namespace: `${this.ctx.userId}:${idempotencyKey}`,
          provider: "import",
          userId: this.ctx.userId,
        }),
      }
    );

    // Project membership (lens-context): file imported entities into the active
    // project. Import materializes directly (the proposal is a record), so the
    // membership write lands here — the project mirror of `workspaceScoped`.
    // Skips entities materialize already filed via op.projectId.
    await stampProjectMembership(this.ctx, materialized);

    // Close the analyze-time proposal row (PENDING → APPROVED). Best-effort —
    // materialize already succeeded; a close failure must never fail the import.
    await closeImportProposalOnApply(input.proposalId, userId);

    // HITL: suggest useful views from the imported profile mix. Best-effort —
    // never fails the import; human reviews proposals in the proposal UI.
    // Skip when nothing new was created (idempotent re-apply must not spam views).
    const viewProposalIds = await suggestViewsFromImportGraph(
      this.ctx,
      operations,
      { createdCount: created }
    );

    logger.info(
      {
        userId,
        workspaceId,
        source: input.source,
        created,
        linked,
        viewProposalIds,
      },
      "import.apply materialized"
    );
    return {
      workspaceId,
      source: input.source,
      created,
      linked,
      ...(viewProposalIds.length > 0 ? { viewProposalIds } : {}),
    };
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
    let { workspaceId } = this.ctx;
    const { userId } = this.ctx;
    // Optional workspaceId for IS routing + the live-search resolver — a pod-wide
    // analyze (null) resolves the user-default service and an unscoped search.
    const wsId = workspaceId ?? undefined;
    const chunkSize = Math.max(1, opts?.analyzeChunkSize ?? ANALYZE_CHUNK_SIZE);
    const {
      availableProfiles,
      validSlugs,
      availableWorkspaces,
      validateEntity,
    } = await this.resolveProfileHints();
    let items = adaptItems(input.source as ImportAdapterSource, input.items);

    // Phase 0 corpus map — containers first (same as analyze).
    const mapItems = items.map((it) => ({
      pathSegments: it.path,
      title: it.title,
    }));
    const corpusMap = buildCorpusMap(mapItems);
    const { operations: containerOps, containerRefByPath } =
      corpusMapToOperations(corpusMap, {
        targetWorkspaceId: workspaceId ?? undefined,
      });
    items = orderItemsByCorpusMap(
      items.map((it) => ({ ...it, pathSegments: it.path })),
      corpusMap
    );

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
    // Start with containers so materialize order is parent-before-child.
    const operations: CompositeProposalOperation[] = [...containerOps];
    const byType: Record<string, number> = {};
    let entityCount = 0;
    let relationCount = 0;
    let duplicatesMerged = 0;
    let linkedToExisting = 0;
    let documentCount = 0;
    let degradedToNote = 0;
    const degradedByProfile: Record<string, number> = {};
    let sourceDocCount = 0;
    let itemsProcessed = 0;
    let itemsFailed = 0;
    let wikilinkLinksResolved = 0;
    let wikilinkLinksUnresolved = 0;
    const homesByWorkspace: Record<string, number> = {};

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
          validateEntity,
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
      degradedToNote += deep.stats.degradedToNote;
      for (const [t, n] of Object.entries(deep.stats.degradedByProfile ?? {}))
        degradedByProfile[t] = (degradedByProfile[t] ?? 0) + n;
      sourceDocCount += deep.stats.sourceDocCount;
      itemsProcessed += deep.stats.itemsProcessed;
      itemsFailed += deep.stats.itemsFailed;
      wikilinkLinksResolved += deep.stats.wikilinkLinksResolved;
      wikilinkLinksUnresolved += deep.stats.wikilinkLinksUnresolved;
      for (const [t, n] of Object.entries(deep.stats.byType))
        byType[t] = (byType[t] ?? 0) + n;
      for (const [wid, n] of Object.entries(deep.stats.homesByWorkspace ?? {}))
        homesByWorkspace[wid] = (homesByWorkspace[wid] ?? 0) + n;

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

    // Hierarchy links: container → provenance note (refs re-namespaced per chunk).
    for (let globalI = 0; globalI < items.length; globalI++) {
      const c = Math.floor(globalI / chunkSize);
      const localI = globalI % chunkSize;
      const srcRef = `c${c}_src${localI}`;
      const keyParts = [...(items[globalI].path || []), items[globalI].title];
      const key = keyParts.filter(Boolean).join("/");
      const cPath = corpusMap.fileToContainerPath[key];
      if (!cPath) continue;
      const cRef = containerRefByPath[cPath];
      if (!cRef) continue;
      const hasSrc = operations.some(
        (o) => o.op === "create_entity" && o.ref === srcRef
      );
      if (!hasSrc) continue;
      operations.push({
        op: "create_relation",
        type: "parent_of",
        sourceRef: cRef,
        targetRef: srcRef,
      });
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
      degradedToNote,
      degradedByProfile,
      sourceDocCount,
      byType,
      wikilinkLinksResolved,
      wikilinkLinksUnresolved,
      homesByWorkspace,
      chunks: totalChunks,
      corpusMap: {
        folders: corpusMap.folders.length,
        containers: containerOps.filter((o) => o.op === "create_entity").length,
        intentCounts: corpusMap.intentCounts,
      },
    };

    // Same session mint rules as analyze() (N≥2 / forceSession / playbook / pass-through).
    // previewOnly: no durable session mint.
    const sessionId = input.previewOnly
      ? (input.sessionId ?? this.ctx.sessionId ?? null)
      : await resolveImportSession(this.ctx, input, null);
    if (sessionId) this.ctx.sessionId = sessionId;

    // Homes / placement — same rules as analyze() (see comment there).
    let homes = computeImportHomes(operations);
    if (workspaceId === null) {
      if (homes.multiHome) {
        workspaceId =
          homes.podWide > 0 ? null : majorityWorkspaceFromHomes(homes);
      } else {
        const placed = await this.resolveGraphPlacement(operations, sessionId);
        if (placed) {
          workspaceId = placed;
          this.ctx.workspaceId = placed;
          stampWorkspaceOnUnpinnedOps(operations, placed);
          homes = computeImportHomes(operations);
        }
      }
    }

    const quality = buildImportQualityReport({
      operations,
      homes,
      stats,
      corpusMap: {
        folders: corpusMap.folders.length,
        containers: containerOps.filter((o) => o.op === "create_entity").length,
        intentCounts: corpusMap.intentCounts,
        filesLinkedToContainer: Object.keys(corpusMap.fileToContainerPath)
          .length,
      },
      itemCount: input.items.length,
    });

    let proposalId: string | null = null;
    if (input.previewOnly) {
      logger.info(
        {
          userId,
          workspaceId,
          qualityScore: quality.score,
          source: input.source,
          mode: "deep",
          previewOnly: true,
          sessionId: sessionId ?? null,
          multiHome: homes.multiHome,
          ...stats,
        },
        "import.analyzeLarge previewOnly (no proposal)"
      );
    } else {
      const { proposal: created } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: "entity",
        targetId: batchId,
        proposalType: "import.graph",
        action: "create",
        source: "intelligence",
        summary: `${summary} · ${quality.summary}`,
        sessionId: sessionId ?? null,
        data: buildImportGraphProposalData({
          operations,
          source: input.source,
          sourceId: batchId,
          quality,
          homes,
          corpusMap: stats.corpusMap,
        }),
      });
      proposalId = (created as { id?: string })?.id ?? null;
      logger.info(
        {
          userId,
          workspaceId,
          qualityScore: quality.score,
          source: input.source,
          mode: "deep",
          proposalId,
          sessionId: sessionId ?? null,
          multiHome: homes.multiHome,
          ...stats,
        },
        "import.analyzeLarge"
      );
    }

    return {
      workspaceId,
      source: input.source,
      mode: "deep" as const,
      proposalId,
      sessionId: sessionId ?? null,
      operations,
      summary,
      stats,
      aiTyped: entityCount,
      homes,
      quality,
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

    // HITL SSOT: prefer proposal.data.operations over client-supplied ops.
    const operations = await resolveApplyOperations(input);

    // Same session threading as apply() — see note there. The large/chunked
    // path materializes through the identical entityCaller, so it needs the
    // session on ctx for produced-links + automation-firing too.
    const callerCtx = {
      ...trpcCtx,
      workspaceId,
      userId,
      sessionId: this.ctx.sessionId ?? null,
    };
    const entityCaller = regularEntitiesRouter.createCaller(callerCtx as never);
    const relationCaller = relationsRouter.createCaller(callerCtx as never);

    const batchId = randomUUID();
    const refToRealId: Record<string, string> = {};
    let created = 0;
    let linked = 0;

    // U1: always build idempotency hooks (stable namespace) once for all chunks.
    // Chunk refs are re-namespaced (c0_e0, c1_e0, …) so per-op keys stay distinct.
    const idempotencyKey = resolveImportIdempotencyKey({
      ...input,
      operations,
    });
    const idempotency = makeExternalLinkIdempotency(db, {
      // userId-scoped (see apply()) — global index, no cross-tenant collision.
      namespace: `${this.ctx.userId}:${idempotencyKey}`,
      provider: "import",
      userId: this.ctx.userId,
    });
    // One dedup guard shared across all chunks of THIS apply, so a duplicate
    // op.ref split across two chunks can't merge two distinct entities (the
    // per-call Set would otherwise reset each chunk). Fresh per apply → retries
    // (a new applyLarge call) still link correctly via the registered keys.
    const idemSeen = new Set<string>();

    const totalChunks = Math.max(1, Math.ceil(operations.length / chunkSize));
    for (let c = 0; c < totalChunks; c++) {
      const chunk = operations.slice(c * chunkSize, (c + 1) * chunkSize);
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
          idempotency,
          idemSeen,
        }
      );
      // Carry this chunk's ref→id mappings forward for cross-chunk relations.
      Object.assign(refToRealId, res.refToRealId);
      created += res.created;
      linked += res.linked;
      // Project membership (lens-context) per chunk — same as apply().
      // Skips entities materialize already filed via op.projectId.
      await stampProjectMembership(this.ctx, res.entities);

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

    // Close the analyze-time proposal row (PENDING → APPROVED). Best-effort —
    // materialize already succeeded; a close failure must never fail the import.
    await closeImportProposalOnApply(input.proposalId, userId);

    // HITL: suggest useful views — skip when created=0 (no inbox spam on retry).
    const viewProposalIds = await suggestViewsFromImportGraph(
      this.ctx,
      operations,
      { createdCount: created }
    );

    logger.info(
      {
        userId,
        workspaceId,
        source: input.source,
        created,
        linked,
        chunks: totalChunks,
        viewProposalIds,
      },
      "import.applyLarge materialized"
    );
    return {
      workspaceId,
      source: input.source,
      created,
      linked,
      chunks: totalChunks,
      ...(viewProposalIds.length > 0 ? { viewProposalIds } : {}),
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
