/**
 * Shared capability → Nango-provider resolution.
 *
 * The catalog card (`capability-catalog.ts`) derives a capability's connection
 * from its member-tool `credentialRef`s (`nango://google`) — materialized
 * `member_of` tool links for an installed container, or the matched template
 * definition's tools. The connection LIST + the Nango reconciler must resolve the
 * SAME providers, or the list early-returns (empty) while the card shows
 * "Connected". This module is the ONE place that resolution lives so all three
 * agree — replacing the copy the reconciler used to carry.
 *
 * Best-effort: any fault degrades to `[]` (the catalog is equally resilient).
 */

import { db, and, eq, inArray, like } from "@synap/database";
import { capabilities, links, tools } from "@synap/database/schema";

import { fetchCPCapabilityTemplates } from "./cp-template-client.js";

/**
 * `nango://gmail` / a tool config → the Nango providerConfigKey. Non-Nango tools
 * (no `config.providerConfigKey`, no `nango://` ref) resolve to null. Shared by
 * the reconciler and the list so the "which provider" rule is defined once.
 */
export function providerConfigKeyOf(tool: {
  credentialRef: string | null;
  config: unknown;
}): string | null {
  const cfg = (tool.config ?? {}) as Record<string, unknown>;
  if (typeof cfg.providerConfigKey === "string") return cfg.providerConfigKey;
  if (tool.credentialRef?.startsWith("nango://"))
    return tool.credentialRef.replace(/^nango:\/\//, "");
  return null;
}

/**
 * Resolve a capability's Nango providerConfigKeys the SAME way the catalog card
 * derives its connection:
 *   1. Materialized `member_of` tool links whose `credentialRef` is `nango://…`
 *      (the installed-card path, `capability-catalog.ts` §3/§5).
 *   2. FALLBACK — when the capability has NO materialized Nango member tools,
 *      match its container name to a template and read that definition's tools
 *      (mirrors the available-card path, `capability-catalog.ts:863`). This is
 *      what stops the list/reconciler from early-returning empty while the card
 *      can still show the tool via its template def.
 *
 * Returns a deduped provider-key list; `[]` on any fault (never throws).
 */
export async function resolveCapabilityNangoProviderKeys(
  capabilityId: string
): Promise<string[]> {
  // 1. Materialized member_of tool links → nango:// tools.
  const edges = await db
    .select({ toolId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.toType, "capability"),
        eq(links.toId, capabilityId),
        eq(links.linkType, "member_of"),
        eq(links.fromType, "tool")
      )
    );
  const toolIds = edges.map((e) => e.toolId);
  if (toolIds.length > 0) {
    const nangoTools = await db
      .select({ credentialRef: tools.credentialRef, config: tools.config })
      .from(tools)
      .where(
        and(inArray(tools.id, toolIds), like(tools.credentialRef, "nango://%"))
      );
    const keys = uniq(
      nangoTools.map(providerConfigKeyOf).filter((k): k is string => !!k)
    );
    if (keys.length > 0) return keys;
  }

  // 2. Template-def fallback — the card resolves an installed container to its
  //    template by NAME (capability-catalog.ts:836); do the same and read the
  //    def's Nango tools when no member tool carries the provider.
  const [container] = await db
    .select({ name: capabilities.name })
    .from(capabilities)
    .where(eq(capabilities.id, capabilityId))
    .limit(1);
  if (!container) return [];

  const templates = await fetchCPCapabilityTemplates().catch(() => []);
  const lower = container.name.toLowerCase();
  const tpl = templates.find((t) => t.name.toLowerCase() === lower);
  if (!tpl) return [];

  return uniq(
    (tpl.definition.tools ?? [])
      .map((t) =>
        providerConfigKeyOf({
          credentialRef: t.credentialRef ?? null,
          config: t.config ?? null,
        })
      )
      .filter((k): k is string => !!k)
  );
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
