/**
 * Command Wire Codecs — IS-defined commands and the secured /commands/execute runner.
 */

import { z } from "@hono/zod-openapi";

/** Wire shape of an intelligence command. */
export const WireCommandSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    triggerSlug: z.string().nullable().optional(),
    skillId: z.string().nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Command");

/** GET /commands query. */
export const ListCommandsQuerySchema = z
  .object({
    workspaceId: z.string().optional(),
  })
  .openapi("ListCommandsQuery");

/** GET /commands/{id} params. */
export const CommandIdParamSchema = z
  .object({
    id: z.string(),
  })
  .openapi("CommandIdParam");

/** POST /commands/execute request body. */
export const ExecuteCommandRequestSchema = z
  .object({
    command: z
      .string()
      .describe(
        "Shell-compatible command line. Subject to BLOCKED_COMMAND_PATTERNS."
      ),
    workingDir: z
      .string()
      .optional()
      .describe(
        "Optional working directory. Path traversal and sensitive system dirs are rejected."
      ),
    timeoutMs: z
      .number()
      .optional()
      .describe("Defaults to 30s. Hard-capped at 5 minutes."),
    userId: z.string().optional(),
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Workspace context. When set, rate-limit (10/min) applies and an event is emitted on completion."
      ),
    agentUserId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    reason: z
      .string()
      .optional()
      .describe(
        "Human-readable reason — included in proposal payload when one is created."
      ),
  })
  .openapi("ExecuteCommandRequest");

/**
 * POST /commands/execute response. Discriminator is `status`:
 * - executed: command ran, returns stdout/stderr/exitCode
 * - proposed: turned into a pending proposal (manual approval required)
 * - denied: blocked by security policy or RBAC
 */
export const ExecuteCommandResponseSchema = z
  .object({
    status: z.enum(["executed", "proposed", "denied"]),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
    proposalId: z.string().optional(),
    summary: z.string().optional(),
    reasoning: z.string().optional(),
    reviewPath: z.string().optional(),
    reviewUrl: z.string().optional(),
    message: z.string().optional(),
  })
  .openapi("ExecuteCommandResponse");
