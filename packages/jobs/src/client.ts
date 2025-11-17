/**
 * Inngest Client
 */

import { Inngest } from 'inngest';

// Lazy load config to avoid circular dependencies
let _config: { inngest: { eventKey?: string } } | null = null;
let _configPromise: Promise<typeof import('@synap/core')['config']> | null = null;

async function loadConfig() {
  if (!_configPromise) {
    _configPromise = import('@synap/core').then((module) => {
      _config = { inngest: { eventKey: module.config.inngest.eventKey } };
      return module.config;
    });
  }
  return _configPromise;
}

function getConfig() {
  if (!_config) {
    throw new Error(
      'Config not loaded. Please ensure @synap/core is imported before using Inngest client.'
    );
  }
  return _config!;
}

// Pre-load config in the background
loadConfig().catch(() => {
  // Will be loaded on first access
});

export const inngest = new Inngest({
  id: 'synap',
  name: 'Synap Backend',
  eventKey: getConfig().inngest.eventKey,
});

// Event types for type safety
export type Events = {
  'api/event.logged': {
    data: {
      id: string;
      type: string;
      data: Record<string, any>;
      timestamp: Date;
    };
  };
  'api/thought.captured': {
    data: {
      content: string;
      context: Record<string, any>;
      capturedAt: string;
    };
  };
  'ai/thought.analyzed': {
    data: {
      content: string;
      analysis: {
        title: string;
        tags: string[];
        intent: 'note' | 'task' | 'event' | 'idea';
        dueDate?: string;
        priority?: number;
      };
      context: Record<string, any>;
    };
  };
};

