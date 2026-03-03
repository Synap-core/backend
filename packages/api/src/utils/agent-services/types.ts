/**
 * Agent Service Catalog — Shared Types
 *
 * Defines the shape of a service catalog entry used for generic agent provisioning.
 */

export interface DockerCommandOpts {
  podUrl: string;
  workspaceId: string;
  agentUserId: string;
  apiKey: string;
}

export interface ServiceCatalogEntry {
  /** Machine-readable identifier, e.g. "openclaw" */
  serviceType: string;
  /** Human-readable display name, e.g. "OpenClaw" */
  displayName: string;
  /** Short description of the service's purpose */
  description: string;
  /** Docker image reference */
  dockerImage: string;
  /** Role assigned to the provisioned agent user in the workspace */
  agentRole: "editor" | "viewer" | "admin";
  /** Hub Protocol API key scopes granted to the agent */
  defaultScopes: string[];
  /**
   * Capability string used to find the self-registered intelligence_services record.
   * The record is looked up via `capabilities @> ["matchCapability"]` + registeredVia=hub-protocol.
   */
  matchCapability?: string;
  /** Capabilities to store in the agent user's agentMetadata */
  agentCapabilities: string[];
  /**
   * Build the docker run command string for this service type.
   * @deprecated Use vault-based config pull (intelligenceRegistry.getServiceConfig) instead.
   * Only two env vars are needed for bootstrap: SYNAP_HUB_API_KEY + SYNAP_CONFIG_URL.
   * This remains for backward compat / fallback display when VAULT_SERVER_KEY is unset.
   */
  buildDockerCommand?: (opts: DockerCommandOpts) => string;
}
