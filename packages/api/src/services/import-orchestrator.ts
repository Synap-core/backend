import { randomUUID, createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import { db, messages, MessageRole, MessageAuthorType } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { detectJsonChatShape } from "../import/import-parsers.js";
import {
  adaptItems,
  type ImportSource as ImportAdapterSource,
} from "../import/import-adapters.js";
import {
  buildImportProposal,
  importProposalToComposite,
} from "../import/import-items.js";
import { aiEnrichImportItems } from "../import/import-ai.js";
import {
  deepStructureImportItems,
  makeGraphResolver,
} from "../import/import-deep.js";
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

type OrchestratorContext = {
  workspaceId: string;
  userId: string;
  trpcCtx: Record<string, unknown>;
};

export type SubmitBatchItem = {
  path: string;
  contentBase64: string;
  mimeType?: string;
};

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

    for (const { path, content, mimeType } of decoded) {
      stats.filesReceived++;
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const canTransform =
        (MIME_TRANSFORM as readonly string[]).includes(mimeType) ||
        EXT_TRANSFORM[ext];

      try {
        const storageKey = `imports/${userId}/${batchId}/${path}`;
        await storage.upload(storageKey, Buffer.from(content, "utf-8"), {
          contentType: mimeType,
          metadata: { batchId, workspaceId },
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
            const { proposalId } = await this.proposeImportGraph(engineSource, [
              { path, content },
            ]);
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
        stats.errors.push({
          path,
          message: e instanceof Error ? e.message : "Import failed",
        });
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
    raw: Array<{ path: string; content: string }>
  ): Promise<{ proposalId: string | null; itemCount: number }> {
    const { workspaceId, userId } = this.ctx;
    const items = adaptItems(source, raw);
    if (items.length === 0) return { proposalId: null, itemCount: 0 };

    const { availableProfiles, validSlugs, availableWorkspaces } =
      await this.resolveProfileHints();

    // Prose (markdown/obsidian) → DEEP extraction: decompose each note into
    // multiple typed entities + relations, merged + deduplicated across notes.
    // Structured rows (csv/bookmark) stay on the SHALLOW path (1 row = 1 entity,
    // which is correct for them). Deep is best-effort: if it yields nothing
    // (IS down, all timeouts), we fall back to shallow so an import never fails.
    const isProse = source === "obsidian" || source === "markdown";
    let operations: CompositeProposalOperation[] | undefined;
    let summary: string | undefined;
    let itemCount = items.length;

    if (isProse) {
      try {
        const { client } = await resolveIntelligenceService({
          userId,
          workspaceId,
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
              workspaceId,
            }),
          },
          { logger }
        );
        if (deep.stats.entityCount > 0) {
          operations = deep.operations;
          itemCount = deep.stats.itemsProcessed;
          const typeCount = Object.keys(deep.stats.byType).length;
          const linkedNote = deep.stats.linkedToExisting
            ? `, ${deep.stats.linkedToExisting} linked to existing`
            : "";
          summary = `Deep import ${deep.stats.itemsProcessed} ${source} note(s) → ${deep.stats.entityCount} entit${deep.stats.entityCount === 1 ? "y" : "ies"} (${typeCount} type${typeCount === 1 ? "" : "s"}), ${deep.stats.relationCount} relation(s)${linkedNote}`;
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
          workspaceId,
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
      const linkCount = operations.length - proposal.stats.itemCount;
      summary = `Import ${proposal.stats.itemCount} ${source} item(s) → ${proposal.stats.typeCount} type(s), ${linkCount} link(s)`;
    }

    const { proposal: created } = await createEventBackedProposal({
      userId,
      workspaceId,
      targetType: "entity",
      targetId: randomUUID(),
      proposalType: "import.graph",
      action: "create",
      source: "intelligence",
      summary,
      data: { operations, source },
    });

    return {
      proposalId: (created as { id?: string })?.id ?? null,
      itemCount,
    };
  }

  async queueLinkedInContacts(contacts: LinkedInContactPayload[]) {
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
