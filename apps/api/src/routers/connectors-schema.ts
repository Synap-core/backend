/**
 * Connectors Schema REST router — serves a static reference document
 * describing supported providers, CLI commands, Hub REST endpoints,
 * automation integration, and AI usage patterns for the connector system.
 *
 * GET /api/hub/connectors/schema
 *   Returns the full connector schema (no DB queries — static document).
 */

import { Hono } from "hono";
import { authMiddleware } from "@synap/auth";

export const connectorsSchemaRouter = new Hono();

const CONNECTOR_SCHEMA = {
  overview:
    "Nango-powered connector sync. Connects external services → imports records as pod entities. Bidirectional via Hub REST /connectors/actions.",
  supportedProviders: {
    "google-calendar": {
      imports: ["event"],
      triggerEvent: "connector_sync.complete.completed",
    },
    "google-contacts": {
      imports: ["contact"],
      triggerEvent: "connector_sync.complete.completed",
    },
    "google-mail": {
      imports: ["note (emails)"],
      triggerEvent: "connector_sync.complete.completed",
    },
    github: {
      imports: ["repository", "task (issues)"],
      triggerEvent: "connector_sync.complete.completed",
    },
    notion: {
      imports: ["document (pages)"],
      triggerEvent: "connector_sync.complete.completed",
    },
    linear: {
      imports: ["task (issues)"],
      triggerEvent: "connector_sync.complete.completed",
    },
    slack: {
      imports: ["note (messages)"],
      triggerEvent: "connector_sync.complete.completed",
    },
    hubspot: {
      imports: ["contact", "task (deals)"],
      triggerEvent: "connector_sync.complete.completed",
    },
  },
  cliCommands: {
    "synap connect [service]":
      "Open OAuth flow to connect a service. Without [service] shows all available.",
    "synap connectors list":
      "List available providers and which are connected.",
    "synap connectors sync <provider>":
      "Trigger a manual sync for a connected provider.",
    "synap connectors disconnect <provider>": "Revoke a connection.",
    "synap connectors schema --write-context":
      "Write this schema to .claude/CONNECTOR_CONTEXT.md for AI context.",
  },
  hubRestEndpoints: {
    "GET /api/hub/connectors/providers":
      "List providers with connection status",
    "POST /api/hub/connectors/session":
      "Get OAuth URL. Body: { providerId?, workspaceId? }. Returns { redirectUrl, sessionToken }.",
    "DELETE /api/hub/connectors/connections/:connectionId":
      "Revoke a connection",
    "POST /api/hub/connectors/actions":
      "Trigger a Nango action (external write). Body: { connectionId, providerConfigKey, actionName, input? }",
  },
  automationIntegration: {
    description: "Use automation triggers to react to sync events",
    example:
      "trigger: event, eventPattern: connector_sync.complete.completed, filters: { provider: 'github' } → run automation when GitHub sync completes",
  },
  aiUsage: {
    description: "The IS can propose connections by generating an OAuth URL",
    flow: [
      "1. IS calls GET /api/hub/connectors/providers to see what is connected",
      "2. IS calls POST /api/hub/connectors/session with providerId to get redirectUrl",
      "3. IS returns redirectUrl to user: 'Click to connect [service]: <url>'",
      "4. After OAuth, Nango fires /api/connectors/nango-webhook → records import automatically",
      "5. IS can now query the imported entities via MCP search tools",
    ],
  },
} as const;

connectorsSchemaRouter.get("/", authMiddleware, (c) =>
  c.json(CONNECTOR_SCHEMA)
);
