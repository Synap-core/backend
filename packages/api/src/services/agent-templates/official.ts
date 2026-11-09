/**
 * The catalog installs every OFFICIAL agent template on every pod (founder
 * decision D8, proposal 3649da4d). This is the one place that does it.
 *
 * WHY NOT A PROPOSAL. From the official source an agent's install otherwise
 * proposes and a person installs (`decideMarketInstall`). D8 decides the
 * other way for this one kind, so that every agent already on the pod can be
 * linked to its program at once (self-healing, D10). An agent template is a
 * description of a program, it grants nothing: what a computer may RUN from
 * it (its `wake`) only runs through a runner the person turned on, and an
 * update to it never auto-applies (a keep/drop diff).
 *
 * WHEN. After each official catalog sync (the jobs worker's IoC hook,
 * registered at boot) and once at boot. Idempotent: an installed slug is left
 * as it is; a retired one is never installed; one template's failure never
 * blocks another, and nothing here throws.
 *
 * Every definition passes the same signature rule every official install
 * passes (`resolveCatalogDefinition` → `assertOfficialDefinition`).
 */

import { and, db, eq, isNull } from "@synap/database";
import { agentTemplates, cpCatalogCache } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { resolveCatalogDefinition } from "../capabilities/marketplace-install.js";
import { officialMarketSource } from "../capabilities/market-sources.js";
import { installAgentTemplate } from "./install.js";

const logger = createLogger({ module: "official-agent-templates" });

export interface OfficialAgentTemplatesReport {
  installed: string[];
  /** Already on the pod: left as they are (updates are a keep/drop diff). */
  existing: string[];
  failed: Array<{ slug: string; reason: string }>;
}

export async function installOfficialAgentTemplates(): Promise<OfficialAgentTemplatesReport> {
  const report: OfficialAgentTemplatesReport = {
    installed: [],
    existing: [],
    failed: [],
  };
  const source = officialMarketSource();
  let listed: Array<typeof cpCatalogCache.$inferSelect>;
  let have: Set<string>;
  try {
    listed = await db
      .select()
      .from(cpCatalogCache)
      .where(
        and(
          eq(cpCatalogCache.source, source.cacheKey),
          eq(cpCatalogCache.kind, "agent"),
          isNull(cpCatalogCache.retiredAt)
        )
      );
    have = new Set(
      (await db.select({ slug: agentTemplates.slug }).from(agentTemplates)).map(
        (r) => r.slug
      )
    );
  } catch (err) {
    logger.warn(
      { err },
      "Could not read the official agent templates (non-fatal)"
    );
    report.failed.push({
      slug: "*",
      reason: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const entry of listed) {
    if (have.has(entry.slug)) {
      report.existing.push(entry.slug);
      continue;
    }
    try {
      const definition = await resolveCatalogDefinition(
        "agent",
        entry.slug,
        entry,
        entry.version
      );
      const res = await installAgentTemplate({
        slug: entry.slug,
        packageSlug: entry.slug,
        packageVersion: entry.version ?? null,
        name:
          (typeof definition?.name === "string" && definition.name) ||
          entry.name ||
          entry.slug,
        definition,
      });
      if (res.status === "installed") report.installed.push(entry.slug);
      else if (res.status === "exists") report.existing.push(entry.slug);
      else report.failed.push({ slug: entry.slug, reason: res.reason });
    } catch (err) {
      report.failed.push({
        slug: entry.slug,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (report.installed.length > 0 || report.failed.length > 0) {
    logger.info(report, "Official agent templates installed by the catalog");
  }
  return report;
}
