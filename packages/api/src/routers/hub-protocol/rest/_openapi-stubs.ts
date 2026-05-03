/**
 * Hub Protocol REST — OpenAPI stub registrations.
 *
 * The "high-priority" route files (entities, threads, memory, knowledge) carry
 * full Zod schemas inline. Most other route files now do too — see the
 * per-resource files for `registerOpenApi(...)` calls.
 *
 * What remains here is intentionally narrow:
 *   - SSE / streaming endpoints (`/events/stream`) — the SSE response shape is
 *     not naturally expressed in OpenAPI.
 *   - Deprecated/auxiliary thread endpoints whose body shape is highly
 *     polymorphic.
 *   - A handful of bootstrap / sync routes (entity-share, setup, agents/sync)
 *     that use special auth (CP JWT, provisioning token) and are unlikely to be
 *     called by external developers.
 *
 * Future work: lift each remaining group into its per-resource file with
 * full request / response schemas as they stabilize.
 */

import { registerStub } from "./_codecs/_register.js";
import type { HubHono } from "./_shared.js";

export function registerOpenApiStubs(app: HubHono): void {
  // ── Events (SSE stream) ────────────────────────────────────────────────
  registerStub(app, {
    method: "get",
    path: "/events/stream",
    tags: ["Events"],
    summary: "SSE stream of new events",
    description:
      "Long-lived Server-Sent Events stream. Emits `event` and `heartbeat` frames. Consumers must dedupe by event id (at-least-once across catch-up).",
  });

  // ── Threads (auxiliary endpoints) ──────────────────────────────────────
  registerStub(app, {
    method: "get",
    path: "/threads/{threadId}/context",
    tags: ["Threads"],
    summary: "Get thread context (summary + linked entities/documents)",
  });
  registerStub(app, {
    method: "patch",
    path: "/threads/{threadId}/context",
    tags: ["Threads"],
    summary: "Update thread context summary",
  });
  registerStub(app, {
    method: "post",
    path: "/threads/{threadId}/link-entity",
    tags: ["Threads"],
    summary: "Link an entity to a thread",
  });
  registerStub(app, {
    method: "post",
    path: "/threads/{threadId}/link-document",
    tags: ["Threads"],
    summary: "Link a document to a thread",
  });

  // ── Entity share / Setup / Agents sync ────────────────────────────────
  registerStub(app, {
    method: "post",
    path: "/entity-share/deliver",
    tags: ["EntityShare"],
    summary: "Deliver shared entities (CP JWT auth)",
    secured: false,
  });
  registerStub(app, {
    method: "post",
    path: "/setup/agent",
    tags: ["Setup"],
    summary: "Provision a new agent user + API key",
    description: "Provisioning auth via PROVISIONING_TOKEN — not bearer.",
    secured: false,
  });
  registerStub(app, {
    method: "post",
    path: "/agents/sync",
    tags: ["Agents"],
    summary: "Sync agent registry from IS",
  });
}
