/**
 * Hub Protocol V1.0 - Contract Types
 *
 * This defines the CONTRACT between Synap Backend and ANY Intelligence Service.
 * Any AI engine implementing this protocol can work with Synap.
 *
 * Backend owns this specification.
 * Intelligence Services implement this specification.
 */

// =============================================================================
// Agent Types (Contract Enum)
// =============================================================================

/**
 * Available agent types
 *
 * Intelligence Services must support these identifiers.
 * Add new types here as needed (extensible enum pattern).
 */
export enum AgentType {
  DEFAULT = "default",
  META = "meta",
  PROMPTING = "prompting",
  KNOWLEDGE_SEARCH = "knowledge-search",
  CODE = "code",
  WRITING = "writing",
  ACTION = "action",
  ONBOARDING = "onboarding",
  WORKSPACE_CREATION = "workspace-creation",
}

/**
 * Agent type as string literal union (for flexibility)
 */
export type AgentTypeString = `${AgentType}` | (string & {});

// =============================================================================
// Request/Response (Contract)
// =============================================================================

/**
 * Context provided to Intelligence Service
 */
export interface HubContext {
  documents?: Array<{
    id: string;
    title: string;
    content?: string;
  }>;
  entities?: Array<{
    id: string;
    type: string;
    title: string;
    data?: Record<string, unknown>;
  }>;
  branches?: Array<{
    id: string;
    agentType: string;
    purpose?: string;
  }>;
}

/**
 * Request sent from Backend to Intelligence Service
 */
export interface HubRequest {
  /** User's query/message */
  query: string;

  /** Thread ID for conversation context */
  threadId: string;

  /** User ID for personalization */
  userId: string;

  /** Requested agent type (optional, Intelligence Service can auto-select) */
  agentType?: AgentTypeString;

  /** Opaque configuration for agent (Intelligence Service interprets) */
  agentConfig?: Record<string, unknown>;

  /** Context for agent (documents, entities, etc.) */
  context?: HubContext;

  /**
   * Entity this conversation is bound to (e.g. a client). When set, the
   * Intelligence Service loads that entity and injects its name + key props into
   * the prompt so the agent is subject-aware. Optional, backward-compatible.
   */
  contextEntityId?: string;

  /**
   * Name of a skill to force-load into this turn (e.g. Discord `/skill <name>`).
   * The Intelligence Service injects that skill's content into the system prompt so
   * the agent runs WITH the skill as know-how — the "Claude-Code-with-a-skill" model.
   * Optional, backward-compatible.
   */
  forcedSkillName?: string;

  /** Whether to stream response */
  stream?: boolean;
}

/**
 * A proposal created by backend governance during an AI response.
 * The proposal row already exists in the DB; this is a reference to it.
 */
export interface CreatedProposal {
  /** UUID of the proposal row in proposals table */
  proposalId: string;
  /** Tool that triggered the proposal (e.g. "create_entity", "update_document") */
  toolName: string;
  /** Human-readable summary of the proposed action */
  description: string;
}

/**
 * Response from Intelligence Service to Backend
 */
export interface HubResponse {
  /** Generated content */
  content: string;

  /** AI thinking steps (optional) */
  aiSteps?: AIStep[];

  /** Extracted entities (optional) */
  entities?: ExtractedEntity[];

  /** Branch decision from meta-agent (optional) */
  branchDecision?: BranchDecision;

  /** Token usage statistics (optional) */
  usage?: TokenUsage;

  /** Proposals created by backend governance during this response */
  createdProposals?: CreatedProposal[];
}

// =============================================================================
// Streaming (Contract)
// =============================================================================

/**
 * SSE event types
 */
export enum StreamEventType {
  CONTENT = "content",
  STEP = "step",
  ENTITIES = "entities",
  BRANCH_DECISION = "branch_decision",
  ROUTE_TO_CHANNEL = "route_to_channel",
  COMPLETE = "complete",
  ERROR = "error",
}

