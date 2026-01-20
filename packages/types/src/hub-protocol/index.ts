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

  /** Whether to stream response */
  stream?: boolean;
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
 * AI thinking step - shows what the AI is doing
 */
export interface AIStep {
  id: string;
  type: AIStepType | string;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  timestamp: string;
  duration?: number;
  error?: string;
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
 * Metadata stored in conversation_messages.metadata
 *
 * Intelligence Service can add custom fields beyond these.
 */
export interface MessageMetadata {
  aiSteps?: AIStep[];
  entities?: ExtractedEntity[];
  branchDecision?: BranchDecision;
  usage?: TokenUsage;
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
