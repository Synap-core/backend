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
    // A person's key writes through Hub REST too — `synap app connect` with a
    // Personal key minted here was refused "Missing scope: hub-protocol.write"
    // (2026-10-20), and only the System type offered it. The key's GRANT still
    // bounds what it may change; this only lets it reach the write doors.
    // (mcp.* stay off: `/mcp` refuses a bare person key's writes.)
    "hub-protocol.write",
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
  return offeredKeyScopes(kind, scopeQuery.data?.scopes);
}

/** The pure half of `useOfferedKeyScopes`: curation ∩ the backend's list. */
export function offeredKeyScopes(
  kind: keyof typeof KEY_TYPE_SCOPES,
  backendScopes: readonly string[] | undefined
): readonly string[] {
  const curated = KEY_TYPE_SCOPES[kind];
  return backendScopes
    ? curated.filter((s) => backendScopes.includes(s))
    : curated;
}

/**
 * The lifetimes the key dialog offers, in days ("never" = no expiry). "1 day"
 * exists for a key made for one job — connecting an app from the CLI —
 * that should not outlive it.
 */
export const KEY_EXPIRY_OPTIONS = [
  { key: "never", label: "Never" },
  { key: "1", label: "1 day" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "1 year" },
] as const;
