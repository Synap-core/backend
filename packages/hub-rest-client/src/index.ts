/**
 * @synap-core/hub-rest-client
 *
 * Zero-dependency TypeScript client for the Synap Hub Protocol REST API.
 *
 * Works in Node.js >= 18, browsers, Deno, Bun, and Raycast extensions.
 *
 * @example Basic usage
 * ```ts
 * import { HubRestClient } from "@synap-core/hub-rest-client";
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
 * import { setupAgent, checkPodHealth } from "@synap-core/hub-rest-client";
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

// Portable locator — `{pod}/open/<id>` and `synap://open/<kind>/<id>`
export { openPath, openUrl, openAppUrl } from "./open.js";

// Types
export type {
  // Core entity types
  HubEntity,
  HubDocument,
  HubDocumentPatchOp,
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
  HubWidgetDefinition,
  // Search
  HubSearchResult,
  // Commands & Agents
  HubCommand,
  HubAgentUser,
  // User Context
  HubUserContext,
  // Governance
  HubGovernanceResult,
  HubAttachFacetResult,
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
  PatchDocumentInput,
  // Input types — Memory
  StoreMemoryInput,
  // Input types — Channels
  SendToChannelInput,
  // Input types — Relations, Threads, Views, Commands
  CreateRelationInput,
  CreateProjectInput,
  HubCreateProjectResult,
  HubProject,
  UpdateProjectInput,
  HubProposedResult,
  HubUpdateProjectResult,
  HubLinkProjectWorkspaceResult,
  ReviseProposalInput,
  DeclareWorkspaceSourceInput,
  WorkspaceSourceRole,
  WorkspaceDefaultSource,
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
  CaptureStructureInput,
  CaptureStructureResponse,
  CaptureExecuteInput,
  CaptureExecuteResponse,
  CaptureGraphEntity,
  CaptureGraphRelation,
  CaptureGraphBinding,
  CaptureGraphRawSource,
  CaptureGraphSessionStep,
  CaptureGraphDocumentStep,
  CaptureGraphProjectStep,
  CaptureGraphLinkStep,
  SubmitCaptureGraphInput,
  SubmitCaptureGraphResult,
  AskResponse,
  AskAnswerBlock,
  KnowledgeAnswerSource,
  KnowledgeAnswerPendingMatch,
  KnowledgeAnswerPending,
  KnowledgeAnswerFailure,
  KnowledgeAnswerResponse,
  // Diagnose (third door)
  HubDiagnoseInput,
  HubDiagnoseResult,
  // Focus Sessions
  FocusSessionExpectedOutput,
  CreateFocusSessionInput,
  HubFocusSession,
  CreateFocusSessionResult,
  FocusSessionStatus,
  UpdatableFocusSessionStatus,
  FocusSessionKind,
  ListFocusSessionsOptions,
  HubFocusSessionListItem,
  GetFocusSessionOptions,
  HubFocusSessionWithContinuation,
  HubSessionCriterion,
  UpdateFocusSessionInput,
  UpdateFocusSessionResult,
  HubSessionNudges,
  CompleteFocusSessionInput,
  FocusSessionProposalPackItem,
  CompleteFocusSessionResult,
  RerunFocusSessionInput,
  RerunItemOutcome,
  RerunItemResult,
  RerunPlan,
  RerunFocusSessionResult,
  // Structure doors (governed: kinds, roles, workspaces, cells)
  HubProfileFieldInput,
  CreateProfileInput,
  HubProfileFieldResult,
  HubCreateProfileResult,
  CreateWorkspaceFromDefinitionInput,
  HubWorkspaceFromDefinitionResult,
  DefineCellInput,
  HubDefineCellResult,
  // Playbooks
  PlaybookStatus,
  HubPlaybook,
  ListPlaybooksOptions,
  HubPlaybookPage,
  CreatePlaybookInput,
  HubCreatePlaybookResult,
  RunPlaybookInput,
  HubCapabilityEnableOffer,
  HubRunPlaybookResult,
  CreateSkillInput,
  HubCreateSkillResult,
  HubRuleCondition,
  HubRuleSentence,
  CreateRuleInput,
  HubCreateRuleResult,
} from "./types.js";

// Tracks — a method running inside a project (Hub /tracks)
export type {
  HubTrack,
  HubTrackStage,
  HubTrackStatus,
  HubTrackProposed,
  ListTracksOptions,
  StartTrackInput,
  HubStartTrackResult,
  HubStageSessionOffer,
  AdvanceTrackInput,
  HubAdvanceTrackResult,
  HubTrackWriteResult,
  StartStageSessionInput,
  HubStageDomainFallbackReason,
  HubStartStageSessionResult,
  FocusSessionTrackScope,
} from "./tracks.js";
