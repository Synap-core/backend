/**
 * An AI's ask for one more thing — Hub Protocol REST schemas for
 * POST /agents/access-requests and GET /agents/access-requests/{id}
 * (`services/agent-access-ask.ts`). The answer reads as an app's ask does
 * (`AccessAskReceiptSchema`, `AccessAskViewSchema`); only the body differs:
 * every pair names a space by id, reads included.
 */

import { z } from "@hono/zod-openapi";
import { APP_ACCESS_ASK_MAX_PAIRS } from "@synap-core/types/grants";

export const AgentAccessAskPairSchema = z.object({
  permission: z
    .string()
    .min(1)
    .max(120)
    .describe(
      "A permission inside the agent's limits, usually the `ask.permission` of the refusal (GRANT_DENIED with `askable: true`)."
    ),
  workspaceId: z
    .string()
    .uuid()
    .describe("The space, by id: every pair names one, reads included."),
});

export const AgentAccessAskBodySchema = z.object({
  requests: z
    .array(AgentAccessAskPairSchema)
    .min(1)
    .max(APP_ACCESS_ASK_MAX_PAIRS),
  reason: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Why the agent needs it, shown to the person as the agent's words."
    ),
});
