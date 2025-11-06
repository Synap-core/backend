/**
 * Inngest Client
 */

import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'synap',
  name: 'Synap Backend',
  eventKey: process.env.INNGEST_EVENT_KEY,
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

