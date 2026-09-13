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
    "Connections mirror an external account into pod entities. OAuth tokens are held by the connection broker (the Synap Control Plane); the pod's connection sync reads through it. The first sync of a connection files ONE import proposal for review; later syncs follow the connection's keep-syncing rule.",
  supportedProviders: {
    google: {
      syncKinds: {
        event: "Calendar events → event, person, company",
        "email.thread": "Gmail correspondents → person, company",
        contact: "Google Contacts → person, company",
      },
      triggerEvent: "connector_sync.complete.completed",
    },
  },
  cliCommands: {
    "synap connect-service [service]":
      "Connect an external service; omit [service] to pick from connectable services.",
    "synap cap connect [name]":
      "Connect a service through its capability; omit [name] to pick from connectable services.",
    "synap cap disconnect <name>":
      "Disconnect a capability's service (capability name or provider id).",
    "synap cap sync-status [provider]":
      "Sync status per provider × kind × connection (phase, counts, errors).",
    "synap sync status [provider]": "Alias of `synap cap sync-status`.",
    "synap tools connect <service>":
      "Connect a credential to a tool (OAuth via the connection broker, or vault).",
    "synap tools list": "List available tools and their connection status.",
    "synap tools sync <provider>":
      "Trigger a manual sync for a connected tool.",
    "synap tools disconnect <provider>": "Revoke a tool's connection.",
    "synap tools schema":
      "Fetch this schema (--json, or --write-context for AI context).",
  },
  hubRestEndpoints: {
    "GET /api/hub/connectors/providers":
      "List providers with connection status",
    "GET /api/hub/connectors/sync-status":
      "Sync status per provider × kind × connection (phase, counts, keepSyncing)",
    "POST /api/hub/connectors/connect": "Start connecting a provider",
    "POST /api/hub/connectors/session": "Get an OAuth connect session",
    "GET /api/hub/connectors/connections/:provider":
      "List the caller's connections for a provider",
    "DELETE /api/hub/connectors/connections/:connectionId":
      "Revoke a connection",
    "POST /api/hub/connectors/disconnect": "Revoke a connection",
    "POST /api/hub/connectors/tool-execute":
      "Run a connection tool verb (external read or write)",
  },
  automationIntegration: {
    description:
      "React to a finished connection sync. Emitted once per connection per run. Data: provider, connectionId, syncStatus ('success' | 'error'), kinds (phase per kind), counts, proposalIds. Writes a sync mirrors carry origin 'sync' and skip event automations unless the automation sets triggerConfig.includeSyncOrigin: true.",
    example:
      "trigger: event, eventPattern: connector_sync.complete.completed, filters: { provider: 'google', syncStatus: 'error' } → run automation when a Google sync fails",
  },
  aiUsage: {
    description: "The IS can propose connections by generating an OAuth URL",
    flow: [
      "1. IS calls GET /api/hub/connectors/providers to see what is connected",
      "2. IS calls POST /api/hub/connectors/session with providerId to get redirectUrl",
      "3. IS returns redirectUrl to user: 'Click to connect [service]: <url>'",
      "4. After OAuth, the pod's connection sync runs: the first sync files ONE import proposal for review, later syncs follow the connection's rule",
      "5. IS can now query the imported entities via MCP search tools",
    ],
  },
} as const;

connectorsSchemaRouter.get("/", authMiddleware, (c) =>
  c.json(CONNECTOR_SCHEMA)
);
