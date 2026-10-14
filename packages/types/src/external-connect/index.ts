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
// the proposal write-source enum (`proposals.source`).
//
// `"openclaw"` is a LEGACY value, accepted and nothing more: Synap no longer
// bundles OpenClaw (2026-10-14), no surface offers it, and it mints with the
// `custom` scopes. It stays accepted because older CLIs and installs still build
// `?integration=openclaw`, and the value is part of the key's hubId
// (`integration:openclaw`), so a reconnect's `replace_existing` still finds and
// revokes the key it replaces. Cut-over: drop it once no supported CLI builds it.
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

/**
 * Most pending agent keys one approval request may carry. `synap init` mints one
 * pending key per harness it finds and opens ONE approval page for all of them;
 * the pod's `/setup/agent/pending/lookup` + `/approve-batch` doors and the
 * pod-admin `/approve-agents` page all read this one number.
 */
export const PENDING_APPROVAL_BATCH_MAX = 20;
