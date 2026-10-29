/**
 * THE ACCESS DOOR — one name for "may this principal read / write this target",
 * over the primitives that already answer it (plan-access A-2, wave A1):
 *
 *   - read a row    → the table's registered floor (`scopedDb`) under the
 *                     principal's key grant (`runWithGrant` → `grantReadPredicate`);
 *   - read a space  → a member (any role), its owner, or a pod-visible space,
 *                     and, under a grant, its event feed (`event.read` there);
 *   - join a room   → the read of what the room streams (`canRead(p, {room})`);
 *   - write         → `assertWorkspaceWrite` on the STORED row's workspace,
 *                     then the key grant (`grantWriteDenial`). Governance stays
 *                     in `checkPermissionOrPropose`;
 *   - write in a space → the same floor, as a boolean (`canWrite`).
 *
 * Exported as `@synap/api/access-door` and vendored into realtime by
 * `packages/realtime/scripts/bundle-document-access.mjs`, so every import here
 * must be a package realtime ships (`@synap/database`, `drizzle-orm`,
 * `@trpc/server`, `@synap/governance-policy`) or a relative file whose own
 * imports are. Key identity is a TYPE import only: its value pulls in the app
 * services.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  or,
  runWithGrant,
  channels,
  views,
  workspaceMembers,
  workspaces,
  type KeyGrant,
} from "@synap/database";
import { permits } from "@synap/governance-policy/grants";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { AccessContext, scopedDb } from "./index.js";
import type { ResolvedKeyIdentity } from "./key-identity.js";
import { podVisibleWorkspaceWhere } from "../utils/user-visible-where.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import {
  grantWriteDenial,
  type GrantWriteInput,
} from "../utils/grant-write-check.js";

/** Who is calling, as every access decision sees it. */
export interface Principal {
  /** The person whose data is in scope (a key's linked human, else its owner). */
  readonly userId: string;
  /** The acting agent's user, when an agent acts for `userId`. */
  readonly agentUserId?: string;
  /** What the calling key may touch; null = no key, nothing narrows. */
  readonly grant: KeyGrant | null;
  /** The calling API key, when there is one. */
  readonly key?: {
    /** The key's own user: the only `user:` room a key joins. */
    readonly userId: string;
    /** `api_keys.workspace_id`: the one space a bound key reaches; null = pod-wide. */
    readonly workspaceId: string | null;
  };
}

/** A person judged alone: no key, no grant. */
export function userPrincipal(userId: string): Principal {
  return { userId, grant: null };
}

/** An API-key caller, from the ONE key identity door (`resolveKeyIdentity`). */
export function principalFromKey(
  key: { userId: string; workspaceId: string | null },
  identity: ResolvedKeyIdentity
): Principal {
  return {
    userId: identity.effectiveUserId,
    agentUserId: identity.agentUserId,
    grant: identity.grant,
    key: { userId: key.userId, workspaceId: key.workspaceId },
  };
}

export type ReadTarget =
  | { table: { id: AnyPgColumn }; id: string }
  | { workspace: string }
  | { room: string };

/**
 * May `p` read `target`? A failed read throws: it is never "no".
 * A room it cannot parse, or of a prefix it does not know, is not readable.
 */
export async function canRead(
  p: Principal,
  target: ReadTarget
): Promise<boolean> {
  if ("table" in target) {
    return (await readRow(p, target.table, target.id)) !== null;
  }
  if ("workspace" in target) return readsWorkspace(p, target.workspace);
  return readsRoom(p, target.room);
}

/**
 * May `p` join the realtime room `roomId`? = `canRead(p, {room})`. A gate
 * that cannot decide (a failed read, e.g. a non-uuid id) denies.
 */
export async function canJoinRoom(
  p: Principal,
  roomId: string
): Promise<boolean> {
  try {
    return await canRead(p, { room: roomId });
  } catch (err) {
    console.error(`[access-door] room check failed: ${roomId}`, err);
    return false;
  }
}

/** A write `p` wants to make, judged on the row as it is STORED. */
export interface WriteTarget extends GrantWriteInput {
  /** The stored row's workspace (never the request's); null = pod-wide. */
  workspaceId: string | null;
  /** A pod-wide row's owner (`assertWorkspaceWrite`). */
  ownerId?: string | null;
}

