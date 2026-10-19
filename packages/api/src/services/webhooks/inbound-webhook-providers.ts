/**
 * The token-in-path inbound webhook providers — ONE table, read by the mint
 * door (`provision-inbound-webhook.ts`) and pinned to the routes that read the
 * token (`routers/webhooks-inbound.ts`, `POST /api/webhooks/<provider>/:token`).
 *
 * Each route resolves its tool with
 * `resolveToolByWebhookToken(toolName, metadataKey, token)`, i.e. it looks for
 * a `tools` row named `toolName` whose `metadata[metadataKey].webhook.token`
 * equals the path segment. A row here says exactly that, nothing more, so the
 * door writes the token where the route reads it.
 *
 * Tripwire: `inbound-webhook-providers.tripwire.test.ts` derives the route set
 * by scanning the router (a new `/<x>/:token` route without a row here fails)
 * and mints through the door then hits every route with the minted token (a
 * row whose path disagrees with its route fails).
 *
 * `requiredConfig` names the keys the ROUTE also needs under
 * `metadata[metadataKey].webhook` before it accepts a delivery (a token alone
 * still answers 404). The door reports the ones missing; it never invents them.
 *
 * `setupStep` is the one manual step on the provider's side, when we have
 * checked it against the provider's own UI. Postiz: its public API has no
 * webhook endpoint (docs.postiz.com/public-api/openapi.json), so the person
 * pastes the URL in Settings → Webhooks (labels from gitroomhq/postiz-app
 * apps/frontend/src/components/webhooks/webhooks.tsx). The others are left
 * null until someone checks theirs.
 */
export interface InboundWebhookProviderSpec {
  /** `tools.name` of the row the route resolves. */
  toolName: string;
  /** `tools.metadata[metadataKey].webhook` holds the token. */
  metadataKey: string;
  /** Keys the route also requires under that `webhook` object. */
  requiredConfig: readonly string[];
  /** The manual step on the provider's side, or null when unchecked. */
  setupStep: string | null;
}

export const INBOUND_WEBHOOK_PROVIDERS = {
  calcom: {
    toolName: "cal_com",
    metadataKey: "calcom",
    requiredConfig: ["secretVaultRef"],
    setupStep: null,
  },
  fireflies: {
    toolName: "fireflies",
    metadataKey: "fireflies",
    requiredConfig: [],
    setupStep: null,
  },
  mailgun: {
    toolName: "mailgun",
    metadataKey: "mailgun",
    requiredConfig: ["secretVaultRef"],
    setupStep: null,
  },
  postiz: {
    toolName: "postiz",
    metadataKey: "postiz",
    requiredConfig: [],
    setupStep:
      "In Postiz, open Settings → Webhooks → Add a webhook, paste this URL, choose All integrations, and save.",
  },
} as const satisfies Record<string, InboundWebhookProviderSpec>;

/** The route path segment: `POST /api/webhooks/<provider>/:token`. */
export type InboundWebhookProvider = keyof typeof INBOUND_WEBHOOK_PROVIDERS;

/** The provider whose route resolves a tool of this name, or null. */
export function inboundWebhookProviderForTool(
  toolName: string
): InboundWebhookProvider | null {
  for (const [provider, spec] of Object.entries(INBOUND_WEBHOOK_PROVIDERS)) {
    if (spec.toolName === toolName) return provider as InboundWebhookProvider;
  }
  return null;
}
