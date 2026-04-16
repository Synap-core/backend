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
  HubEntity,
  HubDocument,
  HubChannel,
  HubWorkspace,
  HubWorkspacesListResponse,
  HubUser,
  HubMemoryResult,
  HubListResponse,
  HubSingleResponse,
  CreateEntityInput,
  UpdateEntityInput,
  CreateDocumentInput,
  StoreMemoryInput,
  SendToChannelInput,
  AgentSetupResult,
  PodStatus,
  CaptureProposal,
  CaptureRelation,
  CaptureStructureResponse,
  CaptureExecuteInput,
  CaptureExecuteResponse,
} from "./types.js";
