/**
 * Hub Orchestrator Base
 * 
 * Abstract base class for Hub Orchestrators.
 * 
 * This class defines the interface that all Hub Orchestrators must implement,
 * allowing any Hub (Intelligence Hub or third-party) to follow the same pattern.
 * 
 * @example
 * ```typescript
 * class MyCustomHub extends HubOrchestratorBase {
 *   async executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse> {
 *     // Your implementation
 *   }
 * }
 * ```
 */

import type { ExpertiseRequest, ExpertiseResponse } from './types.js';

/**
 * Hub Orchestrator Base
 * 
 * Abstract base class that defines the interface for Hub Orchestrators.
 * All Hub implementations should extend this class.
 */
export abstract class HubOrchestratorBase {
  /**
   * Execute an expertise request
   * 
   * This method must be implemented by all Hub Orchestrators.
   * It orchestrates the complete flow:
   * 1. Generate access token
   * 2. Retrieve user data from Data Pod
   * 3. Process with Hub-specific logic
   * 4. Submit insight back to Data Pod
   * 
   * @param request - Expertise request from Data Pod
   * @returns Expertise response with insight or error
   */
  abstract executeRequest(request: ExpertiseRequest): Promise<ExpertiseResponse>;
}

