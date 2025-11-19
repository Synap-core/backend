/**
 * Tool Registry - V1.0 Ecosystem Extensibility
 * 
 * This module provides backward-compatible access to the dynamic tool registry.
 * Core tools are automatically registered at module load time.
 * 
 * For dynamic tool registration, use the dynamic registry directly:
 * ```typescript
 * import { registerTool } from './dynamic-registry.js';
 * registerTool(myTool, { version: '1.0.0', source: 'my-plugin' });
 * ```
 */

import { createEntityTool } from './create-entity-tool.js';
import { semanticSearchTool } from './semantic-search-tool.js';
import { saveFactTool } from './save-fact-tool.js';
import {
  registerTool,
  getTool,
  getAllTools,
  getToolSchemasForPlanner,
  executeTool as executeToolDynamic,
} from './dynamic-registry.js';

// Register core tools at module load time
// These are the built-in tools that come with the kernel
registerTool(createEntityTool, { version: '1.0.0', source: 'core' });
registerTool(semanticSearchTool, { version: '1.0.0', source: 'core' });
registerTool(saveFactTool, { version: '1.0.0', source: 'core' });

// Backward compatibility exports
export const toolRegistry = getAllTools();

export const getToolByName = getTool;

export { executeToolDynamic as executeTool };

export { getToolSchemasForPlanner };

// Re-export dynamic registry functions for plugin developers
export {
  registerTool,
  unregisterTool,
  dynamicToolRegistry,
  getAllTools,
} from './dynamic-registry.js';


