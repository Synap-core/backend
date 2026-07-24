/**
 * Automation Wire Codecs — Hub Protocol REST schemas for automations.
 *
 * Automations: trigger (event/cron/webhook/manual) + flow definition (nodes + edges).
 * State machine: draft → active → paused/error.
 */

import { z } from "@hono/zod-openapi";

export const AutomationStatusSchema = z
  .enum(["draft", "active", "paused", "error"])
  .openapi("AutomationStatus");

export const AutomationTriggerTypeSchema = z
  .enum(["event", "cron", "webhook", "manual"])
  .openapi("AutomationTriggerType");

/** Free-form flow definition — node/edge shape varies by node type. */
export const FlowDefinitionSchema = z
  .object({
    nodes: z.array(z.record(z.string(), z.unknown())),
    edges: z.array(z.record(z.string(), z.unknown())),
  })
  .openapi("FlowDefinition");

/** Wire shape of an automation row. */
export const WireAutomationSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string().nullable().optional(),
    name: z.string(),
    description: z.string().nullable().optional(),
    triggerType: AutomationTriggerTypeSchema,
    triggerConfig: z.record(z.string(), z.unknown()).optional(),
    flowDefinition: FlowDefinitionSchema.optional(),
    status: AutomationStatusSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .openapi("Automation");

/** GET /automations query. */
export const ListAutomationsQuerySchema = z
  .object({
    userId: z.string(),
    workspaceId: z.string().optional(),
    status: AutomationStatusSchema.optional(),
    limit: z.string().optional(),
  })
  .openapi("ListAutomationsQuery");

/** POST /automations/create request body. */
export const CreateAutomationRequestSchema = z
  .object({
    userId: z.string().optional(),
    agentUserId: z.string().optional(),
    workspaceId: z.string().nullable().optional(),
    sourceMessageId: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    triggerType: AutomationTriggerTypeSchema,
    triggerConfig: z.record(z.string(), z.unknown()).optional(),
    flowDefinition: FlowDefinitionSchema,
    status: AutomationStatusSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateAutomationRequest");

/** PATCH /automations/{automationId} request body. */
export const UpdateAutomationRequestSchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    triggerType: AutomationTriggerTypeSchema.optional(),
    triggerConfig: z.record(z.string(), z.unknown()).optional(),
    flowDefinition: FlowDefinitionSchema.optional(),
    status: AutomationStatusSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("UpdateAutomationRequest");

/** POST /automations/{automationId}/trigger request body. */
export const TriggerAutomationRequestSchema = z
  .object({
    userId: z.string().optional(),
    agentUserId: z
      .string()
      .optional()
      .describe(
        "Explicit agent user ID when an AI agent asks for the run — routes through the governance gate."
      ),
    reasoning: z
      .string()
      .max(2000)
      .optional()
      .describe("AI reasoning surfaced on the proposal card."),
    workspaceId: z.string().nullable().optional(),
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional payload passed to the flow's first node."),
  })
  .openapi("TriggerAutomationRequest");

/** POST /automations/{automationId}/activate|pause request body. */
export const AutomationLifecycleRequestSchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string(),
  })
  .openapi("AutomationLifecycleRequest");
