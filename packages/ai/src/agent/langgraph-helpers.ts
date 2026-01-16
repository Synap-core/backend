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

/**
 * Export LangGraph primitives for agent building
 */
export { StateGraph, START, END, Annotation } from "@langchain/langgraph";

/**
 * @deprecated This package is deprecated. Use Intelligence Service instead.
 *
 * Common agent state fields were removed due to LangGraph API changes.
 * Define your own state using Annotation.Root() directly.
 *
 * @example
 * ```typescript
 * const MyState = Annotation.Root({
 *   messages: Annotation<Array<{ role: string; content: string }>>(),
 *   userId: Annotation<string>(),
 * });
 * ```
 */
