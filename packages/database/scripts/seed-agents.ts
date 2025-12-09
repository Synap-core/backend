/**
 * Seed System Agents
 * 
 * Creates default system agents for the chat system.
 */

import { sql } from '../src/client-pg.js';


const systemAgents = [
  {
    id: 'orchestrator',
    name: 'Main Chat Orchestrator',
    description: 'Coordinates all user interactions and delegates to specialized agents',
    createdBy: 'system',
    userId: null,
    llmProvider: 'claude',
    llmModel: 'claude-3-7-sonnet-20250219',
    capabilities: [
      'intent_analysis',
      'entity_extraction',
      'branching_decision',
      'mem0_search',
      'conversation_management',
    ],
    systemPrompt: `You are the main AI assistant for a solo founder or small team building a startup.

Your responsibilities:
1. Understand user intent from natural language
2. Decide if task is simple (handle yourself) or complex (delegate to specialist)
3. Extract structured entities (tasks, contacts, meetings, ideas) from conversation
4. Create documents when user needs them
5. Coordinate specialist agents (research, code, financial)
6. Maintain context across the entire project lifecycle

Guidelines:
- Be proactive but not intrusive
- Suggest actions, don't execute without confirmation for important decisions
- Keep responses concise (2-4 sentences unless details are requested)
- Always extract entities (tasks, contacts, meetings, ideas) from conversation
- When creating branches, provide clear purpose and expected outcome
- Use memory (Mem0) to maintain long-term context about user preferences and project state`,
    toolsConfig: {
      tools: [
        { name: 'search_memory', type: 'mem0', description: 'Search long-term memory' },
        { name: 'vector_search', type: 'pgvector', description: 'Search documents and entities' },
        { name: 'extract_entities', type: 'llm_function', description: 'Extract structured data' },
        { name: 'create_branch', type: 'internal', description: 'Create conversation branch' },
        { name: 'create_document', type: 'internal', description: 'Create new document' },
      ],
    },
    executionMode: 'react',
    maxIterations: 5,
    timeoutSeconds: 30,
    weight: 1.0,
    active: true,
  },
  {
    id: 'research-agent',
    name: 'Research & Analysis Agent',
    description: 'Performs in-depth research and synthesizes findings',
    createdBy: 'system',
    userId: null,
    llmProvider: 'claude',
    llmModel: 'claude-3-7-sonnet-20250219',
    capabilities: [
      'vector_search',
      'synthesis',
      'mem0_search',
      'document_creation',
    ],
    systemPrompt: `You are a research analyst specializing in startup and business research.

Your job:
1. Take a research question or topic
2. Search internal knowledge (vector search across documents and memory)
3. Synthesize findings into clear, actionable summaries
4. Create well-structured research documents

Guidelines:
- Be thorough but concise
- Structure findings clearly with headings
- Highlight key insights and actionable recommendations
- Always create a research document with your findings
- Use markdown formatting for clarity`,
    toolsConfig: {
      tools: [
        { name: 'vector_search', type: 'pgvector', description: 'Search internal documents' },
        { name: 'search_memory', type: 'mem0', description: 'Search long-term memory' },
        { name: 'create_document', type: 'internal', description: 'Create research document' },
      ],
    },
    executionMode: 'react',
    maxIterations: 10,
    timeoutSeconds: 60,
    weight: 1.0,
    active: true,
  },
];

async function seedAgents() {
  console.log('🌱 Seeding system agents...\n');
  
  try {
    for (const agent of systemAgents) {
      // Check if agent already exists
      const existing = await sql`
        SELECT id FROM agents WHERE id = ${agent.id}
      `;
      
      if (existing.length > 0) {
        console.log(`  ⏭️  Agent '${agent.id}' already exists`);
        continue;
      }
      
      // Insert agent
      await sql`
        INSERT INTO agents (
          id, name, description, created_by, user_id,
          llm_provider, llm_model, capabilities, system_prompt, tools_config,
          execution_mode, max_iterations, timeout_seconds, weight, active
        ) VALUES (
          ${agent.id},
          ${agent.name},
          ${agent.description},
          ${agent.createdBy},
          ${agent.userId},
          ${agent.llmProvider},
          ${agent.llmModel},
          ${agent.capabilities},
          ${agent.systemPrompt},
          ${JSON.stringify(agent.toolsConfig)},
          ${agent.executionMode},
          ${agent.maxIterations},
          ${agent.timeoutSeconds},
          ${agent.weight},
          ${agent.active}
        )
      `;
      
      console.log(`  ✅ Created agent '${agent.id}'`);
    }
    
    console.log('\n✅ System agents seeded successfully!\n');
  } catch (error) {
    console.error('❌ Error seeding agents:', error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

seedAgents();

