/**
 * An app's ask for one more thing — Hub Protocol REST schemas for
 * POST /apps/access-requests and GET /apps/access-requests/{id}
 * (`services/app-access-ask.ts`, plan 647ebfd4 option C). Mirrors
 * `AppAccessAskReceipt` and `AppAccessAskView`.
 */

import { z } from "@hono/zod-openapi";
import {
  APP_ACCESS_ASK_MAX_PAIRS,
  APP_ACCESS_ASK_STATUSES,
} from "@synap-core/types/grants";

const PermissionSchema = z
  .string()
  .min(1)
  .max(120)
  .describe("A permission the app's client-id document declares.");

/** One pair the app asks for: a permission in a space, by id or by template. */
export const AccessAskPairSchema = z.union([
  z.object({
    permission: PermissionSchema,
    workspaceId: z.string().uuid().describe("The space, by id."),
  }),
  z.object({
    permission: PermissionSchema,
    template: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .describe("The space, by the template it was made from."),
  }),
]);

export const AccessAskBodySchema = z.object({
  requests: z.array(AccessAskPairSchema).min(1).max(APP_ACCESS_ASK_MAX_PAIRS),
  reason: z
    .string()
    .max(300)
    .optional()
    .describe("Why the app needs it, shown to the person as the app's words."),
});

const StatusSchema = z.enum(APP_ACCESS_ASK_STATUSES);

const ResolvedPairSchema = z.object({
  permission: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
});

export const AccessAskReceiptSchema = z.object({
  id: z
    .string()
    .nullable()
    .describe(
      "The ask filed now; null when every pair was already given, already asked, or declined less than 30 days ago."
    ),
  status: StatusSchema.nullable(),
  reviewUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
  pairs: z.array(
    ResolvedPairSchema.extend({
      state: z
        .enum(["asked", "given", "open", "quiet"])
        .describe(
          "asked: in the ask filed now; given: the app holds it; open: an earlier ask still waits for it; quiet: the person said Not now less than 30 days ago."
        ),
      askId: z.string().optional(),
    })
  ),
});

export const AccessAskParamsSchema = z.object({
  id: z.string().uuid(),
});

export const AccessAskViewSchema = z.object({
  id: z.string(),
  status: StatusSchema,
  pairs: z.array(ResolvedPairSchema),
  expiresAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
