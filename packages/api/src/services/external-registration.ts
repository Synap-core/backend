import type { ApiKeyRepository, CreateApiKeyInput } from "@synap/database";
import { apiKeyService } from "./api-keys.js";
import { mintHubInboundKey } from "./hub-integration-registration.js";

export type RegistrationOutcome =
  | "CONNECTED_VERIFIED"
  | "KEY_MINTED_BUT_VERIFICATION_FAILED";

export interface RegistrationResult {
  outcome: RegistrationOutcome;
  verificationError?: string;
  plainKey: string;
  apiKey: Awaited<ReturnType<ApiKeyRepository["create"]>>;
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
  const scope = Array.isArray(verified?.scope)
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
