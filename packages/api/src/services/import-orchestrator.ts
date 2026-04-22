import { randomUUID, createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { storage } from "@synap/storage";
import { db, messages, MessageRole, MessageAuthorType } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  parseMarkdown,
  parseCsv,
  parseBookmarksHtml,
  detectJsonChatShape,
} from "../utils/import-parsers.js";
import { sanitizeImportPath, mimeFromPath } from "../utils/import-path.js";
import { entitiesRouter } from "../routers/entities.js";
import { channelsRouter } from "../routers/channels.js";
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
      entitiesCreated: 0,
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
    const entitiesCaller = entitiesRouter.createCaller(callerCtx as never);
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

        if (
          mimeType === "text/markdown" ||
          ext === "md" ||
          ext === "markdown"
        ) {
          const { frontmatter, body } = parseMarkdown(content);
          const title =
            (frontmatter.title as string) ||
            path.replace(/\.[^.]+$/, "").slice(0, 200) ||
            "Untitled";
          try {
            const entityRes = await entitiesCaller.create({
              profileSlug: "note",
              title,
              properties: {
                ...(typeof frontmatter === "object" && frontmatter !== null
                  ? (frontmatter as Record<string, unknown>)
                  : {}),
                ...(body ? { content: body } : {}),
              },
              ...(body ? { content: body } : {}),
              source: "user",
            });
            if (entityRes?.id) stats.entitiesCreated++;
          } catch (e) {
            stats.errors.push({
              path,
              message: e instanceof Error ? e.message : "Entity create failed",
            });
          }
          continue;
        }

        if (mimeType === "text/csv" || ext === "csv") {
          const { headers, rows } = parseCsv(content);
          if (headers.length === 0 || rows.length === 0) {
            stats.filesStoredOnly++;
            continue;
          }
          for (const row of rows) {
            const title =
              row[headers[0]] ??
              (row as Record<string, string>).title ??
              (row as Record<string, string>).name ??
              "Untitled";
            const properties: Record<string, unknown> = {};
            for (const h of headers) {
              if (h && row[h] !== undefined && row[h] !== "") {
                const key =
                  h
                    .replace(/\s+/g, "_")
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, "")
                    .slice(0, 100) || "value";
                properties[key] = row[h];
              }
            }
            try {
              const entityRes = await entitiesCaller.create({
                profileSlug: "note",
                title: String(title).slice(0, 500),
                properties,
                source: "user",
              });
              if (entityRes?.id) stats.entitiesCreated++;
            } catch (e) {
              stats.errors.push({
                path: `${path} row`,
                message:
                  e instanceof Error ? e.message : "Entity create failed",
              });
            }
          }
          continue;
        }

        if (mimeType === "text/html" || ext === "html" || ext === "htm") {
          const bookmarks = parseBookmarksHtml(content);
          if (bookmarks.length === 0) {
            stats.filesStoredOnly++;
            continue;
          }
          for (const bookmark of bookmarks) {
            try {
              const entityRes = await entitiesCaller.create({
                profileSlug: "bookmark",
                title: bookmark.title.slice(0, 500),
                properties: {
                  url: bookmark.url,
                  ...(bookmark.tags ? { tags: bookmark.tags } : {}),
                },
                source: "user",
              });
              if (entityRes?.id) stats.entitiesCreated++;
            } catch (e) {
              stats.errors.push({
                path: `${path} bookmark`,
                message:
                  e instanceof Error ? e.message : "Bookmark create failed",
              });
            }
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
