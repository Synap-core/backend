import { defineSynapGenome } from './marketplaces/synap/types';

export default defineSynapGenome({
  project: {
    name: 'synap-backend-from-genome',
    description: 'Reference genome that reconstructs the Synap backend using marketplace modules.',
    structure: 'monorepo',
    monorepo: {
      tool: 'pnpm-workspaces',
      packages: {
        api: 'packages/api',
        core: 'packages/core',
        auth: 'packages/auth',
        ai: 'packages/ai',
        database: 'packages/database',
        domain: 'packages/domain',
        jobs: 'packages/jobs',
        storage: 'packages/storage',
      },
    },
  },
  modules: [
    { id: 'framework/hono' },

    // Core infrastructure capabilities
    { id: 'capabilities/database/postgres' },
    { id: 'capabilities/event-store' },
    { id: 'capabilities/storage/base' },
    { id: 'capabilities/storage/r2' },
    { id: 'capabilities/auth/base' },
    { id: 'capabilities/auth/better-auth' },

    // AI + domain foundations
    { id: 'capabilities/ai/langchain-core' },
    { id: 'capabilities/ai/embeddings' },
    { id: 'capabilities/domain/base' },
    { id: 'capabilities/vector-store/postgres' },

    // AI runtime extensions
    { id: 'capabilities/ai/chat-agent' },
    { id: 'capabilities/ai/provider/anthropic' },
    { id: 'capabilities/ai/runtime/vercel' },

    // Jobs
    { id: 'capabilities/jobs/base' },
    { id: 'capabilities/jobs/entity-embedding' },

    // API features
    { id: 'features/api/base' },
    { id: 'features/api/chat' },
    { id: 'features/api/capture' },
    { id: 'features/api/events' },
    { id: 'features/api/notes' },
    { id: 'features/api/suggestions' },
  ],
});
