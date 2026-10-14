/**
 * The ONE door onto `sync_peers.auth_token` — the shared token a sync peer
 * presents to us and that we present to it. Stored through the field-crypto
 * door (`field-crypto.ts`): an envelope bound to the peer row once
 * `SYNAP_FIELD_KEYS` is set, plaintext (today's format) until then.
 *
 * Shared by the api (peer writes, inbound auth, realtime push) and the jobs
 * workers (outbound push/pull), so the cell is named in one place.
 */

import { encryptField, resolveField } from "./field-crypto.js";

/** The value to store for a peer's token (the peer id is the AAD). */
export function sealSyncPeerToken(token: string, peerId: string): string {
  return encryptField(token, {
    column: "sync_peers.auth_token",
    rowId: peerId,
  });
}

/**
 * A peer's plaintext token, or `null` when it has none. Throws when a stored
 * token cannot be read (wrong key, value copied from another row, or
 * plaintext with SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT off) — a caller must not
 * talk to the peer without its credential.
 */
export function openSyncPeerToken(peer: {
  id: string;
  authToken: string | null;
}): string | null {
  if (peer.authToken == null) return null;
  return resolveField(peer.authToken, {
    column: "sync_peers.auth_token",
    rowId: peer.id,
  });
}
