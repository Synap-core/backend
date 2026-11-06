/**
 * The AI provider Synap AI runs on now, for one person: ONE global choice per
 * pod, never per playbook (founder, run choice v3, 2026-11-05: the provider
 * replaces the IS default AI). Drawn on the Synap AI option of the run choice
 * as "Synap AI · using Anthropic (your key)".
 *
 * The rule is the IS's own, read once:
 *   - order: `providerRoutingOrder` (enabled, lower priority first), the same
 *     helper that builds the IS `routing.default`;
 *   - key: person > space > pod, the IS credential rule
 *     (`resolveProviderCredentialsBatch`); a provider with no key at any tier
 *     cannot answer, so the next one in the order is the one that runs;
 *   - none of the pod's own: Synap credits.
 * Only whether a key EXISTS is read; no secret is decrypted for a label.
 */

import type { RunChoiceProvider } from "@synap-core/types/agents";
import { SYNAP_CREDITS_LABEL } from "@synap-core/types/vocabulary";
import { and, db, eq, inArray } from "@synap/database";
import { aiProviderCredentials, aiProviders } from "@synap/database/schema";
import { providerRoutingOrder } from "../../utils/push-providers-to-is.js";

export async function readActiveAiProvider(p: {
  userId: string;
  workspaceId: string | null;
}): Promise<RunChoiceProvider> {
  const rows = await db
    .select({
      providerId: aiProviders.providerId,
      name: aiProviders.name,
      enabled: aiProviders.enabled,
      priority: aiProviders.priority,
      encryptedApiKey: aiProviders.encryptedApiKey,
    })
    .from(aiProviders);
  const order = providerRoutingOrder(rows);
  const synapCredits: RunChoiceProvider = {
    providerId: null,
    name: SYNAP_CREDITS_LABEL,
    key: "synap",
  };
  if (order.length === 0) return synapCredits;

  const creds = await db
    .select({
      providerId: aiProviderCredentials.providerId,
      userId: aiProviderCredentials.userId,
      workspaceId: aiProviderCredentials.workspaceId,
    })
    .from(aiProviderCredentials)
    .where(
      and(
        inArray(aiProviderCredentials.providerId, order),
        eq(aiProviderCredentials.enabled, true)
      )
    );
  const personKey = new Set(
    creds.filter((c) => c.userId === p.userId).map((c) => c.providerId)
  );
  const spaceKey = new Set(
    p.workspaceId
      ? creds
          .filter((c) => c.userId === null && c.workspaceId === p.workspaceId)
          .map((c) => c.providerId)
      : []
  );
  const byId = new Map(rows.map((r) => [r.providerId, r]));
  for (const providerId of order) {
    const row = byId.get(providerId)!;
    const key = personKey.has(providerId)
      ? ("person" as const)
      : spaceKey.has(providerId)
        ? ("space" as const)
        : row.encryptedApiKey
          ? ("pod" as const)
          : null;
    if (key) return { providerId, name: row.name, key };
  }
  return synapCredits;
}
