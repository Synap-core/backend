/**
 * @synap/hub-orchestrator-base
 * 
 * Hub Orchestrator Base - Abstract base class and types for Hub Orchestrators
 * 
 * This package provides the interface and pattern that all Hub Orchestrators
 * (Intelligence Hub or third-party) should follow.
 * 
 * @example
 * ```typescript
 * import { HubOrchestratorBase, type ExpertiseRequest, type ExpertiseResponse } from '@synap/hub-orchestrator-base';
 * 
 * class MyCustomHub extends HubOrchestratorBase {
 *   async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
 *     // Your implementation
 *   }
 * }
 * ```
 */

export { HubOrchestratorBase } from './base.js';
export type {
  ExpertiseRequest,
  ExpertiseResponse,
} from './types.js';
export {
  HubOrchestratorError,
  TokenGenerationError,
  DataRetrievalError,
  InsightSubmissionError,
  AgentExecutionError,
} from './errors.js';

