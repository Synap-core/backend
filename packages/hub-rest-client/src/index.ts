/**
 * @synap/hub-rest-client
 *
 * Zero-dependency TypeScript client for the Synap Hub Protocol REST API.
 *
 * Works in Node.js >= 18, browsers, Deno, Bun, and Raycast extensions.
 *
 * @example Basic usage
 * ```ts
 * import { HubRestClient } from "@synap/hub-rest-client";
 *
 * const client = new HubRestClient({
 *   podUrl: "https://my-pod.synap.live",
 *   apiKey: process.env.SYNAP_HUB_API_KEY!,
 * });
 *
 * const entities = await client.searchEntities("meeting notes");
 * const task = await client.createEntity({ profileSlug: "task", title: "Fix bug" });
 * ```
 *
 * @example Setup flow (new agent)
 * ```ts
 * import { setupAgent, checkPodHealth } from "@synap/hub-rest-client";
 *
 * const status = await checkPodHealth("https://my-pod.synap.live");
 * if (status.healthy) {
 *   const { hubApiKey, workspaceId } = await setupAgent(
 *     "https://my-pod.synap.live",
 *     process.env.PROVISIONING_TOKEN!,
 *     "my-agent"
 *   );
 * }
 * ```
 */

// Client
export { HubRestClient } from "./client.js";
export type { HubRestClientConfig } from "./client.js";

// Errors
export { HubApiError } from "./errors.js";

// Setup utilities
export { checkPodHealth, setupAgent } from "./setup.js";

// Types
export type {
  // Core entity types
  HubEntity,
  HubDocument,
  HubDocumentChange,
  HubDocumentProposalResult,
  HubChannel,
  HubWorkspace,
  HubWorkspacesListResponse,
  HubUser,
  HubMemoryResult,
  HubListResponse,
  HubSingleResponse,
  // Relations & Graph
  HubRelation,
  HubGraphNode,
  HubGraphEdge,
  HubGraphResult,
  HubConnection,
  HubConnectionsResult,
  // Profiles & Schema
  HubProfile,
  HubPropertyDef,
  HubDiscoverResult,
  HubDiscoverProfile,
  HubDiscoverProperty,
  HubDiscoverOptions,
  HubOrientScope,
  HubOrientDetail,
  HubOrientProfile,
  HubOrientWorkspace,
  HubOrientProject,
  HubOrientTeamRoster,
  HubOrientResult,
  HubOrientOptions,
  // Threads & Channels
  HubThread,
  HubMessage,
  HubThreadContext,
  // Proposals
  HubProposal,
  // Views
  HubView,
  HubBentoArrangementResult,
  // Search
  HubSearchResult,
  // Commands & Agents
  HubCommand,
  HubAgentUser,
  // User Context
  HubUserContext,
  // Governance
  HubGovernanceResult,
  HubWriteReceipt,
  HubWriteSource,
  // Capabilities & teaching substrate
  HubCapabilityVerb,
  HubCapability,
  HubCapabilityCatalogConnection,
  HubCapabilityCatalogCard,
  HubCapabilityCatalogResult,
  HubRunnableCapabilityAction,
  HubRunnableCapabilityActionsResult,
  ExecuteCapabilityResult,
  HubAgentSkill,
  ListAgentSkillsOptions,
  HubAgentSkillsResult,
  GetCapabilityBriefsInput,
  HubCapabilityBriefsResult,
  // Input types — Entity
  CreateEntityInput,
  UpdateEntityInput,
  // Input types — Documents
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateDocumentProposalInput,
  // Input types — Memory
  StoreMemoryInput,
  // Input types — Channels
  SendToChannelInput,
  // Input types — Relations, Threads, Views, Commands
  CreateRelationInput,
  CreateThreadInput,
  CreateViewInput,
  UpdateViewInput,
  BentoWidgetInput,
  ArrangeBentoViewInput,
  ExecuteCommandInput,
  // Setup
  AgentSetupResult,
  PodStatus,
  // Capture pipeline
  CaptureProposal,
  CaptureRelation,
  CaptureStructureResponse,
  CaptureExecuteInput,
  CaptureExecuteResponse,
  CaptureGraphEntity,
  CaptureGraphRelation,
  CaptureGraphBinding,
  CaptureGraphRawSource,
  SubmitCaptureGraphInput,
  SubmitCaptureGraphResult,
  AskResponse,
  AskAnswerBlock,
} from "./types.js";
