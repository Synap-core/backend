/**
 * LangGraph Agent Helpers
 *
 * Re-exports LangGraph primitives and provides simple utilities for building agents.
 * Plugins should use LangGraph directly for full flexibility.
 *
 * @example Basic Agent
 * ```typescript
 * import { StateGraph, START, END, Annotation } from '@synap/ai';
 *
 * // Define state
 * const MyAgentState = Annotation.Root({
 *   input: Annotation<string>(),
 *   output: Annotation<string | undefined>(),
 * });
 *
 * // Create graph
 * const graph = new StateGraph(MyAgentState)
 *   .addNode('process', async (state) => {
 *     return { output: `Processed: ${state.input}` };
 *   })
 *   .addEdge(START, 'process')
 *   .addEdge('process', END);
 *
 * // Compile and run
 * const agent = graph.compile();
 * const result = await agent.invoke({ input: 'Hello' });
 * ```
 */

import { Annotation } from "@langchain/langgraph";

/**
 * Export LangGraph primitives for agent building
 */
export { StateGraph, START, END, Annotation } from "@langchain/langgraph";

/**
 * Common agent state fields
 *
 * Use these as a starting point for your agent state
 */
export const CommonStateFields = {
  messages: Annotation<Array<{ role: string; content: string }>>({
    reducer: (current: any, update: any) => [...(current || []), ...update],
    default: () => [],
  }),
  userId: Annotation<string>(),
  metadata: Annotation<Record<string, unknown>>({
    reducer: (current: any, update: any) => ({ ...(current || {}), ...update }),
    default: () => ({}),
  }),
};
