/**
 * Types for AI agents
 */

export interface AgentConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: ToolResult;
}

