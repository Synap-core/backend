/**
 * Core system types
 */

export interface CoreConfig {
  // Base paths
  dataPath: string;
  userId: string;

  // Provider configurations
  embeddingsProvider: 'openai' | 'cohere' | 'google' | 'local';
  embeddingsApiKey?: string;
  embeddingsModel?: string;

  transcriptionProvider?: 'openai-whisper' | 'local-whisper';
  transcriptionApiKey?: string;

  agentApiKey: string;
  agentModel?: string;

  // Optional settings
  autoRebuildCache?: boolean;
  autoCommitEnabled?: boolean;
  autoCommitIntervalMs?: number;
}

export interface CaptureOptions {
  autoEnrich?: boolean;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SearchOptions {
  useRAG?: boolean;
  limit?: number;
  tags?: string[];
}

export interface Insight {
  type: 'activity' | 'topics' | 'patterns' | 'suggestions';
  message: string;
  data?: unknown;
}

export interface ChatThread {
  id: string;
  type: 'main' | 'branch';
  parentId?: string;
  status: 'open' | 'merged' | 'archived';
  intent?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  toolCalls?: unknown[];
}

export interface BranchSummary {
  facts: string[];
  artifacts: string[];
  summary: string;
}

