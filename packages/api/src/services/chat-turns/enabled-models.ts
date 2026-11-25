/**
 * The models the pod has ENABLED, as an app may choose one for a chat turn.
 *
 * ONE resolver for both ends of a choice: `GET /api/hub/ai-providers/available`
 * lists them, and `POST /chat/stream` validates a requested `model` against the
 * very same list (`handleChatStream`). A model id is `<providerId>/<model.id>`
 * (e.g. `openrouter/anthropic/claude-sonnet-4.5`), the format the Intelligence
 * Service resolves in `agentOverrides.modelOverride`.
 *
 * What an app never gets from here: a key, an encrypted key, a credential, a
 * base URL, a priority. The query selects only the columns the answer needs,
 * and the mapper builds each field by name (never a spread of a row), so a new
 * column on `ai_providers` cannot leak by existing.
 */

import { db, eq } from "@synap/database";
import { aiProviders, type AiProviderModelEntry } from "@synap/database/schema";

export interface SelectableModel {
  /** `<providerId>/<model id>`: what a turn's `model` carries. */
  id: string;
  /** The model's own id at its provider (what a person reads). */
  label: string;
  providerId: string;
  providerName: string;
  tier: AiProviderModelEntry["tier"] | null;
  /** The head of the pod's cascade: first model of the first enabled provider. */
  isDefault: boolean;
}

/** The columns the list needs: no key, base URL or priority is ever loaded. */
interface ProviderRowForModels {
  providerId: string;
  name: string;
  priority: number;
  enabled: boolean;
  models: AiProviderModelEntry[] | null;
}

/** Enabled providers only, cascade order (priority, then id), one entry per model. */
export function selectableModels(
  rows: readonly ProviderRowForModels[]
): SelectableModel[] {
  const out: SelectableModel[] = [];
  const ordered = rows
    .filter((r) => r.enabled)
    .sort(
      (a, b) =>
        a.priority - b.priority || a.providerId.localeCompare(b.providerId)
    );
  for (const provider of ordered) {
    for (const model of provider.models ?? []) {
      out.push({
        id: `${provider.providerId}/${model.id}`,
        label: model.id,
        providerId: provider.providerId,
        providerName: provider.name,
        tier: model.tier ?? null,
        isDefault: out.length === 0,
      });
    }
  }
  return out;
}

/** Read the enabled providers' models. Throws when the read fails. */
export async function listEnabledModels(): Promise<SelectableModel[]> {
  const rows = await db.query.aiProviders.findMany({
    where: eq(aiProviders.enabled, true),
    columns: {
      providerId: true,
      name: true,
      priority: true,
      enabled: true,
      models: true,
    },
  });
  return selectableModels(rows);
}
