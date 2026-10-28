/**
 * KEY USES — where a key is used, and the SCOPES that follows from it.
 *
 * A key has two layers in the data: its scopes say which DOOR it may enter
 * (Hub API, MCP, n8n, realtime…), its grant says what it may TOUCH there. The
 * person sets only the second one directly. The first is "Where it is used",
 * a list of uses in words (`resolveKeyUseLabel`), and the scopes are DERIVED:
 *
 *  - each use names a read scope and, for a door that writes, a write scope;
 *  - the write scope is added only when the grant holds a write (any create,
 *    update or delete, a gate verb, a bare subject, or `*`). A read-only
 *    grant never gets a write door;
 *  - `data.read` / `data.write` are never derived: they are MCP-only aliases,
 *    and offering them as "REST" made keys that could not reach Hub REST;
 *  - privileged scopes are never derived: they come only from their own
 *    flows (agent setup, a computer's "Runs scripts").
 *
 * The mint door derives them AGAIN server-side from `uses` (a client's scope
 * list is never trusted). Every scope the database knows is classified once,
 * either named by a use or listed in `KEY_SCOPES_NOT_DERIVED` with its reason;
 * the api tripwire `key-uses-scopes.tripwire.test.ts` pins that classification
 * to `API_KEY_SCOPES` (this package cannot import the database).
 *
 * Pure and dependency-free.
 */

import { isQualifiedGrantSubject } from "./catalog.js";
import { parsePermission } from "./grammar.js";

/** One door a key may be used on. */
export interface KeyUse {
  readonly id: string;
  /** The scope that lets the key read through this door. */
  readonly read: string;
  /** The scope that lets it write; absent = the door only reads. */
  readonly write?: string;
}

/** The uses a person picks from, in display order. */
export const KEY_USES = [
  { id: "hub", read: "hub-protocol.read", write: "hub-protocol.write" },
  { id: "mcp", read: "mcp.read", write: "mcp.write" },
  { id: "n8n", read: "read:entities", write: "write:entities" },
  // The n8n router's AI analysis (`n8n/actions.ts` analyzeContent): only when
  // asked, never folded into the plain n8n use.
  { id: "n8n-analyze", read: "ai:analyze" },
  { id: "realtime", read: "realtime:observe" },
  { id: "chat", read: "chat.stream" },
  { id: "skills", read: "skills.invoke" },
] as const satisfies readonly KeyUse[];

export type KeyUseId = (typeof KEY_USES)[number]["id"];

/** Every scope some use names, read and write. */
export const KEY_USE_SCOPES: readonly string[] = KEY_USES.flatMap(
  (u: KeyUse) => (u.write ? [u.read, u.write] : [u.read])
);

/**
 * The scopes no use derives, each with why. Together with KEY_USE_SCOPES this
 * classifies every scope a key can carry; a new scope is in neither until
 * someone decides which door it is.
 */
export const KEY_SCOPES_NOT_DERIVED: Readonly<Record<string, string>> = {
  "data.read":
    "An MCP-only alias of hub-protocol.read; Hub REST and tRPC never read it.",
  "data.write":
    "An MCP-only alias of hub-protocol.write; Hub REST and tRPC never read it.",
  "hub-protocol.admin":
    "Privileged at mint (PRIVILEGED_MINT_SCOPES); every door reads it as hub-protocol.write.",
  "providers.write":
    "Privileged: sets the address the pod sends every prompt to.",
  "setup.agent": "Privileged: mints further agents. Agent setup only.",
  "box.runner":
    "Privileged: a computer's own key leasing its person's scripts (Runs scripts).",
  probe: "Marks a dogfood probe key; declared by the probe flow, never chosen.",
};

export function isKeyUseId(id: string): id is KeyUseId {
  return KEY_USES.some((u) => u.id === id);
}

export function keyUse(id: string): KeyUse | undefined {
  return (KEY_USES as readonly KeyUse[]).find((u) => u.id === id);
}

/**
 * Does this pattern permit anything but a read? A bare subject (`entity`,
 * `entity.note`) covers create, update and delete; `*` covers everything; a
 * named gate verb (`proposal.approve`) is a write. A pattern that does not
 * parse permits nothing (the mint door refuses it anyway).
 */
export function permissionWrites(pattern: string): boolean {
  let segs: string[];
  try {
    segs = parsePermission(pattern);
  } catch {
    return false;
  }
  if (segs[0] === "*") return true;
  const action = segs[isQualifiedGrantSubject(segs[0]) ? 2 : 1];
  return action !== "read";
}

/** Does the grant hold any write? (see `permissionWrites`) */
export function grantHoldsWrite(permissions: readonly string[]): boolean {
  return permissions.some(permissionWrites);
}

export interface ScopesForKeyInput {
  readonly uses: readonly string[];
  /** The key's grant permissions: they decide whether write scopes are added. */
  readonly permissions: readonly string[];
}

/**
 * The scopes a key made for these uses carries, in KEY_USES order, no
 * duplicates. An unknown use id contributes nothing (`validateKeyUses`
 * reports it); an empty `uses` gives no scope at all.
 */
export function scopesForKey({
  uses,
  permissions,
}: ScopesForKeyInput): string[] {
  const writes = grantHoldsWrite(permissions);
  const out: string[] = [];
  for (const u of KEY_USES as readonly KeyUse[]) {
    if (!uses.includes(u.id)) continue;
    out.push(u.read);
    if (writes && u.write) out.push(u.write);
  }
  return out;
}

/** The use ids a list names that no KEY_USES row has. */
export function unknownKeyUses(uses: readonly string[]): string[] {
  return uses.filter((u) => !isKeyUseId(u));
}
