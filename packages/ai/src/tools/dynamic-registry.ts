/**
 * Dynamic Tool Registry
 *
 * Registry for managing LangGraph tools dynamically.
 * Tools can be registered at runtime by plugins or other modules.
 */

import { type z } from "zod";
import { createLogger } from "@synap-core/core";
import type { AgentToolDefinition } from "./types.js";

const logger = createLogger({ module: "dynamic-tool-registry" });

/**
 * Dynamic Tool Registry
 *
 * Singleton registry for managing tools used by LangGraph agents.
 */
class DynamicToolRegistry {
  private tools: Map<string, AgentToolDefinition<any, any>> = new Map();
  private metadata: Map<
    string,
    { version?: string; source?: string; registeredAt: Date }
  > = new Map();

  /**
   * Register a tool
   */
  register<TInputSchema extends z.ZodTypeAny, TOutput>(
    tool: AgentToolDefinition<TInputSchema, TOutput>,
    metadata?: { version?: string; source?: string }
  ): void {
    if (this.tools.has(tool.name)) {
      logger.warn(
        { toolName: tool.name },
        "Tool already registered, overwriting"
      );
    }

    this.tools.set(tool.name, tool);
    this.metadata.set(tool.name, {
      ...metadata,
      registeredAt: new Date(),
    });
    logger.info(
      {
        toolName: tool.name,
        version: metadata?.version,
        source: metadata?.source,
      },
      "Tool registered"
    );
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): AgentToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAllTools(): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool metadata
   */
  getToolMetadata(
    name: string
  ): { version?: string; source?: string; registeredAt: Date } | undefined {
    return this.metadata.get(name);
  }

  /**
   * Get statistics
   */
  getStats(): { totalTools: number; toolsBySource: Record<string, number> } {
    const toolsBySource: Record<string, number> = {};
    for (const metadata of this.metadata.values()) {
      const source = metadata.source || "unknown";
      toolsBySource[source] = (toolsBySource[source] || 0) + 1;
    }

    return {
      totalTools: this.tools.size,
      toolsBySource,
    };
  }
}

export const dynamicToolRegistry = new DynamicToolRegistry();
