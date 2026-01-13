/**
 * Inngest Client
 *
 * Proper lazy initialization: Only loads config when first accessed
 * Uses synchronous getter for compatibility with createFunction() at module load time
 */

import { Inngest } from "inngest";

// Lazy initialization - only create client when first accessed
let _inngest: Inngest | null = null;
let _config: { inngest: { eventKey?: string } } | null = null;

function getConfigSync(): { inngest: { eventKey?: string } } {
  if (_config) {
    return _config;
  }

  // Try to get config from globalThis (set by @synap-core/core when loaded)
  try {
    const coreModule = (globalThis as any).__synap_core_module;
    if (coreModule?.config) {
      _config = { inngest: { eventKey: coreModule.config.inngest.eventKey } };
      return _config;
    }
  } catch {
    // Not available via globalThis
  }

  // Fallback: Try to import synchronously (only works if already loaded)
  // This is a fallback - in practice, @synap-core/core should be imported first
  try {
    // In ESM, we can't use require, but we can check if module is in cache
    // For now, return undefined eventKey (works for development)
    _config = { inngest: { eventKey: undefined } };
    return _config;
  } catch {
    _config = { inngest: { eventKey: undefined } };
    return _config;
  }
}

function getInngest(): Inngest {
  if (!_inngest) {
    const config = getConfigSync();
    _inngest = new Inngest({
      id: "synap",
      name: "Synap Backend",
      eventKey: config.inngest.eventKey,
    });
  }
  return _inngest;
}

// Export as a Proxy for true lazy initialization
// This allows synchronous access while only initializing on first use
export const inngest = new Proxy({} as Inngest, {
  get(_target, prop) {
    const instance = getInngest();
    const value = (instance as unknown as Record<string, unknown>)[
      prop as string
    ];
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
}) as Inngest;

// Event types for type safety
export type Events = {
  "api/event.logged": {
    data: {
      id: string;
      type: string;
      data: Record<string, any>;
      timestamp: Date;
    };
  };
  "api/thought.captured": {
    data: {
      content: string;
      context: Record<string, any>;
      capturedAt: string;
      userId: string;
      inputType?: "text" | "voice" | "image";
    };
  };
  "ai/thought.analyzed": {
    data: {
      content: string;
      analysis: {
        title: string;
        tags: string[];
        intent: "note" | "task" | "event" | "idea";
        dueDate?: string;
        priority?: number;
      };
      context: Record<string, any>;
    };
  };
};
