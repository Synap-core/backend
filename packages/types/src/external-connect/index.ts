import { z } from "zod";

export const registrationOutcomeSchema = z.enum([
  "CONNECTED_VERIFIED",
  "KEY_MINTED_BUT_VERIFICATION_FAILED",
]);

export type RegistrationOutcome = z.infer<typeof registrationOutcomeSchema>;

export const registrationTraceSchema = z.object({
  flowId: z.string().uuid(),
  outcome: registrationOutcomeSchema,
  verificationError: z.string().optional(),
});

export type RegistrationTrace = z.infer<typeof registrationTraceSchema>;

// The KIND of an external integration a Hub API key is minted for. This is NOT
// the proposal write-source enum (`proposals.source`) — do not "clean up"
// `"openclaw"` here as part of a write-source cleanup. It is a live integration
// kind: `synap init` and the pod-admin connect flow mint keys with
// `integration:"openclaw"`, and the value becomes part of the key's hubId, so
// removing it both rejects those requests at the door AND orphans existing keys.
export const integrationKindSchema = z.enum([
  "raycast",
  "cli",
  "openclaw",
  "custom",
]);

export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export const deeplinkContextSchema = z.object({
  apiKey: z.string(),
  podUrl: z.string().url(),
  workspaceId: z.string().uuid().optional().nullable(),
});

export type DeeplinkContext = z.infer<typeof deeplinkContextSchema>;

export const externalConnectErrorCodeSchema = z.enum([
  "KEY_MINTED_BUT_VERIFICATION_FAILED",
  "setup_agent_deprecated",
]);

export type ExternalConnectErrorCode = z.infer<
  typeof externalConnectErrorCodeSchema
>;

export const externalConnectErrorSchema = z.object({
  error: z.string(),
  code: externalConnectErrorCodeSchema.optional(),
  flowId: z.string().uuid().optional(),
  registration: registrationTraceSchema.optional(),
  message: z.string().optional(),
  adminConnectUrl: z.string().url().optional(),
});

export type ExternalConnectError = z.infer<typeof externalConnectErrorSchema>;

export const setupAgentSuccessSchema = z.object({
  agentUserId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  hubApiKey: z.string(),
  keyId: z.string().uuid(),
  registration: registrationTraceSchema,
});

export type SetupAgentSuccess = z.infer<typeof setupAgentSuccessSchema>;

export const activateAddonSuccessSchema = z.object({
  agentUserId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  hubApiKey: z.string(),
  keyId: z.string().uuid(),
  serviceId: z.string(),
  registration: registrationTraceSchema,
});

export type ActivateAddonSuccess = z.infer<typeof activateAddonSuccessSchema>;
