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
