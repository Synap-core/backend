/**
 * Workspace settings keys that belong to the SERVER, not to whoever edits the
 * workspace.
 *
 * `controlPlane` is written by the provisioning flow (its `podId`, `tier`) and
 * `nango` is the legacy plaintext connector credential. `workspaces.update`
 * REPLACES the settings blob and clients receive a projection with these keys
 * stripped — so a client round-trip would both erase them and, worse, let any
 * editor plant a `controlPlane.url` / `nango.host` of their choosing.
 * `workspaces.create` / `update` therefore never take them from the client:
 * they are stripped from the incoming blob and, on update, carried over from
 * the stored row.
 */

export const SERVER_OWNED_WORKSPACE_SETTINGS_KEYS = [
  "controlPlane",
  "nango",
] as const;

/** The client's settings with every server-owned key removed. */
export function stripServerOwnedSettings(
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...incoming };
  for (const key of SERVER_OWNED_WORKSPACE_SETTINGS_KEYS) delete out[key];
  return out;
}

/**
 * The settings to persist on an update: the client's blob minus server-owned
 * keys, plus the server-owned keys exactly as currently stored.
 */
export function preserveServerOwnedSettings(
  incoming: Record<string, unknown>,
  stored: unknown
): Record<string, unknown> {
  const out = stripServerOwnedSettings(incoming);
  const current = (stored ?? {}) as Record<string, unknown>;
  for (const key of SERVER_OWNED_WORKSPACE_SETTINGS_KEYS) {
    if (key in current) out[key] = current[key];
  }
  return out;
}
