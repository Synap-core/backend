/**
 * Resolve `vault://` references in an automation node's header values, but
 * ONLY the ones the node's author wrote literally, and ONLY toward the
 * destination the author wrote literally.
 *
 * `resolveVaultReferences` turns a reference into the OWNER's plaintext secret,
 * and its contract is that it never runs on a value someone else controls. Two
 * ways a run could steer a secret, both refused here, loudly, rather than sent:
 *
 * 1. The VALUE. A node's headers are templated from the run
 *    (`{{trigger.payload.token}}`): a sender who sets that field to
 *    `vault://<id>` used to get the owner's secret resolved into the request
 *    (pre-launch audit 2026-10-28, governance F3). So a reference is honoured
 *    only when the AUTHORED value is exactly the resolved one.
 * 2. The DESTINATION. The node's URL is templated from the run too
 *    (`https://{{trigger.payload.host}}/hook`): an authored
 *    `Authorization: vault://<id>` then went to whatever host the run named
 *    (finding f14cdea7). So when a secret rides, the URL's ORIGIN (scheme,
 *    host, port) must be fixed at authoring: the authored URL parses on its own
 *    and its origin equals the resolved URL's. A template in the path, query or
 *    fragment is fine; one anywhere in the origin fails closed. This is
 *    syntax-agnostic: a `{{…}}` left in the host either fails to parse or
 *    names a host that differs from the resolved one.
 *
 * Every step kind that resolves a vault reference for an outbound call goes
 * through this one function (`fetch` and `webhook` today), so both rules hold
 * for each of them; `destination` is required so a new caller cannot skip it.
 */
import { isVaultReference, resolveVaultReferences } from "./vault-resolver.js";

export class TemplatedVaultReferenceError extends Error {
  constructor(where: string, key: string) {
    super(
      `${where}: "${key}" became a vault:// reference through a template. ` +
        "Only a vault:// reference written in the node itself is resolved."
    );
    this.name = "TemplatedVaultReferenceError";
  }
}

export class TemplatedVaultDestinationError extends Error {
  constructor(where: string, reason: string) {
    super(
      `${where}: a vault:// secret is only sent to the URL as written in the node, ` +
        `and ${reason}. Write the scheme, host and port literally; templates ` +
        "may fill the path, query or fragment."
    );
    this.name = "TemplatedVaultDestinationError";
  }
}

/** The origin of a URL, or null when it does not parse as an absolute URL. */
function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Throws unless `resolvedUrl` goes to the origin written in `authoredUrl`.
 * Exported for the tests; callers go through {@link resolveAuthoredVaultRefs}.
 */
export function assertAuthoredDestination(
  authoredUrl: unknown,
  resolvedUrl: string,
  where: string
): void {
  if (typeof authoredUrl !== "string" || authoredUrl.length === 0) {
    throw new TemplatedVaultDestinationError(
      where,
      "the node has no written URL"
    );
  }
  const authored = originOf(authoredUrl);
  // "null" is the origin of an opaque URL (`data:`, `file:`): never a target.
  if (!authored || authored === "null") {
    throw new TemplatedVaultDestinationError(
      where,
      "its written URL has no fixed origin (is the host a template?)"
    );
  }
  const resolved = originOf(resolvedUrl);
  if (resolved !== authored) {
    throw new TemplatedVaultDestinationError(
      where,
      `the run sends it to ${resolved ?? "an invalid URL"} instead of ${authored}`
    );
  }
}

export async function resolveAuthoredVaultRefs(
  /** The node's values as authored, before template resolution. */
  authored: Record<string, unknown>,
  /** The same values after template resolution. */
  resolved: Record<string, string>,
  ownerId: string,
  where: string,
  /** The node's URL as authored and as it will be requested. */
  destination: { authoredUrl: unknown; resolvedUrl: string }
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (!isVaultReference(value)) continue;
    if (authored[key] !== value) {
      throw new TemplatedVaultReferenceError(where, key);
    }
    refs[key] = value;
  }
  if (Object.keys(refs).length === 0) return resolved;
  // Checked BEFORE the vault is read: a refused destination never sees the
  // plaintext, not even in memory.
  assertAuthoredDestination(
    destination.authoredUrl,
    destination.resolvedUrl,
    where
  );
  return { ...resolved, ...(await resolveVaultReferences(refs, ownerId)) };
}
