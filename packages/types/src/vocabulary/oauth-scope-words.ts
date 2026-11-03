/**
 * The OAuth scopes the pod's authorization server grants an MCP client
 * (`mcp.read`, `mcp.write`), in words the consent screen shows. Spelled here,
 * once, instead of in the screen (access model B wave, 2 Nov 2026).
 *
 * A consent screen that shows raw scope tokens is not consent: the person has
 * to be able to tell what they agree to. An unknown scope falls back to the
 * token itself, so an unlabelled scope is visible rather than silently
 * approved (never humanized into something that sounds harmless).
 *
 * Pure + dependency-free (the vocabulary contract).
 */

export const OAUTH_SCOPE_LABELS = {
  "mcp.read": "Read your entities, documents, and relations",
  "mcp.write":
    "Create and update things in your pod — every write still goes through your workspace's AI governance as a proposal you review",
} as const satisfies Readonly<Record<string, string>>;

/** A scope's words, or the raw token when the pod has none for it. */
export function resolveOAuthScopeLabel(scope: string): string {
  return Object.hasOwn(OAUTH_SCOPE_LABELS, scope)
    ? OAUTH_SCOPE_LABELS[scope as keyof typeof OAUTH_SCOPE_LABELS]
    : scope;
}
