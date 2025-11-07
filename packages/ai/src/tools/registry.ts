import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentToolContext, ToolExecutionResult } from './types.js';
import { createEntityTool } from './create-entity-tool.js';
import { semanticSearchTool } from './semantic-search-tool.js';
import { saveFactTool } from './save-fact-tool.js';

const registry = [createEntityTool, semanticSearchTool, saveFactTool] as const;

export type RegistryTool = (typeof registry)[number];

const registryMap = new Map(registry.map((tool) => [tool.name, tool]));

export const toolRegistry: ReadonlyArray<RegistryTool> = registry;

export interface PlannerToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export const getToolSchemasForPlanner = (): PlannerToolSchema[] =>
  toolRegistry.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.schema, tool.name),
  }));

export const getToolByName = (name: string): RegistryTool | undefined =>
  registryMap.get(name);

export async function executeTool(
  name: string,
  params: unknown,
  context: AgentToolContext
): Promise<ToolExecutionResult> {
  const tool = getToolByName(name);

  if (!tool) {
    return {
      success: false,
      error: `Tool "${name}" is not registered.`,
    };
  }

  const validation = (tool.schema as z.ZodTypeAny).safeParse(params);

  if (!validation.success) {
    return {
      success: false,
      error: `Invalid parameters for tool "${name}": ${validation.error.message}`,
    };
  }

  try {
    const result = await tool.execute(validation.data, context);
    return {
      success: true,
      result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown tool execution error.',
    };
  }
}


