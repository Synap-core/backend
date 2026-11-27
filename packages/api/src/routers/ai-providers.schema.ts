/**
 * AI provider write-schema — ONE definition, shared by BOTH write doors.
 *
 * WHY THIS FILE EXISTS: `ai_providers` has two write doors — the tRPC router
 * (`routers/ai-providers.ts`, pod-admin) and the Hub REST router
 * (`routers/hub-protocol/rest/ai-providers.ts`, operator tooling such as the
 * `eve` CLI). They were written independently and had already drifted: the Hub
 * REST body accepted only `{id, tier, contextWindow}` per model and dropped
 * `rateLimit` / `extraBody` / `systemPromptPrefix` / `metadata` entirely, so
 * four fields that exist on the row — `supportsTools`, `supportsJson`,
 * `costPer1MInput`, `costPer1MOutput` — were UNREACHABLE through the door the
 * CLI actually uses. A provider registered over Hub REST therefore could not
 * declare its own costs, and the cost meter priced it from whatever the model
 * table said instead.
 *
 * That is the hand-maintained-projection defect this codebase keeps hitting: a
 * second schema for one table, kept in sync by hand, silently several fields
 * behind. The fix is to DERIVE rather than restate — both doors now parse with
 * these schemas, and the coverage floor below turns "someone added a field to
 * AiProviderModelEntry and forgot this schema" into a COMPILE ERROR rather than
 * a field that quietly never arrives.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { rebindField } from "@synap/database";
import type { AiProviderModelEntry } from "@synap/database/schema";

export const ModelEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(["free", "balanced", "advanced", "complex"]).optional(),
  contextWindow: z.number().optional(),
  supportsTools: z.boolean().optional(),
  supportsJson: z.boolean().optional(),
  costPer1MInput: z.number().optional(),
  costPer1MOutput: z.number().optional(),
});

/**
 * COMPILE-TIME COVERAGE FLOOR — see `.claude/rules/guards-and-tests.md`.
 *
 * The set is DERIVED from `keyof AiProviderModelEntry`, never hand-listed, so a
 * new field on the row joins this check BY EXISTING. Adding one to the type
 * without adding it here makes `Exclude<...>` non-`never`, `_ModelEntryCoverage`
 * resolves to `never`, and the assignment below fails to compile.
 *
 * Positive-controlled: adding a `foo` field to `AiProviderModelEntry` and not to
 * `ModelEntrySchema` fails the build with
 * `Type 'boolean' is not assignable to type 'never'`.
 */
type _ModelEntryCoverage =
  Exclude<
    keyof AiProviderModelEntry,
    keyof (typeof ModelEntrySchema)["shape"]
  > extends never
    ? true
    : never;
const _modelEntryCoverage: _ModelEntryCoverage = true;
void _modelEntryCoverage;

/**
 * The full upsert body. Both doors parse with THIS — the Hub REST door no
 * longer restates a narrower subset.
 *
 * `providerId` and `baseUrl` are deliberately open (free string / any URL): the
 * whole point of the table is registering arbitrary OpenAI-compatible endpoints,
 * including self-hosted ones. The guard against a hostile `baseUrl` is the
 * governance gate + the narrow `providers.write` scope at the door, NOT a
 * closed-set allowlist here.
 *
 * NO DEFAULTS HERE, on purpose. They used to live on this schema
 * (`models: []`, `tags: []`, `metadata: {}`, `enabled: true`, `priority: 10`,
 * `apiKeyEnvVar`), so a parse of an EDIT that did not send a field produced the
 * default, and the update wrote it over the stored row: pod admin's provider
 * form sends no `models`, so every edit of a provider wiped its model list.
 * A field the caller did not send is now ABSENT after the parse: an update
 * writes only what was sent ({@link providerPatch}), and only a NEW provider
 * takes the defaults ({@link newProviderRow}).
 */
