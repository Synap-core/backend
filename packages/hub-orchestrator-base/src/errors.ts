/**
 * Hub Orchestrator Errors
 * 
 * Custom error classes for Hub Orchestrator operations
 */

/**
 * Hub Orchestrator Error
 * 
 * Base error class for Hub Orchestrator operations
 */
export class HubOrchestratorError extends Error {
  constructor(
    message: string,
    public readonly requestId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'HubOrchestratorError';
  }
}

/**
 * Token Generation Error
 * 
 * Thrown when token generation fails
 */
export class TokenGenerationError extends HubOrchestratorError {
  constructor(message: string, requestId?: string, cause?: Error) {
    super(message, requestId, cause);
    this.name = 'TokenGenerationError';
  }
}

/**
 * Data Retrieval Error
 * 
 * Thrown when data retrieval from Data Pod fails
 */
export class DataRetrievalError extends HubOrchestratorError {
  constructor(message: string, requestId?: string, cause?: Error) {
    super(message, requestId, cause);
    this.name = 'DataRetrievalError';
  }
}

/**
 * Insight Submission Error
 * 
 * Thrown when insight submission to Data Pod fails
 */
export class InsightSubmissionError extends HubOrchestratorError {
  constructor(message: string, requestId?: string, cause?: Error) {
    super(message, requestId, cause);
    this.name = 'InsightSubmissionError';
  }
}

/**
 * Agent Execution Error
 * 
 * Thrown when agent execution fails
 */
export class AgentExecutionError extends HubOrchestratorError {
  constructor(message: string, requestId?: string, cause?: Error) {
    super(message, requestId, cause);
    this.name = 'AgentExecutionError';
  }
}

