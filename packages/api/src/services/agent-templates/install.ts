/**
 * Install ONE agent template (catalog kind `agent`) into `agent_templates`.
 *
 * The one write every path that installs an agent template goes through: the
 * catalog's official install (`installOfficialAgentTemplates`, founder
 * decision D8: every official agent template is installed on every pod) and a
 * marketplace install (`applyMarketInstall` `case "agent"`, which a person or
 * an approved proposal reaches; third-party templates come this way).
 *
 * The row carries the same source link every standalone installed kind
 * carries (`metadata.marketSource`): its `baseline` is the fields as
 * installed, the BASE of every later keep/drop diff. Install never overwrites:
 * a slug that is already installed is left as it is (an update is a diff the
 * person keeps or drops, never a re-install).
 */

import { db, eq } from "@synap/database";
import { agentTemplates } from "@synap/database/schema";
import { parseAgentTemplateSpec } from "@synap-core/types/agents";
import {
  buildMarketSource,
  stampMarketSource,
} from "../capabilities/market-source.js";

/**
 * The agent element of a published definition: the catalog nests it under
 * `agent` (as a skill nests under `skill`); a flat definition is read as-is.
 */
export function agentTemplateElementOf(
  definition: Record<string, unknown> | null | undefined
): unknown {
  if (!definition) return null;
  const nested = definition.agent;
  return nested && typeof nested === "object" ? nested : definition;
}

export type AgentTemplateInstall =
  | { status: "installed"; id: string; slug: string }
  | { status: "exists"; id: string; slug: string }
  | { status: "refused"; slug: string; reason: string };

export async function installAgentTemplate(input: {
  /** The row's slug: the package slug (source-qualified for an added source). */
  slug: string;
  /** The package slug the source link names (the catalog's own slug). */
  packageSlug: string;
  packageVersion: string | null;
  /** The display name: the definition's, else the catalog listing's. */
  name: string;
  definition: Record<string, unknown> | null;
  now?: Date;
}): Promise<AgentTemplateInstall> {
  const [existing] = await db
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, input.slug))
    .limit(1);
  if (existing) return { status: "exists", id: existing.id, slug: input.slug };

  const parsed = parseAgentTemplateSpec(
    agentTemplateElementOf(input.definition)
  );
  if (!parsed.ok) {
    return { status: "refused", slug: input.slug, reason: parsed.reason };
  }
  const { spec } = parsed;
  // The baseline is EXACTLY what is written below, so the keep/drop diff
  // compares like with like.
  const fields = {
    name: input.name,
    harness: spec.harness,
    aliases: spec.aliases,
    worker: spec.worker,
    tried: spec.tried,
    detect: spec.detect,
    wake: spec.wake,
    practices: spec.practices,
  };
  const metadata = stampMarketSource(
    undefined,
    buildMarketSource(fields, {
      packageSlug: input.packageSlug,
      packageVersion: input.packageVersion,
      installedAt: (input.now ?? new Date()).toISOString(),
    })
  );
  const [row] = await db
    .insert(agentTemplates)
    .values({ slug: input.slug, ...fields, metadata })
    // Two installs racing on one slug: the first wins, the second reads it.
    .onConflictDoNothing({ target: agentTemplates.slug })
    .returning({ id: agentTemplates.id });
  if (row) return { status: "installed", id: row.id, slug: input.slug };
  const [raced] = await db
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(eq(agentTemplates.slug, input.slug))
    .limit(1);
  return { status: "exists", id: raced!.id, slug: input.slug };
}
