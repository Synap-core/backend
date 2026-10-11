/**
 * Computers — the person's roster (MACHINE-IDENTITY-PLAN W5, Connected ›
 * Computers). A computer is an agent user of type `machine` created by the
 * person who approved it (`created_by_user_id`); its agents point at it
 * (`users.host_user_id`). Nothing here mints or widens anything:
 *
 *   - `listMachines`      — the person's computers, each with its key's state
 *                           and the agents it hosts;
 *   - `renameMachine`     — the display name ("devbox");
 *   - `setMachineOwnKeyTtlDays` — the per-computer lifetime override
 *                           (`agentMetadata.keyTtlDays`, read by
 *                           `resolveMachineKeyTtlDays`); null = the pod default;
 *   - revoke goes through `revokeMachine` (machine-connect.ts), the one door.
 *
 * Rotation has no door here on purpose: a computer's new key can only reach
 * the computer through the device flow (`synap pods reconnect`), which offers
 * the same computer and replaces its key (`mintForApprovedRequest`).
 *
 * OWNERSHIP: every read and write is floored on `created_by_user_id = person`
 * — the loaded row's owner, never a request-supplied id alone.
 */

import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  inArray,
  isNull,
} from "@synap/database";
import {
  apiKeys,
  grants,
  users,
  type AgentMetadata,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE, agentDisplayName } from "@synap-core/types/agents";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  agentTypeName,
  MACHINE_KEY_TTL_MAX_DAYS,
  MACHINE_KEY_TTL_MIN_DAYS,
  resolveMachineKeyTtlDays,
} from "./machine-connect.js";

/**
 * A key due within this many days reads "expiring". Mirrors the CLI's
 * `COMPUTER_KEY_RENEW_DAYS` (synap-cli `lib/device-connect.ts`): the window in
 * which `synap login` renews a computer key on its own.
 */
export const MACHINE_KEY_RENEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a principal's newest key stands — ONE derivation, server-side. */
export type MachineKeyState =
  "active" | "expiring" | "expired" | "revoked" | "none";

interface KeyRow {
  id: string;
  userId: string;
  isActive: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export function machineKeyState(
  key: Pick<KeyRow, "isActive" | "expiresAt" | "revokedAt"> | null,
  now: number = Date.now()
): MachineKeyState {
  if (!key) return "none";
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && key.expiresAt.getTime() <= now) return "expired";
  if (!key.isActive) return "revoked";
  if (
    key.expiresAt &&
    key.expiresAt.getTime() - now < MACHINE_KEY_RENEW_DAYS * DAY_MS
  )
    return "expiring";
  return "active";
}

export interface MachineKeyView {
  id: string;
  state: MachineKeyState;
  expiresAt: Date | null;
}

export interface HostedAgentView {
  id: string;
  agentType: string | null;
  /** "Claude Code" */
  name: string;
  /** "Claude Code on devbox" — `agentDisplayName`, the one phrasing. */
  displayName: string;
  lastSeenAt: Date | null;
  key: MachineKeyView | null;
}

export interface MachineView {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  createdAt: Date;
  /** Newest `last_used_at` over the computer's own keys. */
  lastSeenAt: Date | null;
  /** The computer's newest key (the live one when there is one). */
  key: MachineKeyView | null;
  /** The computer's own lifetime override; null = the pod default. */
  keyTtlDays: number | null;
  /** What a key minted now would last (override → pod default → 90). */
  effectiveKeyTtlDays: number;
  minKeyTtlDays: number;
  maxKeyTtlDays: number;
  /** The live key's access, by the grant's name ("AI — read & propose"). */
  accessName: string | null;
  agents: HostedAgentView[];
}

