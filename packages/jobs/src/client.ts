/**
 * Inngest Client
 *
 * Properly configured to read from process.env with isDev support.
 * Works in development, test, and production environments.
 */

import { Inngest } from "inngest";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inngest-client" });

// Whether we're using a self-hosted Inngest server (inngest dev container)
// When self-hosted, isDev must be true because `inngest dev` does not sign
// its execution callbacks — signature verification only applies to Inngest Cloud.
// This does NOT affect NODE_ENV or any other application behavior.
const selfHosted = !!process.env.INNGEST_BASE_URL;

// isDev: true when self-hosted (inngest dev doesn't sign requests),
//        OR when running in local dev/test (no inngest server at all).
// isDev: false only when using Inngest Cloud (which signs all requests).
const isDev =
  selfHosted ||
  process.env.NODE_ENV === "test" ||
  process.env.NODE_ENV === "development";

// Create Inngest client with proper configuration
export const inngest = new Inngest({
  id: "synap",
  name: "Synap Backend",
  eventKey: process.env.INNGEST_EVENT_KEY,
  isDev,
  // Always use INNGEST_BASE_URL when set — points SDK at the self-hosted server
  ...(selfHosted ? { baseUrl: process.env.INNGEST_BASE_URL } : {}),
});

// Log initialization
logger.info(
  {
    isDev,
    selfHosted,
    hasEventKey: !!process.env.INNGEST_EVENT_KEY,
    baseUrl: selfHosted ? process.env.INNGEST_BASE_URL : "inngest-cloud",
  },
  "Inngest client initialized"
);

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
