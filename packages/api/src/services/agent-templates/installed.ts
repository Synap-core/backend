/**
 * The agent templates installed on this pod, as the template seam
 * (`resolveAgentTemplate`) reads them. One read per roster, never per agent.
 * A failed read throws: "no template installed" and "could not tell" are
 * different answers.
 */

import { db, drizzleSql, eq, or } from "@synap/database";
import { agentTemplates } from "@synap/database/schema";
import { readMarketSource } from "../capabilities/market-source.js";
import {
  SURFACE_HARNESS_SLUGS,
  type AgentTemplateWake,
  type McpToolGroupName,
  type McpToolProfile,
} from "@synap-core/types/agents";

export interface InstalledAgentTemplate {
  slug: string;
  name: string;
  harness: string;
  aliases: string[];
  worker: boolean;
  /** The template carries a `wake` block: a runner could start its agents. */
  wakes: boolean;
  /** That block, as installed: what the roster serves a runner. */
  wake: AgentTemplateWake | null;
  /** The catalog version it was installed (or last converged) at. */
  version: string | null;
}

export async function loadInstalledAgentTemplates(): Promise<
  InstalledAgentTemplate[]
> {
  const rows = await db
    .select({
      slug: agentTemplates.slug,
      name: agentTemplates.name,
      harness: agentTemplates.harness,
      aliases: agentTemplates.aliases,
      worker: agentTemplates.worker,
      wake: agentTemplates.wake,
      metadata: agentTemplates.metadata,
    })
    .from(agentTemplates);
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    harness: r.harness,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    worker: r.worker,
    wakes: r.wake != null,
    wake: r.wake ?? null,
    version: readMarketSource(r.metadata)?.packageVersion ?? null,
  }));
}

/**
 * The agent types that are an AI PROGRAM ON A COMPUTER (an engine): what a
 * computer's key may connect by itself, one agent per computer, like Claude
 * Code (decision 59c75aab; founder, 2026-11-07: "a type an installed agent
 * template names always takes the per-computer engine path"). It is the
 * `harness` of every INSTALLED agent template, over the built-in harness
 * registry's surface rows, which stay the floor for a pod whose catalog has
 * not installed its templates yet. Any other type (a custom name) is asked
 * for as the person (`asPerson`). A failed read throws: "not an engine" and
 * "could not tell" are different answers.
 */
export async function loadEngineAgentTypes(): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ harness: agentTemplates.harness })
    .from(agentTemplates);
  return new Set<string>([
    ...SURFACE_HARNESS_SLUGS,
    ...rows.map((r) => r.harness),
  ]);
}

/** The MCP tool surface a template gives its agents' first key. */
export interface TemplateToolSurface {
  toolProfile: McpToolProfile;
  toolGroups: McpToolGroupName[];
}

/**
 * The tool surface an agent of `agentType` starts on, from its INSTALLED
 * template: the one the connect names (`template`) when it is installed for
 * this type, else the templates whose harness (or an alias) is this type.
 * null = no template declares one (the pod's default applies: entry). Two
 * templates of one type that name different surfaces are not guessed
 * between: null.
 * A failed read throws.
 */
export async function loadTemplateToolSurface(
  agentType: string,
  templateSlug: string | null
): Promise<TemplateToolSurface | null> {
  const forType = or(
    eq(agentTemplates.harness, agentType),
    drizzleSql`${agentTemplates.aliases} @> ${JSON.stringify([agentType])}::jsonb`
  );
  const ofType = await db
    .select({
      slug: agentTemplates.slug,
      toolProfile: agentTemplates.toolProfile,
      toolGroups: agentTemplates.toolGroups,
    })
    .from(agentTemplates)
    .where(forType);
  const named = ofType.filter((r) => r.slug === templateSlug);
  const rows = named.length > 0 ? named : ofType;
  const surfaces = new Set(
    rows.map((r) => JSON.stringify([r.toolProfile, r.toolGroups ?? []]))
  );
  const row = rows[0];
  if (!row || surfaces.size !== 1 || !row.toolProfile) return null;
  return {
    toolProfile: row.toolProfile,
    toolGroups: row.toolProfile === "entry" ? [...(row.toolGroups ?? [])] : [],
  };
}