/**
 * SSE event from Intelligence Service
 */
export interface HubStreamEvent {
  type: StreamEventType | string;
  content?: string;
  step?: AIStep;
  entities?: ExtractedEntity[];
  decision?: BranchDecision;
  routing?: {
    targetChannelId: string;
    reason: string;
    contextEntity?: { id: string; type?: string; title?: string };
  };
  data?: unknown;
  error?: string;
}

// =============================================================================
// AI Step Types (Contract)
// =============================================================================

/**
 * AI step types
 */
export enum AIStepType {
  THINKING = "thinking",
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  DECISION = "decision",
  ERROR = "error",
}

/**
 * AI step - shows what the AI is doing
 *
 * Represents any step in the AI's reasoning/execution process:
 * - thinking: General analysis and reasoning
 * - tool_call: When AI calls a tool
 * - tool_result: Result from tool execution
 * - decision: AI making a decision
 * - error: Error during processing
 */
export interface AIStep {
  id: string;
  type: AIStepType | string;
  content: string;

  // Tool-related fields (for tool_call and tool_result types)
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;

  // Timing
  timestamp: string;
  duration?: number;

  // Error handling
  error?: string;

  // Optional UX fields for better frontend display
  title?: string; // Short title for the step (e.g., "Assembling context")
  description?: string; // Longer description (optional)
  status?: "pending" | "running" | "complete" | "error"; // For tool calls
}

// =============================================================================
// Entity Types (Contract)
// =============================================================================

/**
 * Entity extracted by AI
 */
export interface ExtractedEntity {
  type: string;
  title: string;
  description?: string;
  data: Record<string, unknown>;
  confidence?: number;
}

// =============================================================================
// Branch Decision (Contract)
// =============================================================================

/**
 * Branch decision from meta-agent
 */
export interface BranchDecision {
  shouldBranch: boolean;
  reason: string;
  suggestedAgentType?: AgentTypeString;
  suggestedTitle?: string;
  suggestedPurpose?: string;
}

// =============================================================================
// Token Usage (Contract)
// =============================================================================

/**
 * Token usage statistics
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// =============================================================================
// Message Metadata (Contract)
// =============================================================================

/**
 * Metadata stored in conversation_messages.metadata (and emitted in chat:message).
 *
 * Backend populates these from the Intelligence Service stream/response.
 * Intelligence Service can add custom fields beyond these.
 */
export interface MessageMetadata {
  /** AI steps (thinking, tool_call, tool_result) for this message */
  aiSteps?: AIStep[];
  /** Extracted entities (legacy/optional) */
  entities?: ExtractedEntity[];
  /** Branch decision from meta-agent (optional) */
  branchDecision?: BranchDecision;
  /** Token usage (optional) */
  usage?: TokenUsage;
  /** Proposals created by backend governance during this AI response */
  proposalIds?: string[];
  /** Intelligence service that generated this message */
  serviceId?: string;
  [key: string]: unknown; // Allow custom metadata
}

// =============================================================================
// Capabilities Discovery (Contract)
// =============================================================================

/**
 * Intelligence Service capabilities
 *
 * Returned by /api/capabilities endpoint
 * Allows frontend to discover what the Intelligence Service supports
 */
export interface IntelligenceCapabilities {
  /** Available agent types */
  agents: AgentCapability[];

  /** Available tools */
  tools?: ToolCapability[];

  /** Supported features */
  features: {
    streaming: boolean;
    branching: boolean;
    entityExtraction: boolean;
    customAgents: boolean;
  };

  /** Protocol version */
  version: string;
}

/**
 * Agent capability metadata
 *
 * Describes an available agent type for UI display
 */
export interface AgentCapability {
  type: AgentTypeString;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  capabilities: string[];
  examples?: string[];
}

/**
 * Tool capability metadata
 *
 * Describes an available tool for UI display
 */
export interface ToolCapability {
  name: string;
  description: string;
  category: string;
  requiresApproval: boolean;
  icon?: string;
}
