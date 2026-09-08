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

import { z } from "zod";
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
 */
export const ProviderUpsertSchema = z.object({
  providerId: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  baseUrl: z.string().url(),
  apiKeyEnvVar: z.string().min(1).default("PROVIDER_API_KEY"),
  /** Plaintext API key — encrypted before storage, never returned. */
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).default(10),
  tags: z.array(z.string()).default([]),
  models: z.array(ModelEntrySchema).default([]),
  rateLimit: z
    .object({ rpm: z.number(), rpd: z.number().optional() })
    .optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  systemPromptPrefix: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProviderUpsertInput = z.infer<typeof ProviderUpsertSchema>;

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
  keepExistingKey: z.boolean().optional(),
});

export type AiProviderProposalPayloadInput = z.infer<
  typeof AiProviderProposalPayload
>;
