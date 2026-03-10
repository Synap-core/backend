/**
 * Hub Protocol V1.0 - Contract Types
 *
 * This defines the CONTRACT between Synap Backend and ANY Intelligence Service.
 * Any AI engine implementing this protocol can work with Synap.
 *
 * Backend owns this specification.
 * Intelligence Services implement this specification.
 */
// =============================================================================
// Agent Types (Contract Enum)
// =============================================================================
/**
 * Available agent types
 *
 * Intelligence Services must support these identifiers.
 * Add new types here as needed (extensible enum pattern).
 */
export var AgentType;
(function (AgentType) {
  AgentType["DEFAULT"] = "default";
  AgentType["META"] = "meta";
  AgentType["PROMPTING"] = "prompting";
  AgentType["KNOWLEDGE_SEARCH"] = "knowledge-search";
  AgentType["CODE"] = "code";
  AgentType["WRITING"] = "writing";
  AgentType["ACTION"] = "action";
})(AgentType || (AgentType = {}));
// =============================================================================
// Streaming (Contract)
// =============================================================================
/**
 * SSE event types
 */
export var StreamEventType;
(function (StreamEventType) {
  StreamEventType["CONTENT"] = "content";
  StreamEventType["STEP"] = "step";
  StreamEventType["PROPOSAL"] = "proposal";
  StreamEventType["ENTITIES"] = "entities";
  StreamEventType["BRANCH_DECISION"] = "branch_decision";
  StreamEventType["COMPLETE"] = "complete";
  StreamEventType["ERROR"] = "error";
})(StreamEventType || (StreamEventType = {}));
// =============================================================================
// AI Step Types (Contract)
// =============================================================================
/**
 * AI step types
 */
export var AIStepType;
(function (AIStepType) {
  AIStepType["THINKING"] = "thinking";
  AIStepType["TOOL_CALL"] = "tool_call";
  AIStepType["TOOL_RESULT"] = "tool_result";
  AIStepType["DECISION"] = "decision";
  AIStepType["ERROR"] = "error";
})(AIStepType || (AIStepType = {}));
//# sourceMappingURL=index.js.map
