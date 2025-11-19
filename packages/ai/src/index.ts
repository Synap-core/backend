/**
 * @synap/ai - AI Integration Package
 *
 * Core exports are split across generated bundles so capabilities can
 * selectively add functionality without modifying this file.
 */

export { messageContentToString, extractTokenUsage } from './providers/utils.js';

export * from './generated/chat.js';
export * from './generated/embeddings.js';

// Export agent types and functions
export type { SynapAgentResult } from './agent/graph.js';
export { runSynapAgent } from './agent/graph.js';

// Export dynamic tool registry
export { dynamicToolRegistry } from './tools/dynamic-registry.js';
