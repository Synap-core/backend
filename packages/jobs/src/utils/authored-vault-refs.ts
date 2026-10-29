/**
 * Resolve `vault://` references in an automation node's header values, but
 * ONLY the ones the node's author wrote literally.
 *
 * `resolveVaultReferences` turns a reference into the OWNER's plaintext secret,
 * and its contract is that it never runs on a value someone else controls. A
 * node's headers are templated from the run (`{{trigger.payload.token}}`): a
 * sender who sets that field to `vault://<id>` used to get the owner's secret
 * resolved into a request that goes to a URL the run also chose (pre-launch
 * audit 2026-10-28, governance F3). So the reference is honoured only when the
 * AUTHORED value is exactly the resolved one; a reference that came out of a
 * template is refused, loudly, rather than sent.
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

export async function resolveAuthoredVaultRefs(
  /** The node's values as authored, before template resolution. */
  authored: Record<string, unknown>,
  /** The same values after template resolution. */
  resolved: Record<string, string>,
  ownerId: string,
  where: string
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
  return { ...resolved, ...(await resolveVaultReferences(refs, ownerId)) };
}
