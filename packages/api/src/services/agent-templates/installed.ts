/**
 * The agent templates installed on this pod, as the template seam
 * (`resolveAgentTemplate`) reads them. One read per roster, never per agent.
 * A failed read throws: "no template installed" and "could not tell" are
 * different answers.
 */

import { db } from "@synap/database";
import { agentTemplates } from "@synap/database/schema";
import { readMarketSource } from "../capabilities/market-source.js";
import type { AgentTemplateWake } from "@synap-core/types/agents";

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
