/**
 * Import Router
 *
 * Bulk import of user data: JSON → channels/messages, Markdown → entities (+ optional docs),
 * CSV → entities (with optional profile creation). Other files stored only.
 * Reuses documents.upload, entities.create, chat.createExternalChannel + message insert.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { randomUUID, createHash } from "crypto";
import { storage } from "@synap/storage";
import { db, messages, MessageRole, MessageAuthorType } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  parseMarkdown,
  parseCsv,
  detectJsonChatShape,
} from "../utils/import-parsers.js";
import { sanitizeImportPath, mimeFromPath } from "../utils/import-path.js";
import { entitiesRouter } from "./entities.js";
import { channelsRouter } from "./channels.js";

const logger = createLogger({ module: "import-router" });

// ─── Limits ─────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per file
const MAX_BATCH_FILES = 50;
const MAX_BATCH_BYTES = 20 * 1024 * 1024; // 20MB total per batch

const MIME_TRANSFORM = [
  "application/json",
  "text/markdown",
  "text/csv",
  "text/plain",
] as const;

const EXT_TRANSFORM: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  txt: "text/plain",
};

// ─── Schemas ─────────────────────────────────────────────────────────────────
const ImportItemSchema = z.object({
  path: z.string().min(1).max(512),
  contentBase64: z.string(),
  mimeType: z.string().optional(),
});

const SubmitBatchSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  items: z.array(ImportItemSchema).min(1).max(MAX_BATCH_FILES),
});

// ─── Router ─────────────────────────────────────────────────────────────────

export const importRouter = router({
  submitBatch: workspaceProcedure
    .input(SubmitBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Workspace ID required. Set X-Workspace-Id or pass workspaceId.",
        });
      }
      const userId = ctx.userId as string;
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

      // Decode and validate size
      const decoded: Array<{
        path: string;
        content: string;
        mimeType: string;
      }> = [];
      let totalBytes = 0;
      for (const item of input.items) {
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
          decoded.push({
            path,
            content: buf.toString("utf-8"),
            mimeType,
          });
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

      const callerCtx = {
        ...ctx,
        workspaceId,
        userId,
      };
      const entitiesCaller = entitiesRouter.createCaller(callerCtx as any);
      const chatCaller = channelsRouter.createCaller(callerCtx as any);

      for (const { path, content, mimeType } of decoded) {
        stats.filesReceived++;
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const canTransform =
          MIME_TRANSFORM.includes(mimeType as any) || EXT_TRANSFORM[ext];

        try {
          // 1. Store raw under imports/{batchId}/{path}
          const storageKey = `imports/${userId}/${batchId}/${path}`;
          await storage.upload(storageKey, Buffer.from(content, "utf-8"), {
            contentType: mimeType,
            metadata: { batchId, workspaceId },
          });

          if (!canTransform) {
            stats.filesStoredOnly++;
            continue;
          }

          // 2. JSON → channel + messages
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
                    const hashInput = JSON.stringify({
                      channelId,
                      content: msg.content,
                      role,
                      timestamp: ts.toISOString(),
                    });
                    const hash = createHash("sha256")
                      .update(hashInput)
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
            } catch (e) {
              stats.filesStoredOnly++;
              logger.debug(
                { path, err: e },
                "JSON not chat-shaped or parse error"
              );
            }
            continue;
          }

          // 3. Markdown → entity (note) + optional document
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
              if (entityRes?.id) {
                stats.entitiesCreated++;
              }
            } catch (e) {
              stats.errors.push({
                path,
                message:
                  e instanceof Error ? e.message : "Entity create failed",
              });
            }
            continue;
          }

          // 4. CSV → entities (use "note" profile; row columns → properties)
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
                if (entityRes?.id) {
                  stats.entitiesCreated++;
                }
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

      return {
        batchId,
        ...stats,
      };
    }),
});
