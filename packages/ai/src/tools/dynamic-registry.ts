/**
 * Dynamic Tool Registry
 * 
 * V1.0 Ecosystem Extensibility: Allows tools to be registered dynamically
 * 
 * This registry enables the ecosystem vision where tools can be added via plugins
 * without modifying core code. Tools can be registered at runtime.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentToolContext, ToolExecutionResult, AgentToolDefinition } from './types.js';
import { createLogger, ConflictError } from '@synap/core';

const logger = createLogger({ module: 'tool-registry' });

/**
 * Dynamic Tool Registry
 * 
 * Maintains a map of registered tools that can be added/removed at runtime.
 * This enables plugin-based extensibility.
 */
class DynamicToolRegistry {
  private tools: Map<string, AgentToolDefinition<z.ZodTypeAny, unknown>> = new Map();
  private toolMetadata: Map<string, { version: string; source: string; registeredAt: Date }> = new Map();

  /**
   * Register a tool dynamically
   * 
   * @param tool - The tool definition to register
   * @param metadata - Optional metadata about the tool (version, source plugin, etc.)
   * @throws Error if tool name is already registered
   * 
   * @example
   * ```typescript
   * registry.register(createEntityTool, {
   *   version: '1.0.0',
   *   source: 'core',
   * });
   * ```
   */
  register<T extends z.ZodTypeAny, TResult>(
    tool: AgentToolDefinition<T, TResult>,
    metadata?: { version?: string; source?: string }
  ): void {
    if (this.tools.has(tool.name)) {
      throw new ConflictError(`Tool "${tool.name}" is already registered. Use unregister() first to replace it.`, { toolName: tool.name });
    }

    this.tools.set(tool.name, tool as unknown as AgentToolDefinition<z.ZodTypeAny, unknown>);
    this.toolMetadata.set(tool.name, {
      version: metadata?.version || '1.0.0',
      source: metadata?.source || 'unknown',
      registeredAt: new Date(),
    });

    logger.info({ toolName: tool.name, source: metadata?.source }, 'Tool registered');
  }

  /**
   * Unregister a tool
   * 
   * @param toolName - Name of the tool to unregister
   * @returns true if tool was removed, false if it didn't exist
   */
  unregister(toolName: string): boolean {
    const removed = this.tools.delete(toolName);
    this.toolMetadata.delete(toolName);
    
    if (removed) {
      logger.info({ toolName }, 'Tool unregistered');
    }
    
    return removed;
  }

  /**
   * Get a tool by name
   * 
   * @param toolName - Name of the tool to retrieve
   * @returns The tool definition or undefined if not found
   */
  getTool(toolName: string): AgentToolDefinition<z.ZodTypeAny, unknown> | undefined {
    return this.tools.get(toolName);
  }

  /**
   * Get all registered tools
   * 
   * @returns Array of all registered tool definitions
   */
  getAllTools(): AgentToolDefinition<z.ZodTypeAny, unknown>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool metadata
   * 
   * @param toolName - Name of the tool
   * @returns Tool metadata or undefined if not found
   */
  getToolMetadata(toolName: string): { version: string; source: string; registeredAt: Date } | undefined {
    return this.toolMetadata.get(toolName);
  }

  /**
   * Get all tool names
   * 
   * @returns Array of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool is registered
   * 
   * @param toolName - Name of the tool
   * @returns true if tool is registered, false otherwise
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * Get tool schemas for the planner
   * 
   * @returns Array of tool schemas in planner format
   */
  getToolSchemasForPlanner(): Array<{ name: string; description: string; parameters: unknown }> {
    return this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.schema, tool.name),
    }));
  }

  /**
   * Execute a tool
   * 
   * @param toolName - Name of the tool to execute
   * @param params - Tool parameters
   * @param context - Agent context (userId, threadId)
   * @returns Tool execution result
   */
  async executeTool(
    toolName: string,
    params: unknown,
    context: AgentToolContext
  ): Promise<ToolExecutionResult> {
    const tool = this.getTool(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool "${toolName}" is not registered. Available tools: ${this.getToolNames().join(', ')}`,
      };
    }

    const validation = (tool.schema as z.ZodTypeAny).safeParse(params);

    if (!validation.success) {
      return {
        success: false,
        error: `Invalid parameters for tool "${toolName}": ${validation.error.message}`,
      };
    }

    try {
      const result = await tool.execute(validation.data, context);
      return {
        success: true,
        result,
      };
    } catch (error) {
      logger.error({ err: error, toolName }, 'Tool execution failed');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown tool execution error.',
      };
    }
  }

  /**
   * Clear all registered tools (useful for testing)
   */
  clear(): void {
    this.tools.clear();
    this.toolMetadata.clear();
    logger.info('Tool registry cleared');
  }

  /**
   * Get registry statistics
   * 
   * @returns Statistics about registered tools
   */
  getStats(): {
    totalTools: number;
    toolsBySource: Record<string, number>;
    toolNames: string[];
  } {
    const toolsBySource: Record<string, number> = {};
    
    for (const metadata of this.toolMetadata.values()) {
      toolsBySource[metadata.source] = (toolsBySource[metadata.source] || 0) + 1;
    }

    return {
      totalTools: this.tools.size,
      toolsBySource,
      toolNames: this.getToolNames(),
    };
  }
}

/**
 * Singleton instance of the dynamic tool registry
 * 
 * This is the global registry that all tools should register with.
 * Plugins can register their tools here at runtime.
 */
export const dynamicToolRegistry = new DynamicToolRegistry();

/**
 * Convenience functions for backward compatibility
 */
export const registerTool = <T extends z.ZodTypeAny, TResult>(
  tool: AgentToolDefinition<T, TResult>,
  metadata?: { version?: string; source?: string }
) => dynamicToolRegistry.register(tool, metadata);

export const unregisterTool = (toolName: string) => dynamicToolRegistry.unregister(toolName);

export const getTool = (toolName: string) => dynamicToolRegistry.getTool(toolName);

export const getAllTools = () => dynamicToolRegistry.getAllTools();

export const getToolSchemasForPlanner = () => dynamicToolRegistry.getToolSchemasForPlanner();

export const executeTool = (
  toolName: string,
  params: unknown,
  context: AgentToolContext
) => dynamicToolRegistry.executeTool(toolName, params, context);

