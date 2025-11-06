/**
 * Action Extractor - Parse AI Responses into Structured Actions
 * 
 * V0.4: Extracts [ACTION:type:params] from AI text
 */

import { z } from 'zod';

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedAction {
  type: string;
  params: Record<string, unknown>;
  rawText: string;  // The full [ACTION:...] string
}

export interface ExtractionResult {
  cleanContent: string;  // Content without [ACTION] blocks
  actions: ExtractedAction[];
}

// ============================================================================
// ACTION SCHEMAS (Validation)
// ============================================================================

const TaskCreateSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

const TaskUpdateSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
  dueDate: z.string().optional(),
});

const TaskCompleteSchema = z.object({
  taskId: z.string().uuid(),
});

const NoteCreateSchema = z.object({
  content: z.string(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const NoteUpdateSchema = z.object({
  noteId: z.string().uuid(),
  content: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const ProjectCreateSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  tasks: z.array(z.string()).optional(),
});

const SearchSemanticSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

const RelationCreateSchema = z.object({
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  type: z.string(),
});

// Map action types to schemas
const ACTION_SCHEMAS: Record<string, z.ZodSchema> = {
  'task.create': TaskCreateSchema,
  'task.update': TaskUpdateSchema,
  'task.complete': TaskCompleteSchema,
  'task.delete': z.object({ taskId: z.string().uuid() }),
  'note.create': NoteCreateSchema,
  'note.update': NoteUpdateSchema,
  'note.delete': z.object({ noteId: z.string().uuid() }),
  'project.create': ProjectCreateSchema,
  'project.add_task': z.object({
    projectId: z.string().uuid(),
    taskTitle: z.string(),
  }),
  'search.semantic': SearchSemanticSchema,
  'tag.create': z.object({ name: z.string(), color: z.string().optional() }),
  'entity.tag': z.object({ entityId: z.string().uuid(), tagName: z.string() }),
  'relation.create': RelationCreateSchema,
};

// ============================================================================
// ACTION EXTRACTOR
// ============================================================================

export class ActionExtractor {
  /**
   * Extract actions from AI response
   * 
   * Finds all [ACTION:type:params_json] blocks and parses them
   */
  extractActions(aiResponse: string): ExtractionResult {
    const actions: ExtractedAction[] = [];
    let cleanContent = aiResponse;
    
    // Regex to match [ACTION:type:params_json]
    const actionRegex = /\[ACTION:([^:]+):([^\]]+)\]/g;
    let match: RegExpExecArray | null;
    
    while ((match = actionRegex.exec(aiResponse)) !== null) {
      const rawText = match[0];
      const type = match[1];
      const paramsJson = match[2];
      
      try {
        // Parse JSON params
        const params = JSON.parse(paramsJson);
        
        // Validate against schema (if available)
        const schema = ACTION_SCHEMAS[type];
        if (schema) {
          const validated = schema.parse(params);
          actions.push({
            type,
            params: validated as Record<string, unknown>,
            rawText,
          });
        } else {
          // No schema, accept as-is (with warning)
          console.warn(`⚠️  No schema for action type: ${type}`);
          actions.push({
            type,
            params,
            rawText,
          });
        }
        
        // Remove action block from content
        cleanContent = cleanContent.replace(rawText, '').trim();
        
      } catch (error) {
        console.error(`❌ Failed to parse action: ${rawText}`, error);
        // Keep the raw text in content if parsing fails
      }
    }
    
    return {
      cleanContent,
      actions,
    };
  }

  /**
   * Validate action params against schema
   */
  validateAction(type: string, params: unknown): {
    valid: boolean;
    error?: string;
    data?: Record<string, unknown>;
  } {
    const schema = ACTION_SCHEMAS[type];
    
    if (!schema) {
      return {
        valid: false,
        error: `Unknown action type: ${type}`,
      };
    }
    
    try {
      const validated = schema.parse(params);
      return {
        valid: true,
        data: validated as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
        };
      }
      
      return {
        valid: false,
        error: 'Validation failed',
      };
    }
  }

  /**
   * Get available action types
   */
  getAvailableActions(): string[] {
    return Object.keys(ACTION_SCHEMAS);
  }

  /**
   * Get schema for action type
   */
  getActionSchema(type: string): z.ZodSchema | null {
    return ACTION_SCHEMAS[type] || null;
  }
}

// Singleton export
export const actionExtractor = new ActionExtractor();