/** Throws FORBIDDEN (UNAUTHORIZED without a user) unless `p` may write `target`. */
export async function assertCanWrite(
  p: Principal,
  target: WriteTarget
): Promise<void> {
  await assertWorkspaceWrite(db, p.userId, target);
  if (!keyReachesWorkspace(p, target.workspaceId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This key is bound to another workspace.",
    });
  }
  if (!p.grant) return;
  const denial = await grantWriteDenial(target, p.grant);
  if (denial) throw new TRPCError({ code: "FORBIDDEN", message: denial });
}

/**
 * May `p` write in the space `workspace`? The write floor
 * (`assertWorkspaceWrite`: an editor+ member, or its owner with no member row)
 * and the key's binding, as a boolean for a door's 403. What is written is
 * judged where the write is governed (`checkPermissionOrPropose`, the grant).
 * A refusal is false; a failed read throws, never "no".
 */
export async function canWrite(
  p: Principal,
  target: { workspace: string }
): Promise<boolean> {
  if (!keyReachesWorkspace(p, target.workspace)) return false;
  try {
    await assertWorkspaceWrite(db, p.userId, {
      workspaceId: target.workspace,
    });
    return true;
  } catch (err) {
    if (
      err instanceof TRPCError &&
      (err.code === "FORBIDDEN" || err.code === "UNAUTHORIZED")
    )
      return false;
    throw err;
  }
}

function contextOf(p: Principal): AccessContext {
  const access = p.agentUserId
    ? AccessContext.agent(p)
    : AccessContext.operator(p);
  // A bound key reads through its space's lens, as the Hub's bound-key fence.
  return p.key?.workspaceId ? access.withLens(p.key.workspaceId) : access;
}

/** The row through its registered floor and the key grant, or null. */
async function readRow(
  p: Principal,
  table: { id: AnyPgColumn },
  id: string
): Promise<{ id: string; workspaceId?: string | null } | null> {
  const columns: Record<string, boolean> = { id: true };
  if ("workspaceId" in table) columns.workspaceId = true;
  const rows = await runWithGrant(p.grant, () =>
    scopedDb(contextOf(p)).findMany<{
      id: string;
      workspaceId?: string | null;
    }>(table, { where: eq(table.id, id), columns, limit: 1 })
  );
  return rows[0] ?? null;
}

function keyReachesWorkspace(
  p: Principal,
  workspaceId: string | null | undefined
): boolean {
  return !p.key?.workspaceId || p.key.workspaceId === workspaceId;
}

async function readsWorkspace(
  p: Principal,
  workspaceId: string
): Promise<boolean> {
  if (!keyReachesWorkspace(p, workspaceId)) return false;
  if (
    p.grant &&
    !p.grant.scopes.some((scope) =>
      permits(scope, { subject: "event", action: "read", workspaceId })
    )
  ) {
    return false;
  }
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, p.userId)
    ),
    columns: { id: true },
  });
  if (member) return true;
  // Its owner reads it with no member row, as they write it
  // (`assertWorkspaceWrite`, Q-A1) and as `userVisibleWhere` reads its rows.
  const ownedOrPodReadable = await db.query.workspaces.findFirst({
    where: and(
      eq(workspaces.id, workspaceId),
      or(eq(workspaces.ownerId, p.userId), podVisibleWorkspaceWhere(p.userId))
    ),
    columns: { id: true },
  });
  return !!ownedOrPodReadable;
}

/**
 * A room is `<prefix>:<id>`, a live stream of its subject: it is read as one
 * read of that subject. `user:` carries the pod-wide events of one person, which
 * no grant can bound: a person joins their own, a key its own user's only. A
 * `channel:` / `view:` room of a bound key must live in the key's space: a
 * stream is judged on its subject's own workspace, so a pod-wide one is out.
 */
async function readsRoom(p: Principal, roomId: string): Promise<boolean> {
  const idx = roomId.indexOf(":");
  const prefix = idx > 0 ? roomId.slice(0, idx) : "";
  const id = idx > 0 ? roomId.slice(idx + 1) : "";
  if (!id) return false;
  switch (prefix) {
    case "user":
      return id === (p.key?.userId ?? p.userId);
    case "workspace":
      return readsWorkspace(p, id);
    case "channel":
    case "view": {
      const row = await readRow(p, prefix === "channel" ? channels : views, id);
      return row !== null && keyReachesWorkspace(p, row.workspaceId);
    }
    default:
      return false;
  }
}
