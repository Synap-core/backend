import { trpc } from "../../../../lib/trpc";

/**
 * Per-key-type curation: which scopes to OFFER for each key type. This is a
 * presentation choice only — the backend (`apiKeys.availableScopes`, backed by
 * `API_KEY_SCOPES`) is the source of truth for which scopes are VALID, and the
 * dialog filters this list through it, so an entry the backend rejects is never
 * shown. Keep entries here to the backend's known scopes.
 */
const KEY_TYPE_SCOPES = {
  personal: [
    "data.read",
    "data.write",
    "hub-protocol.read",
    "setup.agent",
    "chat.stream",
    "realtime:observe",
  ],
  system: [
    "data.read",
    "data.write",
    "hub-protocol.read",
    "hub-protocol.write",
    "setup.agent",
    "chat.stream",
    "realtime:observe",
    "mcp.read",
    "mcp.write",
  ],
} as const;

/**
 * The scopes a key dialog offers for a key type. The backend is the source of
 * truth for which scopes are valid: the per-key-type curation (which subset to
 * OFFER) is filtered through its canonical list, so a scope the validator
 * doesn't accept can never be shown or selected — even if a local list drifts.
 */
export function useOfferedKeyScopes(
  kind: keyof typeof KEY_TYPE_SCOPES
): readonly string[] {
  const scopeQuery = trpc.apiKeys.availableScopes.useQuery(undefined, {
    staleTime: 300_000,
  });
  const backendScopes = scopeQuery.data?.scopes;
  const curated = KEY_TYPE_SCOPES[kind];
  return backendScopes
    ? curated.filter((s) => backendScopes.includes(s))
    : curated;
}
