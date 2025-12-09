/**
 * Chat Types - Shared across Backend and Frontend
 * 
 * Core types for the infinite chat system
 */

// ============================================================================
// Chat Threads
// ============================================================================

export type ThreadType = 'main' | 'branch';
export type ThreadStatus = 'active' | 'merged' | 'archived';

export interface ChatThread {
  id: string;
  userId: string;
  projectId?: string;
  
  title?: string;
  threadType: ThreadType;
  
  // Branching
  parentThreadId?: string;
  branchedFromMessageId?: string;
  branchPurpose?: string;
  
  // Agent
  agentId: string;
  
  // Status
  status: ThreadStatus;
  contextSummary?: string;
  
  // Metadata
  metadata?: Record<string, any>;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  mergedAt?: Date;
}

// ============================================================================
// Messages
// ============================================================================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  threadId: string;
  parentId?: string;
  
  role: MessageRole;
  content: string;
  
  // AI metadata
  metadata?: MessageMetadata;
  
  userId: string;
  timestamp: Date;
  
  // Hash chain
  previousHash?: string;
  hash: string;
  
  deletedAt?: Date;
}

export interface MessageMetadata {
  agentId?: string;
  thinkingSteps?: string[];
  toolCalls?: Array<{
    tool: string;
    args: any;
    result?: any;
  }>;
  entitiesExtracted?: string[]; // Entity IDs
  branchCreated?: string; // Thread ID
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// Entities
// ============================================================================

export type EntityType = 'task' | 'contact' | 'meeting' | 'idea' | 'note' | 'project';

export interface Entity {
  id: string;
  userId: string;
  
  type: EntityType;
  title: string;
  preview?: string;
  
  // File storage
  fileUrl?: string;
  filePath?: string;
  fileSize?: number;
  fileType?: string;
  checksum?: string;
  
  // Properties (flexible schema)
  properties?: Record<string, any>;
  
  // Metadata
  version: number;
  extractedFromMessageId?: string;
  createdBy: 'user' | 'agent';
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

// ============================================================================
// Entity Type-Specific Interfaces
// ============================================================================

export interface TaskEntity extends Entity {
  type: 'task';
  properties: {
    description?: string;
    priority?: 'low' | 'medium' | 'high';
    dueDate?: string; // ISO date
    status?: 'todo' | 'in_progress' | 'done';
    tags?: string[];
  };
}

export interface ContactEntity extends Entity {
  type: 'contact';
  properties: {
    description?: string;
    email?: string;
    phone?: string;
    company?: string;
    role?: string;
  };
}

export interface MeetingEntity extends Entity {
  type: 'meeting';
  properties: {
    description?: string;
    date: string; // ISO datetime
    duration?: number; // minutes
    attendees?: string[];
    location?: string;
  };
}

export interface IdeaEntity extends Entity {
  type: 'idea';
  properties: {
    description: string;
    category?: string;
    priority?: 'low' | 'medium' | 'high';
  };
}

// ============================================================================
// Agents
// ============================================================================

export type LLMProvider = 'claude' | 'openai' | 'ollama' | 'gemini';
export type ExecutionMode = 'simple' | 'react' | 'langgraph';

export interface Agent {
  id: string;
  name: string;
  description?: string;
  
  createdBy: string; // 'system' | user-id
  userId?: string;
  
  // LLM config
  llmProvider: LLMProvider;
  llmModel: string;
  
  // Capabilities
  capabilities: string[];
  systemPrompt: string;
  toolsConfig?: Record<string, any>;
  
  // Execution
  executionMode: ExecutionMode;
  maxIterations: number;
  timeoutSeconds: number;
  
  // Learning
  weight: number;
  performanceMetrics?: Record<string, any>;
  
  active: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Projects
// ============================================================================

export type ProjectStatus = 'active' | 'archived' | 'completed';

export interface Project {
  id: string;
  userId: string;
  
  name: string;
  description?: string;
  
  status: ProjectStatus;
  
  settings?: Record<string, any>;
  metadata?: Record<string, any>;
  
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface SendMessageRequest {
  threadId: string;
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
  content: string;
  entities: Entity[];
  branchDecision?: {
    shouldBranch: boolean;
    branchType?: string;
    purpose?: string;
    agentId?: string;
  };
  thinkingSteps: string[];
}

export interface CreateThreadRequest {
  projectId?: string;
  parentThreadId?: string;
  branchPurpose?: string;
  agentId?: string;
}

export interface CreateThreadResponse {
  threadId: string;
  thread: ChatThread;
}

export interface ListThreadsRequest {
  projectId?: string;
  threadType?: ThreadType;
  limit?: number;
}

export interface ListThreadsResponse {
  threads: ChatThread[];
}

export interface GetMessagesRequest {
  threadId: string;
  limit?: number;
  before?: string; // Message ID for pagination
}

export interface GetMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

export interface CreateEntityRequest {
  type: EntityType;
  title: string;
  description?: string;
  properties?: Record<string, any>;
  projectId?: string;
  extractedFromMessageId?: string;
}

export interface CreateEntityResponse {
  entityId: string;
  entity: Entity;
}

export interface SearchEntitiesRequest {
  query: string;
  type?: EntityType;
  projectId?: string;
  limit?: number;
}

export interface SearchEntitiesResponse {
  entities: Entity[];
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

export type WebSocketEventType = 
  | 'message.received'
  | 'entity.created'
  | 'branch.created'
  | 'thread.updated'
  | 'typing.start'
  | 'typing.stop';

export interface WebSocketEvent {
  type: WebSocketEventType;
  userId: string;
  data: any;
  timestamp: Date;
}

export interface MessageReceivedEvent extends WebSocketEvent {
  type: 'message.received';
  data: {
    threadId: string;
    messageId: string;
    message: Message;
  };
}

export interface EntityCreatedEvent extends WebSocketEvent {
  type: 'entity.created';
  data: {
    entityId: string;
    entity: Entity;
  };
}

export interface BranchCreatedEvent extends WebSocketEvent {
  type: 'branch.created';
  data: {
    threadId: string;
    thread: ChatThread;
  };
}

// ============================================================================
// Helper Types
// ============================================================================

export type ExtractedEntity = 
  | TaskEntity 
  | ContactEntity 
  | MeetingEntity 
  | IdeaEntity;

export interface BranchDecision {
  shouldBranch: boolean;
  branchType?: 'research' | 'technical' | 'financial' | 'creative';
  purpose?: string;
  reasoning: string;
  agentId?: string;
}
