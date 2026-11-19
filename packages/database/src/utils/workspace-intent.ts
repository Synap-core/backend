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
import { SPACE_KIND_AS } from "@synap-core/types/workspaces/settings";
import type { WorkspaceIntentSettings } from "../schema/workspaces.js";

/** One produced entry, as a definition declares it: the kind, and `as` (default `output`). */
const producedEntrySchema = z.object({
  profile: z.string(),
  as: z.enum(SPACE_KIND_AS).optional(),
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
  // Kept only when it names one of `produces`: a primary the space does not
  // produce is a malformed declaration, dropped alone.
  const primary =
    typeof parsed.data.primary === "string" ? parsed.data.primary.trim() : "";
  // The primary output is never a helper, whatever an entry says.
  const helpers = [
    ...new Set(
      entries
        .filter((e) => e.as === "helper" && e.profile !== primary)
        .map((e) => e.profile)
    ),
  ];
  return {
    label: parsed.data.label.trim(),
    produces,
    ...(primary && produces.includes(primary) ? { primary } : {}),
    // Omitted when none: an intent with no helper stores what it stored before.
    ...(helpers.length > 0 ? { helpers } : {}),
    source: "template",
  };
}

/** A space's stored intent as its readers take it (`readStoredIntent`). */
export interface StoredSpaceIntent {
  label: string;
  /** Produced profile slugs, in order; [] = a library. */
  produces: string[];
  primary: string | null;
  /** The helper kinds of `produces`; [] = none. */
  helpers: string[];
}

/**
 * THE reader of `settings.intent` (homes, the flow read, the pillar read),
 * lenient: what is well-formed is kept, the rest dropped alone. null when
 * the space stores no intent with a label.
 */
export function readStoredIntent(settings: unknown): StoredSpaceIntent | null {
  const intent = (settings as { intent?: unknown } | null)?.intent as
    | { label?: unknown; produces?: unknown; primary?: unknown; helpers?: unknown }
    | null
    | undefined;
  if (!intent || typeof intent.label !== "string" || !intent.label.trim())
    return null;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const primary =
    typeof intent.primary === "string" && intent.primary.trim()
      ? intent.primary.trim()
      : null;
  return {
    label: intent.label,
    produces: strings(intent.produces),
    primary,
    helpers: strings(intent.helpers),
  };
}
