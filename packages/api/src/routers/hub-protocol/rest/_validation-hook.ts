/**
 * The Hub REST validation refusal: the `defaultHook` of the parent
 * `OpenAPIHono` (hub-protocol-rest.ts), so every `app.openapi(...)` route whose
 * params, query or body fail their Zod schema answers the same 400.
 *
 * Body: `HubError` (`_codecs/_openapi.ts`) — one readable sentence in `error`
 * (the format the legacy handlers used, e.g. "userId: Required, fact:
 * Required") plus the same issues per field in `fieldErrors`, the projection
 * tRPC sends as `data.fieldErrors` (`utils/zod-field-errors.ts`). Without a
 * hook, @hono/zod-openapi would return the raw ZodError object.
 */

import type { Context } from "hono";
import {
  zodFieldErrors,
  zodIssuesSentence,
  type ZodIssueLike,
} from "../../../utils/zod-field-errors.js";

export function hubValidationHook(
  result: { success: boolean; error?: { issues: readonly ZodIssueLike[] } },
  c: Context
) {
  if (result.success || !result.error) return;
  const issues = result.error.issues;
  return c.json(
    { error: zodIssuesSentence(issues), fieldErrors: zodFieldErrors(issues) },
    400
  );
}
