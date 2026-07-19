import type { ApiKeyRepository, CreateApiKeyInput } from "@synap/database";
import type { RegistrationOutcome, RegistrationTrace } from "@synap-core/types";
export type { RegistrationOutcome, RegistrationTrace } from "@synap-core/types";
import { apiKeyService } from "./api-keys.js";
import { mintHubInboundKey } from "./hub-integration-registration.js";

export interface RegistrationResult {
  outcome: RegistrationOutcome;
  verificationError?: string;
  plainKey: string;
  apiKey: Awaited<ReturnType<ApiKeyRepository["create"]>>;
}

export function toRegistrationTrace(
  flowId: string,
  result: Pick<RegistrationResult, "outcome" | "verificationError">
): RegistrationTrace {
  return {
    flowId,
    outcome: result.outcome,
    verificationError: result.verificationError,
  };
}

/**
 * Canonical key issuance path for external integrations.
 * Mint the key and immediately verify it can be authenticated by hub key middleware.
 */
export async function createAndVerifyHubInboundKey(
  apiKeyRepo: ApiKeyRepository,
  input: Omit<CreateApiKeyInput, "key" | "keyPrefix"> & {
    keyPrefix?: string;
    plainKey?: string;
  },
  createdByUserId: string,
  expectedUserId: string
): Promise<RegistrationResult> {
  const { apiKey, plainKey } = await mintHubInboundKey(
    apiKeyRepo,
    input,
    createdByUserId
  );

  const verified = await apiKeyService.validateApiKey(plainKey);
  const scope =
    verified && Array.isArray(verified.scope)
      ? (verified.scope as string[])
      : [];

  if (
    !verified ||
    verified.userId !== expectedUserId ||
    !scope.includes("hub-protocol.read")
  ) {
    return {
      outcome: "KEY_MINTED_BUT_VERIFICATION_FAILED",
      verificationError: !verified
        ? "api key failed middleware validation"
        : verified.userId !== expectedUserId
          ? "api key principal mismatch"
          : "api key missing hub-protocol.read scope",
      plainKey,
      apiKey,
    };
  }

  return {
    outcome: "CONNECTED_VERIFIED",
    plainKey,
    apiKey,
  };
}

/**
 * Mint+verify core for a product-neutral `service` identity (POST /setup/service).
 *
 * Deliberately DIFFERENT from `createAndVerifyHubInboundKey` in three ways that
 * are the whole point of Item 2:
 *   1. keyType is `"service"`, not `"hub_inbound"`.
 *   2. It does NOT call `revokeActiveHubInboundKeysForUser` — minting a second
 *      service key for the same owner/workspace does NOT evict the first (the
 *      core K1 fix; multiple concurrent integrators coexist).
 *   3. `linkedUserId` on the key is forced NULL: the key is owned directly by
 *      `input.userId` (the human owner). A NULL `linkedUserId` means the auth
 *      middleware's agent-identity remap (hub-protocol-rest.ts) does NOT fire,
 *      so no `agentUserId` is set and writes are operator-direct under the
 *      owner's RBAC (whitelisted verbs apply direct; destructive/non-whitelisted
 *      still auto-queue as proposals via the EXISTING governance gate).
 *
 * Scopes are caller-declared (validated against API_KEY_SCOPES upstream), so —
 * unlike the agent path — verification only asserts the key authenticates and
 * resolves to the expected owner, NOT that it carries a specific scope.
 */
export async function createAndVerifyServiceKey(
  apiKeyRepo: ApiKeyRepository,
  input: Omit<
    CreateApiKeyInput,
    "key" | "keyPrefix" | "keyType" | "linkedUserId"
  > & {
    keyPrefix?: string;
    plainKey?: string;
  },
  createdByUserId: string,
  expectedUserId: string
): Promise<RegistrationResult> {
  const { apiKey, plainKey } = await mintHubInboundKey(
    apiKeyRepo,
    {
      ...input,
      keyType: "service",
      // Forced NULL — the key authenticates AS its owner, no agent remap.
      linkedUserId: null,
    },
    createdByUserId
  );

  const verified = await apiKeyService.validateApiKey(plainKey);

  if (!verified || verified.userId !== expectedUserId) {
    return {
      outcome: "KEY_MINTED_BUT_VERIFICATION_FAILED",
      verificationError: !verified
        ? "service key failed middleware validation"
        : "service key principal mismatch",
      plainKey,
      apiKey,
    };
  }

  return {
    outcome: "CONNECTED_VERIFIED",
    plainKey,
    apiKey,
  };
}
