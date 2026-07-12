/**
 * synap_create_verb — pure input validation.
 *
 * Split out of adapter.ts's switch case so the three hard safety constraints
 * (declarative-only, no code execution, well-formed provider-verb fields) are
 * unit-testable without spinning up the DB/tRPC module graph the rest of the
 * adapter pulls in. The tool-existence check (constraint 2 — toolName must
 * already be installed) stays in adapter.ts: it needs a live `tools` table
 * lookup, which is out of scope for a DB-free unit test.
 */

import { z } from "zod";

export const CreateVerbInput = z.object({
  toolName: z.string().min(1),
  verbName: z.string().min(1).max(255),
  description: z.string().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  pathTemplate: z.string().min(1),
  query: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  responseShape: z
    .object({
      collectionPath: z.string().optional(),
      collectionAs: z.string().optional(),
      item: z.record(z.string(), z.string()).optional(),
      scalar: z.record(z.string(), z.string()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid().optional(),
});

export type CreateVerbInput = z.infer<typeof CreateVerbInput>;

export type ValidateCreateVerbResult =
  | { ok: true; data: CreateVerbInput }
  | { ok: false; error: string };

/**
 * Validates a raw synap_create_verb args bag against the three safety
 * constraints this tool exists to enforce:
 *   1. Declarative-only — reject an explicit non-declarative `kind`.
 *   2. No code execution — reject a stray top-level `code` field (the
 *      skills.code column is JS executed in the IS sandbox).
 *   4. Well-formed provider-verb fields — reuses the canonical
 *      ProviderVerbSpec field names (method/pathTemplate/query/body/
 *      responseShape), nothing invented.
 * (Constraint 3 — governance not bypassed — is structural: this function
 * never touches the DB, it only shapes the input the caller then hands to
 * the SAME governed `skillsRouter.create` door every other skill-creation
 * path uses.)
 */
export function validateCreateVerbInput(
  args: Record<string, unknown>
): ValidateCreateVerbResult {
  // Checked on the RAW args before zod strips unknown keys, so a caller
  // can't sneak either past validation by hiding behind an unrecognized key.
  if (args.kind !== undefined && args.kind !== "declarative") {
    return {
      ok: false,
      error:
        `synap_create_verb only creates declarative verbs (safe, no code execution). ` +
        `Got kind='${String(args.kind)}'. Use the skills API directly for code/instruction/builtin skills.`,
    };
  }
  if (args.code !== undefined) {
    return {
      ok: false,
      error:
        "synap_create_verb never accepts executable code. A declarative verb is a deterministic " +
        "HTTP call description only — method + pathTemplate + query/body templates.",
    };
  }

  const parsed = CreateVerbInput.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid synap_create_verb input: ${parsed.error.message}`,
    };
  }

  return { ok: true, data: parsed.data };
}
