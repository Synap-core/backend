/**
 * Hub Protocol V1.0 - Schemas
 * 
 * Standardized schemas for communication between Synap Intelligence Hub
 * and Synap Core OS (Data Pod).
 * 
 * These schemas ensure type safety and validation at runtime.
 */

import { z } from 'zod';

// ============================================================================
// ACTION SCHEMA
// ============================================================================

/**
 * Action Schema
 * 
 * Represents an action to be transformed into a SynapEvent.
 * Used in insights of type 'action_plan' or 'automation'.
 */
export const ActionSchema = z.object({
  /**
   * Event type to create (must correspond to EventTypes)
   * @example 'task.creation.requested', 'project.creation.requested'
   */
  eventType: z.string().min(1),
  
  /**
   * Aggregate ID (optional, for linking to existing entity)
   */
  aggregateId: z.string().uuid().optional(),
  
  /**
   * Event data (must correspond to the eventType schema)
   */
  data: z.record(z.unknown()),
  
  /**
   * If true, the action requires user confirmation before execution
   * @default false
   */
  requiresConfirmation: z.boolean().default(false),
  
  /**
   * Priority (0-100) for execution order
   * Higher priority actions are executed first
   */
  priority: z.number().int().min(0).max(100).optional(),
  
  /**
   * Action-specific metadata
   */
  metadata: z.record(z.unknown()).optional(),
});

export type Action = z.infer<typeof ActionSchema>;

// ============================================================================
// ANALYSIS SCHEMA
// ============================================================================

/**
 * Source Schema (for analysis sources)
 */
const SourceSchema = z.object({
  type: z.enum(['note', 'task', 'project', 'conversation', 'external']),
  id: z.string().optional(),
  title: z.string().optional(),
  url: z.string().url().optional(),
});

/**
 * Analysis Schema
 * 
 * For insights of type 'analysis' or 'suggestion'.
 * Contains textual analysis to be displayed to the user.
 */
export const AnalysisSchema = z.object({
  /**
   * Title of the analysis
   */
  title: z.string().min(1),
  
  /**
   * Content of the analysis (markdown supported)
   */
  content: z.string().min(1),
  
  /**
   * Key points (bullet points)
   */
  keyPoints: z.array(z.string()).optional(),
  
  /**
   * Recommendations (optional)
   */
  recommendations: z.array(z.string()).optional(),
  
  /**
   * Sources or references (optional)
   */
  sources: z.array(SourceSchema).optional(),
  
  /**
   * Tags for categorization
   */
  tags: z.array(z.string()).optional(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

// ============================================================================
// HUB INSIGHT SCHEMA (MAIN)
// ============================================================================

/**
 * Hub Insight Schema V1.0
 * 
 * Standardized format for insights returned by the Intelligence Hub.
 * This schema guarantees reliable transformation into events.
 * 
 * @example
 * ```typescript
 * const insight: HubInsight = {
 *   version: '1.0',
 *   type: 'action_plan',
 *   correlationId: 'req-123',
 *   actions: [
 *     {
 *       eventType: 'project.creation.requested',
 *       data: { title: 'My Project' },
 *       requiresConfirmation: false,
 *     }
 *   ],
 *   confidence: 0.95,
 *   reasoning: 'Based on user preferences',
 * };
 * ```
 */
export const HubInsightSchema = z.object({
  /**
   * Schema version (for future migrations)
   */
  version: z.literal('1.0'),
  
  /**
   * Type of insight
   */
  type: z.enum([
    'action_plan',    // Plan d'action avec événements à créer
    'suggestion',     // Suggestion à présenter à l'utilisateur
    'analysis',       // Analyse sans action immédiate
    'automation',     // Automatisation à exécuter
  ]),
  
  /**
   * Correlation ID (link with initial request)
   * Must be a UUID matching the requestId from the Hub
   */
  correlationId: z.string().uuid(),
  
  /**
   * Actions to execute (for type: 'action_plan' or 'automation')
   * Each action will be transformed into a SynapEvent
   */
  actions: z.array(ActionSchema).optional(),
  
  /**
   * Textual analysis (for type: 'analysis' or 'suggestion')
   * Contains content to display to the user
   */
  analysis: AnalysisSchema.optional(),
  
  /**
   * Confidence level (0.0 to 1.0)
   * Indicates how confident the agent is in this insight
   */
  confidence: z.number().min(0).max(1),
  
  /**
   * Agent reasoning (optional)
   * Explains why this insight was generated
   */
  reasoning: z.string().optional(),
  
  /**
   * Additional metadata
   */
  metadata: z.record(z.unknown()).optional(),
});

export type HubInsight = z.infer<typeof HubInsightSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate a Hub Insight
 * 
 * @param data - Data to validate
 * @returns Validated HubInsight
 * @throws ZodError if validation fails
 */
export function validateHubInsight(data: unknown): HubInsight {
  return HubInsightSchema.parse(data);
}

/**
 * Validate an Action
 * 
 * @param data - Data to validate
 * @returns Validated Action
 * @throws ZodError if validation fails
 */
export function validateAction(data: unknown): Action {
  return ActionSchema.parse(data);
}

/**
 * Validate an Analysis
 * 
 * @param data - Data to validate
 * @returns Validated Analysis
 * @throws ZodError if validation fails
 */
export function validateAnalysis(data: unknown): Analysis {
  return AnalysisSchema.parse(data);
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Type guard to check if an insight is an action plan
 */
export function isActionPlan(insight: HubInsight): insight is HubInsight & { type: 'action_plan' | 'automation'; actions: Action[] } {
  return (insight.type === 'action_plan' || insight.type === 'automation') && 
         insight.actions !== undefined && 
         insight.actions.length > 0;
}

/**
 * Type guard to check if an insight is an analysis
 */
export function isAnalysis(insight: HubInsight): insight is HubInsight & { type: 'analysis' | 'suggestion'; analysis: Analysis } {
  return (insight.type === 'analysis' || insight.type === 'suggestion') && 
         insight.analysis !== undefined;
}


