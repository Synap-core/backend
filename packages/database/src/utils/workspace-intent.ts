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
import { SPACE_KIND_ROLES } from "@synap-core/types/workspaces/settings";
import type { WorkspaceIntentSettings } from "../schema/workspaces.js";

/**
 * One produced entry, as a definition declares it: the kind, and what it is
 * to the space (`role`, default `produced`; `helper` = worked here, not an
 * output) and the kind it `feeds`.
 */
const producedEntrySchema = z.object({
  profile: z.string(),
  role: z.enum(SPACE_KIND_ROLES).optional(),
  feeds: z.string().optional(),
});

/**
 * The wire form on a compiled definition — declared by EVERY install door's
 * zod (`createFromDefinition`, `reconcileFromDefinition`, Hub
 * `/packages/apply`): a plain `z.object` strips an undeclared key, which is
 * how catalog lifecycles were once lost (L1c).
 */
export const workspaceIntentDefinitionSchema = z.object({
  label: z.string(),
  produces: z.array(producedEntrySchema).optional(),
  /**
   * The ONE output the space exists to produce (One model plan, decision 3):
   * a profile slug, kind or role, always one of `produces`.
   */
  primary: z.string().optional(),
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
  primary: z.unknown().optional(),
});

/** The stored form of a definition's intent; null when it declares none. */
export function projectTemplateIntent(
  intent: unknown
): WorkspaceIntentSettings | null {
  const parsed = projectedIntentSchema.safeParse(intent);
  if (!parsed.success || !parsed.data.label.trim()) return null;
  const entries = (parsed.data.produces ?? []).flatMap((p) => {
    const entry = producedEntrySchema.safeParse(p);
    const slug = entry.success ? entry.data.profile.trim() : "";
    return entry.success && slug ? [{ ...entry.data, profile: slug }] : [];
  });
  const produces = [...new Set(entries.map((e) => e.profile))];
  // A helper kind and what a kind feeds, each kept only when it names kinds
  // of `produces` (a dangling `feeds` is dropped alone, like `primary`).
  const helpers = [
    ...new Set(
      entries.filter((e) => e.role === "helper").map((e) => e.profile)
    ),
  ];
  const feeds: Record<string, string> = {};
  for (const e of entries) {
    const to = e.feeds?.trim();
    if (to && to !== e.profile && produces.includes(to) && !feeds[e.profile])
      feeds[e.profile] = to;
  }
  // Kept only when it names one of `produces`: a primary the space does not
  // produce is a malformed declaration, dropped alone.
  const primary =
    typeof parsed.data.primary === "string" ? parsed.data.primary.trim() : "";
  return {
    label: parsed.data.label.trim(),
    produces,
    ...(primary && produces.includes(primary) ? { primary } : {}),
    // Omitted when none: an intent with no helper stores what it stored before.
    ...(helpers.length > 0 ? { helpers } : {}),
    ...(Object.keys(feeds).length > 0 ? { feeds } : {}),
    source: "template",
  };
}