/** The live key if any, else the newest. */
function pickKey(rows: KeyRow[], now: number): KeyRow | null {
  const sorted = [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
  return (
    sorted.find(
      (k) =>
        machineKeyState(k, now) === "active" ||
        machineKeyState(k, now) === "expiring"
    ) ??
    sorted[0] ??
    null
  );
}

function newest(dates: Array<Date | null>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

const keyView = (k: KeyRow | null, now: number): MachineKeyView | null =>
  k
    ? { id: k.id, state: machineKeyState(k, now), expiresAt: k.expiresAt }
    : null;

/** The person's computers, newest first, each with the agents it hosts. */
export async function listMachines(personId: string): Promise<MachineView[]> {
  const machines = await db
    .select({
      id: users.id,
      name: users.name,
      meta: users.agentMetadata,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        eq(users.agentType, MACHINE_AGENT_TYPE),
        eq(users.createdByUserId, personId)
      )
    )
    .orderBy(desc(users.createdAt));
  if (machines.length === 0) return [];

  const machineIds = machines.map((m) => m.id);
  const hosted = await db
    .select({
      id: users.id,
      name: users.name,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
    })
    .from(users)
    .where(inArray(users.hostUserId, machineIds));

  const principalIds = [...machineIds, ...hosted.map((a) => a.id)];
  const keys: KeyRow[] = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      isActive: apiKeys.isActive,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(inArray(apiKeys.userId, principalIds));
  const keysOf = (userId: string) => keys.filter((k) => k.userId === userId);

  const now = Date.now();
  const liveKeyIds = machines
    .map((m) => pickKey(keysOf(m.id), now))
    .filter((k): k is KeyRow => !!k && machineKeyState(k, now) !== "revoked")
    .map((k) => k.id);
  const grantRows = liveKeyIds.length
    ? await db
        .select({ apiKeyId: grants.apiKeyId, label: grants.label })
        .from(grants)
        .where(
          and(inArray(grants.apiKeyId, liveKeyIds), isNull(grants.revokedAt))
        )
    : [];

  return Promise.all(
    machines.map(async (m) => {
      const meta = (m.meta ?? {}) as AgentMetadata;
      const name =
        m.name?.trim() || meta.hostname || resolveMachineFallbackName();
      const own = keysOf(m.id);
      const key = pickKey(own, now);
      const labels = key
        ? grantRows
            .filter((g) => g.apiKeyId === key.id && g.label)
            .map((g) => g.label as string)
        : [];
      return {
        id: m.id,
        name,
        hostname: meta.hostname ?? null,
        platform: meta.platform ?? null,
        createdAt: m.createdAt,
        lastSeenAt: newest(own.map((k) => k.lastUsedAt)),
        key: keyView(key, now),
        keyTtlDays:
          typeof meta.keyTtlDays === "number" ? meta.keyTtlDays : null,
        effectiveKeyTtlDays: await resolveMachineKeyTtlDays(m.id),
        minKeyTtlDays: MACHINE_KEY_TTL_MIN_DAYS,
        maxKeyTtlDays: MACHINE_KEY_TTL_MAX_DAYS,
        accessName: labels.length > 0 ? [...new Set(labels)].join(", ") : null,
        agents: hosted
          .filter((a) => a.hostUserId === m.id)
          .map((a) => {
            const agentName =
              a.name?.trim() || (a.agentType ? agentTypeName(a.agentType) : "");
            const agentKeys = keysOf(a.id);
            return {
              id: a.id,
              agentType: a.agentType,
              name: agentName,
              displayName: agentDisplayName({
                name: agentName,
                hostName: name,
              }),
              lastSeenAt: newest(agentKeys.map((k) => k.lastUsedAt)),
              key: keyView(pickKey(agentKeys, now), now),
            };
          })
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      };
    })
  );
}

/** A computer row with no name and no hostname (never expected): its noun. */
function resolveMachineFallbackName(): string {
  return resolveObjectNoun("machine");
}

/**
 * Load a computer the person may manage: theirs (they approved it), or any
 * computer for a pod admin. NOT_FOUND otherwise — a stranger's computer is
 * indistinguishable from none.
 */
export async function loadManageableMachine(
  machineUserId: string,
  personId: string,
  isPodAdmin: boolean
): Promise<{
  id: string;
  name: string | null;
  createdByUserId: string | null;
}> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(
      and(eq(users.id, machineUserId), eq(users.agentType, MACHINE_AGENT_TYPE))
    )
    .limit(1);
  if (!row || (row.createdByUserId !== personId && !isPodAdmin))
    throw new TRPCError({ code: "NOT_FOUND", message: "Computer not found" });
  return row;
}

/** The display name ("devbox"). Agents follow it: their name is derived. */
export async function renameMachine(
  machineUserId: string,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A computer's name is 1 to 80 characters.",
    });
  await db
    .update(users)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(
      and(eq(users.id, machineUserId), eq(users.agentType, MACHINE_AGENT_TYPE))
    );
}

/**
 * The computer's own key lifetime (founder decision 4: overridable per
 * computer). `null` clears it — the computer then follows the pod default.
 * Applies to keys minted from now on; the live key keeps its expiry.
 */
export async function setMachineOwnKeyTtlDays(
  machineUserId: string,
  keyTtlDays: number | null
): Promise<void> {
  if (
    keyTtlDays !== null &&
    (!Number.isInteger(keyTtlDays) ||
      keyTtlDays < MACHINE_KEY_TTL_MIN_DAYS ||
      keyTtlDays > MACHINE_KEY_TTL_MAX_DAYS)
  )
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A computer key lasts between ${MACHINE_KEY_TTL_MIN_DAYS} and ${MACHINE_KEY_TTL_MAX_DAYS} days.`,
    });
  await db
    .update(users)
    .set({
      agentMetadata:
        keyTtlDays === null
          ? drizzleSql`coalesce(${users.agentMetadata}, '{}'::jsonb) - 'keyTtlDays'`
          : drizzleSql`coalesce(${users.agentMetadata}, '{}'::jsonb) || ${JSON.stringify(
              { keyTtlDays }
            )}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(users.id, machineUserId), eq(users.agentType, MACHINE_AGENT_TYPE))
    );
}
