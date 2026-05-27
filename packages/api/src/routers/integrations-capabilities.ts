/**
 * Integrations Capabilities Endpoint
 *
 * Public endpoint describing what external services can integrate with on this pod.
 * No authentication required.
 */

import { Hono } from "hono";

const podUrl = process.env.POD_URL ?? "";

const CAPABILITIES_PAYLOAD = {
  patterns: [
    {
      id: "rest-api",
      name: "REST API",
      description:
        "Read and write entities, views, and data via tRPC REST endpoints.",
      authMethod: "api-key",
      requiredScopes: ["data.read"],
      optionalScopes: ["data.write"],
      endpoints: {
        base: `${podUrl}/trpc`,
        auth: "Authorization: Bearer {apiKey}",
      },
      docs: "Send tRPC-style POST requests to /trpc/{router}.{procedure}",
    },
    {
      id: "hub-protocol",
      name: "Hub Protocol (Agent)",
      description:
        "AI-native operations: memory, entities, proposals, channels. For agents and AI services.",
      authMethod: "api-key",
      requiredScopes: ["hub-protocol.read"],
      optionalScopes: ["hub-protocol.write"],
      endpoints: {
        base: `${podUrl}/api/hub`,
        auth: "Authorization: Bearer {apiKey}",
      },
      docs: "Full agent interaction surface. See /api/hub/openapi.json for schema.",
    },
    {
      id: "webhook-outbound",
      name: "Outbound Webhooks",
      description:
        "Subscribe your endpoint to receive real-time events from this pod.",
      authMethod: "hmac-sha256",
      signatureHeader: "x-synap-signature",
      endpoints: {
        subscribeVia: "pod-admin",
      },
    },
    {
      id: "webhook-inbound",
      name: "Inbound Webhooks",
      description: "Send events from your service into this pod.",
      authMethod: "api-key",
      requiredScopes: ["hub-protocol.write"],
      endpoints: {
        pattern: `${podUrl}/api/webhooks/inbound/{keyId}`,
      },
      docs: "POST JSON payload to the inbound URL. Include Authorization: Bearer {apiKey} header.",
    },
  ],
  eventTypes: [
    "entity.create.completed",
    "entity.update.completed",
    "entity.delete.completed",
    "proposal.created",
    "proposal.approved",
    "proposal.rejected",
    "channel.message.created",
    "notification.created",
    "workspace.member.added",
    "workspace.member.removed",
  ],
  webhookPayloadSchema: {
    type: "object",
    properties: {
      event: {
        type: "string",
        description: "Event type, e.g. entity.create.completed",
      },
      workspaceId: { type: "string" },
      payload: { type: "object", description: "Event-specific data" },
      timestamp: { type: "string", format: "date-time" },
    },
  },
};

export const integrationsCapabilitiesApp = new Hono();

integrationsCapabilitiesApp.get("/", (c) => {
  return c.json(CAPABILITIES_PAYLOAD);
});
