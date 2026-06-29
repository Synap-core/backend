/**
 * Connector → tool materialization (the connect↔apply spine).
 *
 * ONE place that turns a user's live Nango connections into pod-wide provider
 * `tools` rows AND applies each provider's family `CapabilityDefinition` so the
 * connection arrives WITH verbs + skills + grants (not a verb-less stub).
 *
 * Shared by:
 *   - `connectors.syncToolRows` (tRPC) — the browser triggers it on the
 *     Capabilities surface mount.
 *   - `POST /connectors/connect` (Hub REST) — the unified door calls it the
 *     moment a connection is detected, so a CLI/agent connect is self-completing
 *     (no second "open the browser once" step).
 *
 * Idempotent: re-running never duplicates tools (pod-wide unique index on
 * `credential_ref`, mig 0140) and never re-applies a family template once the
 * tool already carries verbs.
 */

import { db, eq, and, isNull } from "@synap/database";
import { tools } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  createCapabilityFromDefinition,
  loadCapabilityTemplate,
} from "../services/capabilities/create-from-definition.js";
import type { Context } from "../types/context.js";

const logger = createLogger({ module: "materialize-tools" });

/**
 * The narrow connector surface materialization needs — satisfied by
 * `NangoConnector` (the only connector with provider integrations + a family
 * template per provider). Declared locally so this module doesn't depend on the
 * full connector class.
 */
export interface MaterializableConnector {
  listConnections(
    userId: string
  ): Promise<Array<{ provider: string; connectionId: string }>>;
  listIntegrations(): Promise<
    Array<{ uniqueKey: string; provider: string; displayName: string }>
  >;
}

/**
 * Provider → capability-template family key.
 *
 * When a provider is connected, this names the family `CapabilityDefinition` that
 * gives the connection its VERBS + skills + grants (instead of a verb-less
 * `kind:'provider'` tool). The key resolves through `loadCapabilityTemplate`,
 * which fetches the definition from the Control Plane catalog (the source of
 * truth). A provider with NO family template degrades gracefully — the bare
 * provider tool is kept and no verbs are applied.
 */
export const PROVIDER_TEMPLATE_KEY: Record<string, string> = {
  // The unified Google connection: ONE `google` integration (Gmail + Calendar +
  // Drive via OAuth scopes) → the multi-API `nango-google` family. Gmail calls
  // ride a Base-Url-Override to gmail.googleapis.com; Calendar/Drive use the
  // provider-default host. This is the canonical Google path.
  google: "nango-google",
};

/** Resolve the family template key for a connected provider, or null. */
export function providerTemplateKey(provider: string): string | null {
  return PROVIDER_TEMPLATE_KEY[provider] ?? null;
}

export interface MaterializeResult {
  synced: number;
  toolIds: string[];
  /** Provider keys whose family template was applied on THIS run (newly verbed). */
  applied: string[];
  /**
   * The verbs a connection unlocked, per provider — derived from the family
   * template's skills. Surfaced for ALL providers with a family template (not
   * just freshly-applied ones) so a caller polling an already-connected provider
   * still learns what it can do. Empty for providers without a template.
   */
  unlocked: Array<{
    provider: string;
    displayName: string;
    skills: Array<{ name: string; description?: string }>;
  }>;
}

/**
 * Materialize the acting user's connected providers into pod-wide tool rows and
 * apply each provider's family template. `ctx` must be a tRPC-compatible caller
 * context (carries `userId`; used to drive the GOVERNED toolsRouter caller).
 */
