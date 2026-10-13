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

/** One produced entry, as a definition declares it. */
const producedEntrySchema = z.object({ profile: z.string() });

/**
 * The wire form on a compiled definition — declared by EVERY install door's
 * zod (`createFromDefinition`, `reconcileFromDefinition`, Hub
 * `/packages/apply`): a plain `z.object` strips an undeclared key, which is
 * how catalog lifecycles were once lost (L1c).
 */
export const workspaceIntentDefinitionSchema = z.object({
  label: z.string(),
  produces: z.array(producedEntrySchema).optional(),
});

export type WorkspaceIntentDefinition = z.infer<
  typeof workspaceIntentDefinitionSchema
>;

/**
 * The same schema, read leniently for the projection: a malformed `produces`
 * (or one bad entry in it) drops alone instead of the whole intent.
 */
const projectedIntentSchema = workspaceIntentDefinitionSchema.extend({
  produces: z.array(z.unknown()).catch([]).optional(),
});

/** The stored form of a definition's intent; null when it declares none. */
export function projectTemplateIntent(
  intent: unknown
): WorkspaceIntentSettings | null {
  const parsed = projectedIntentSchema.safeParse(intent);
  if (!parsed.success || !parsed.data.label.trim()) return null;
  const slugs = (parsed.data.produces ?? []).flatMap((p) => {
    const entry = producedEntrySchema.safeParse(p);
    const slug = entry.success ? entry.data.profile.trim() : "";
    return slug ? [slug] : [];
  });
  return {
    label: parsed.data.label.trim(),
    produces: [...new Set(slugs)],
    source: "template",
  };
}
