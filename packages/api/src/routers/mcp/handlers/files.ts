/**
 * MCP tool handler — read a stored file (ticket 66e66dce).
 *
 * An agent could find a file entity but never look at it: no MCP tool
 * returned its URL or its bytes, and the Hub door's bare 403 did not say why.
 * `synap_get_file` is the read over the ONE signer every file URL door uses
 * (`signFileEntityUrl`): the same read floor (the entity rule through
 * `scopedDb`, the key's grant ANDed), the same owner lock on the blob, the
 * same forced `attachment` disposition. A refusal says which floor refused
 * (`refusedBy`: the key's grant, or the person).
 *
 * A small raster image also comes back INLINE, as an MCP `image` block: a
 * chat client (the claude.ai connector) cannot fetch a pod storage URL, and
 * an image sent as text costs many times its tokens.
 */
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import { signFileEntityUrl } from "../../file-upload.js";
import { toolError, fullUuidError } from "../tool-errors.js";
import { ok, requireScope, type McpHandlerMap } from "./shared.js";

const logger = createLogger({ module: "mcp-get-file" });

/** How long the URL lives: the sync verb lifetime (`file-parameters.ts`). */
export const GET_FILE_URL_SECONDS = 15 * 60;

/** Raster types a model client draws from an `image` block. SVG is never one (active content). */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Largest image sent inline: 3 MB of bytes (about 4 MB once base64). */
export const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

const TOO_LARGE = `Over ${INLINE_IMAGE_MAX_BYTES / (1024 * 1024)} MB, too large to send inline: read it at \`url\`.`;

/** Why an image was not sent inline, or null when it can be. */
function notInlineReason(
  mimeType: string | null,
  size: number | null
): string | null {
  if (!mimeType || !INLINE_IMAGE_TYPES.has(mimeType))
    return "Only a PNG, JPEG, GIF or WebP image is sent inline: read the file at `url`.";
  if (size === null || size > INLINE_IMAGE_MAX_BYTES) return TOO_LARGE;
  return null;
}

export const fileHandlers: McpHandlerMap = {
  synap_get_file: async (ctx) => {
    requireScope(ctx.apiKeyScopes, "mcp.read", ctx.toolName);
    const entityId =
      typeof ctx.args.entityId === "string" ? ctx.args.entityId.trim() : "";
    const badId = fullUuidError(ctx.toolName, "entityId", entityId);
    if (badId) return badId;

    const signed = await signFileEntityUrl(ctx.userId, entityId, {
      expiresInSeconds: GET_FILE_URL_SECONDS,
    });
    if (!signed.ok) {
      return toolError(
        signed.refusedBy
          ? `${signed.error} (refusedBy: ${signed.refusedBy})`
          : signed.error
      );
    }

    const { entity, body } = signed;
    const reply = {
      entityId: entity.id,
      title: entity.title,
      mimeType: body.mimeType,
      size: entity.size,
      url: body.url,
      expiresAt: body.expiresAt,
    };
    const skip =
      ctx.args.inline === false
        ? "Not sent inline: you passed inline:false."
        : notInlineReason(body.mimeType, entity.size);
    if (skip || !entity.storageKey) {
      return ok({ ...reply, inline: { sent: false, why: skip } });
    }

    let data: string;
    try {
      const bytes = await storage.downloadBuffer(entity.storageKey);
      if (bytes.length > INLINE_IMAGE_MAX_BYTES) {
        return ok({
          ...reply,
          inline: { sent: false, why: TOO_LARGE },
        });
      }
      data = bytes.toString("base64");
    } catch (err) {
      // The URL is signed and good; only the inline copy failed. Said, never
      // dropped: the agent must not read "no image" as "nothing to see".
      logger.warn({ err, entityId }, "get_file: inline read failed");
      return ok({
        ...reply,
        inline: {
          sent: false,
          why: "The image could not be read for inline sending: read it at `url`.",
        },
      });
    }
    const result = ok({ ...reply, inline: { sent: true } });
    return {
      ...result,
      content: [
        ...result.content,
        { type: "image", data, mimeType: body.mimeType! },
      ],
    };
  },
};
