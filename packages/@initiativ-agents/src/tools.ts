/**
 * Tool definitions for LangChain agents
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * Search notes tool
 * Allows agent to search in user's notes
 */
export function createSearchNotesTool(
  searchFn: (query: string) => Promise<Array<{ id: string; content: string; score: number }>>
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'search_notes',
    description: 'Search in user notes using semantic search. Use this when you need to find relevant information from the user\'s knowledge base.',
    schema: z.object({
      query: z.string().describe('The search query')
    }),
    func: async ({ query }) => {
      const results = await searchFn(query);
      
      if (results.length === 0) {
        return 'No notes found for this query.';
      }

      return JSON.stringify({
        found: results.length,
        results: results.slice(0, 5).map(r => ({
          id: r.id,
          snippet: r.content.substring(0, 200) + (r.content.length > 200 ? '...' : ''),
          score: r.score
        }))
      }, null, 2);
    }
  });
}

/**
 * Create note tool
 * Allows agent to create new notes
 */
export function createCreateNoteTool(
  createFn: (content: string, title?: string, tags?: string[]) => Promise<{ id: string; title: string }>
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'create_note',
    description: 'Create a new note in the user\'s knowledge base. Use this to capture important information or ideas.',
    schema: z.object({
      content: z.string().describe('The note content'),
      title: z.string().optional().describe('The note title (optional, will be auto-generated if not provided)'),
      tags: z.array(z.string()).optional().describe('Tags for the note (optional)')
    }),
    func: async ({ content, title, tags }) => {
      const note = await createFn(content, title, tags);
      return `Note created successfully! ID: ${note.id}, Title: "${note.title}"`;
    }
  });
}

/**
 * Create branch tool
 * Allows agent to create conversation branches
 */
export function createBranchTool(
  branchFn: (intent: string) => Promise<{ id: string; intent: string }>
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'create_branch',
    description: 'Create a new conversation branch to work on a specific task or topic without cluttering the main conversation.',
    schema: z.object({
      intent: z.string().describe('The purpose or goal of this branch (e.g., "Create landing page design")')
    }),
    func: async ({ intent }) => {
      const branch = await branchFn(intent);
      return `Branch created! ID: ${branch.id}, Intent: "${branch.intent}"`;
    }
  });
}

/**
 * Merge branch tool
 * Allows agent to merge a branch back to main
 */
export function createMergeBranchTool(
  mergeFn: (branchId: string) => Promise<{ summary: string; facts: string[] }>
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'merge_branch',
    description: 'Merge a conversation branch back to the main thread. This will summarize the branch work and extract key learnings.',
    schema: z.object({
      branchId: z.string().describe('The branch ID to merge')
    }),
    func: async ({ branchId }) => {
      const result = await mergeFn(branchId);
      return `Branch merged successfully!\n\nSummary: ${result.summary}\n\nFacts extracted: ${result.facts.length}`;
    }
  });
}