export const ProviderUpsertSchema = z.object({
  providerId: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  apiKeyEnvVar: z.string().min(1).optional(),
  /** Plaintext API key — encrypted before storage, never returned. */
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
  tags: z.array(z.string()).optional(),
  models: z.array(ModelEntrySchema).optional(),
  rateLimit: z
    .object({ rpm: z.number(), rpd: z.number().optional() })
    .optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  systemPromptPrefix: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ProviderUpsertInput = z.infer<typeof ProviderUpsertSchema>;

/** The row fields of an upsert (the plaintext key is handled apart). */
export type ProviderFields = Omit<ProviderUpsertInput, "apiKey">;

/**
 * What an UPDATE of an existing provider writes: exactly the fields the caller
 * sent. A field it did not send keeps its stored value (an edit that names no
 * `models` keeps the provider's models). Shared by every writer of an existing
 * row: the tRPC door, the Hub REST door and the approve-executor.
 */
export function providerPatch(fields: ProviderFields): Partial<ProviderFields> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<ProviderFields>;
}

/** What a NEW provider is inserted with: what the caller sent, else the defaults. */
export function newProviderRow(fields: ProviderFields) {
  return {
    ...providerPatch(fields),
    providerId: fields.providerId,
    name: fields.name,
    baseUrl: fields.baseUrl,
    apiKeyEnvVar: fields.apiKeyEnvVar ?? "PROVIDER_API_KEY",
    enabled: fields.enabled ?? true,
    priority: fields.priority ?? 10,
    tags: fields.tags ?? [],
    models: fields.models ?? [],
    metadata: fields.metadata ?? {},
  };
}

/**
 * What a governed provider write stores in `proposals.data`, and what the
 * approve-executor replays.
 *
 * DERIVED from {@link ProviderUpsertSchema} via `.omit`/`.extend` — never
 * restated. A field added to the door therefore reaches the executor by
 * existing, which is the property `session-outputs` lacked when its
 * field-by-field approval rebuild silently dropped `delegatedTo` and
 * `returnedReason`.
 *
 * The plaintext `apiKey` is omitted on purpose: a pending proposal is a
 * broadly-readable row and must never carry a provider secret. The door
 * encrypts at propose time and stores `encryptedApiKey` instead;
 * `keepExistingKey` records "this edit did not supply a key", so the executor
 * can leave a working one in place rather than blanking it.
 */
export const AiProviderProposalPayload = ProviderUpsertSchema.omit({
  apiKey: true,
}).extend({
  encryptedApiKey: z.string().nullish(),
  /**
   * The `ai_providers` row id `encryptedApiKey` was encrypted for (its AAD).
   * Absent on proposals filed before the field-crypto keyring — their key is
   * then the pre-keyring JSON, which is not row-bound.
   */
  keyRowId: z.string().nullish(),
  keepExistingKey: z.boolean().optional(),
});

export type AiProviderProposalPayloadInput = z.infer<
  typeof AiProviderProposalPayload
>;

/**
 * The id an upsert of this payload writes to, and the stored key for it: a
 * key encrypted at propose time for `keyRowId` is re-bound to the row it
 * finally lands in (another write may have created the provider meanwhile).
 * Shared by the REST door and the approve-executor so both write the same.
 */
export function providerKeyForRow(
  payload: AiProviderProposalPayloadInput,
  existing: { id: string; encryptedApiKey: string | null } | undefined
): { rowId: string; encryptedApiKey: string | null } {
  const rowId = existing?.id ?? payload.keyRowId ?? randomUUID();
  const fresh = payload.encryptedApiKey
    ? rebindField(payload.encryptedApiKey, {
        column: "ai_providers.encrypted_api_key",
        fromRowId: payload.keyRowId ?? rowId,
        rowId,
      })
    : null;
  // An omitted key must not blank an existing one: a new ciphertext wins;
  // otherwise keep what is already stored.
  return { rowId, encryptedApiKey: fresh ?? existing?.encryptedApiKey ?? null };
}