export async function materializeConnectorTools(
  ctx: Context,
  connector: MaterializableConnector
): Promise<MaterializeResult> {
  const userId = ctx.userId;
  if (!userId) throw new Error("materializeConnectorTools: missing userId");

  const [connections, integrations] = await Promise.all([
    connector.listConnections(userId),
    connector.listIntegrations(),
  ]);

  const displayNameByProvider = new Map(
    integrations.map((i) => [i.uniqueKey, i.displayName])
  );
  const connectedProviders = Array.from(
    new Set(connections.map((c) => c.provider))
  );

  const toolIds: string[] = [];
  const applied: string[] = [];
  const unlocked: MaterializeResult["unlocked"] = [];

  for (const provider of connectedProviders) {
    const credentialRef = `nango://${provider}`;
    const displayName = displayNameByProvider.get(provider) ?? provider;

    const existing = await db
      .select({ id: tools.id, capabilities: tools.capabilities })
      .from(tools)
      .where(
        and(eq(tools.credentialRef, credentialRef), isNull(tools.workspaceId))
      )
      .limit(1);

    let toolId: string | null = null;
    // Whether the resolved tool already carries a verb catalog — gates the
    // connect↔apply family-template application so re-syncs don't re-run it.
    let hasVerbs = false;

    if (existing[0]) {
      toolId = existing[0].id;
      hasVerbs = Array.isArray(existing[0].capabilities)
        ? existing[0].capabilities.length > 0
        : false;
    } else {
      const inserted = await db
        .insert(tools)
        .values({
          workspaceId: null, // pod-wide: a connected provider is available everywhere
          createdBy: userId,
          name: displayName,
          description: `${displayName} connection — credentials routed per account at use time.`,
          kind: "provider",
          credentialRef,
          executor: "is-agent",
          config: { providerConfigKey: provider },
          // The user just connected this account → the materialized tool is
          // born approved (no separate approval step for a connect).
          approved: true,
        })
        // Race backstop: if a concurrent sync inserted this provider first, the
        // partial unique index (mig 0132/0140) makes this a no-op instead of a dup.
        .onConflictDoNothing()
        .returning({ id: tools.id });

      if (inserted[0]) {
        toolId = inserted[0].id;
      } else {
        // Lost the race — the row exists now; pick it up so the caller still
        // gets its id (and the next sync/refetch surfaces it).
        const found = await db
          .select({ id: tools.id, capabilities: tools.capabilities })
          .from(tools)
          .where(
            and(
              eq(tools.credentialRef, credentialRef),
              isNull(tools.workspaceId)
            )
          )
          .limit(1);
        if (found[0]) {
          toolId = found[0].id;
          hasVerbs = Array.isArray(found[0].capabilities)
            ? found[0].capabilities.length > 0
            : false;
        }
      }
    }

    if (!toolId) continue;
    toolIds.push(toolId);

    // ── Close connect↔apply ──────────────────────────────────────────────────
    // A bare connect materialized a verb-LESS provider tool. If this provider
    // has a family CapabilityDefinition, apply it (GOVERNED, via the shared
    // applier) so the connection arrives WITH verbs + skills + grants. The
    // applier reuses the same pod-wide tool by credentialRef (idempotent),
    // derives + writes its verb catalog, and seeds skill grants. Providers
    // WITHOUT a family template degrade gracefully to the bare tool.
    const templateKey = providerTemplateKey(provider);
    if (!templateKey) continue;
    try {
      const def = await loadCapabilityTemplate(templateKey, {
        workspaceId: null,
      });
      // Report what this connection can do — from the template's skills — for
      // ALL providers with a family (even already-verbed ones), so a poll on an
      // already-connected provider still learns its verbs.
      unlocked.push({
        provider,
        displayName,
        skills: (def.skills ?? []).map((s) => ({
          name: s.name,
          description: s.description,
        })),
      });
      // Apply only when the tool has NO verbs yet, so a re-connect / window-focus
      // re-sync never re-applies (no duplicate skills/grants).
      if (hasVerbs) continue;
      // Pod-wide apply: no workspace lens (the connected provider tool is
      // pod-wide). The acting user owns the seeded vault/grants.
      const applyCtx = { ...ctx, workspaceId: null } as unknown as Context;
      await createCapabilityFromDefinition(def, {}, applyCtx);
      applied.push(provider);
    } catch (err) {
      // Graceful degrade — keep the bare tool; the connection still works, it
      // just lacks the structured verb catalog until applied explicitly.
      logger.warn(
        { provider, templateKey, err: String(err) },
        "connect↔apply: family template apply failed; kept bare provider tool"
      );
    }
  }

  return { synced: toolIds.length, toolIds, applied, unlocked };
}
