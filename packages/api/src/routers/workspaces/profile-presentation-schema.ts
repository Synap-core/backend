import { z } from "zod";
import { parseProfilePresentation } from "@synap-core/types/presentation";

/**
 * `profiles[].presentation` (entity rendering, decision 8) — and its CP
 * registry spelling `profiles[].uiHints.presentation`. JUDGED here, by the ONE
 * parser (`parseProfilePresentation`, `@synap-core/types/presentation`): an
 * invalid declaration is refused with the parser's issues, a valid one is
 * normalised (unknown keys dropped). Used by `definition-engine.ts`'s profile
 * schemas (create / reconcile / apply), which are NOT passthrough: without the
 * key they would strip it, and no pod would ever learn it.
 */
export const profilePresentationSchema = z
  .unknown()
  .transform((value, ctx): Record<string, unknown> => {
    const parsed = parseProfilePresentation(value);
    if (!parsed.ok) {
      for (const issue of parsed.issues)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${issue.path}: ${issue.message}`,
        });
      return z.NEVER;
    }
    return parsed.value as unknown as Record<string, unknown>;
  });
