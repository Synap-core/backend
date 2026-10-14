/**
 * A template's `meta.intent` → `workspaces.settings.intent` (object-first
 * homes). The catalog compiles the authored `meta.intent` onto the definition's
 * TOP-LEVEL `intent` (never `_meta`: the control plane rebuilds `_meta` from
 * its columns, so an intent there would never reach a pod).
 *
 * Validation lives at the AUTHORING layer (the catalog validator: produced
 * profiles exist and declare a lifecycle, label ≤ 24 chars). This is the
 * transport: it keeps what is well-formed and drops what is not, so a
 * malformed definition can never write a half-shaped intent.
 */
import { z } from "zod";
import type { WorkspaceIntentSettings } from "../schema/workspaces.js";

/**
 * The wire form on a compiled definition — declared by EVERY install door's
 * zod (`createFromDefinition`, `reconcileFromDefinition`, Hub
 * `/packages/apply`): a plain `z.object` strips an undeclared key, which is
 * how catalog lifecycles were once lost (L1c).
 */
export const workspaceIntentDefinitionSchema = z.object({
  label: z.string(),
  produces: z.array(z.object({ profile: z.string() })).optional(),
});

export type WorkspaceIntentDefinition = z.infer<
  typeof workspaceIntentDefinitionSchema
>;

/** The stored form of a definition's intent; null when it declares none. */
export function projectTemplateIntent(
  intent: unknown
): WorkspaceIntentSettings | null {
  if (!intent || typeof intent !== "object") return null;
  const { label, produces } = intent as {
    label?: unknown;
    produces?: unknown;
  };
  if (typeof label !== "string" || !label.trim()) return null;
  const slugs = Array.isArray(produces)
    ? produces.flatMap((p) => {
        const slug = (p as { profile?: unknown } | null)?.profile;
        return typeof slug === "string" && slug.trim() ? [slug.trim()] : [];
      })
    : [];
  return {
    label: label.trim(),
    produces: [...new Set(slugs)],
    source: "template",
  };
}
