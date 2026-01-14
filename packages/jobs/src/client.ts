/**
 * Inngest Client
 *
 * Properly configured to read from process.env with isDev support.
 * Works in development, test, and production environments.
 */

import { Inngest } from "inngest";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inngest-client" });

// Determine if we're in dev mode
const isDev = 
  process.env.INNGEST_DEV === "true" || 
  process.env.NODE_ENV === "test" ||
  process.env.NODE_ENV === "development";

// Create Inngest client with proper configuration
export const inngest = new Inngest({
  id: "synap",
  name: "Synap Backend",
  eventKey: process.env.INNGEST_EVENT_KEY,
  isDev,
  // In dev/test mode, connect to local dev server
  // In production, connects to Inngest Cloud
  ...(isDev && process.env.INNGEST_BASE_URL ? { baseUrl: process.env.INNGEST_BASE_URL } : {}),
});

// Log initialization
logger.info({
  isDev,
  hasEventKey: !!process.env.INNGEST_EVENT_KEY,
  baseUrl: isDev ? process.env.INNGEST_BASE_URL || "http://localhost:8288" : "cloud",
}, "Inngest client initialized");

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
