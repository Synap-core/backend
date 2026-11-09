/**
 * The pod's proof-of-presence mode (W3 slice 3, review bf96d410 Lane A).
 *
 * `report`: a sensitive approval or action with no proof applies, and the pod
 * records `presence.missing`. `enforce`: it is refused. The mode is a per-pod
 * setting (`pod_settings.settings.presence`), written only by
 * `presence.setMode`, and it only ratchets one way without a person: turning
 * it ON is free; turning it OFF needs a proof of presence (the router checks
 * it) and is recorded and announced to every pod admin (`mode-change.ts`).
 *
 * This module only reads and writes: the step-up middleware (trpc.ts) reaches
 * it through the gate, so it imports nothing beyond the database.
 *
 * A pod with NO stored setting runs `enforce` (founder, 5 Nov 2026, session
 * b064a220: "we put it by default, but let user changes"). An explicit
 * choice, in either direction, wins over that default; it is stored the
 * first time an admin moves the switch (or picks it at onboarding). A person
 * with no proof factor yet is not locked out: their first passkey and their
 * first Relay device key need no proof (`factors.ts`, the Kratos settings
 * guard), and the refusal says how to add one (`gate.ts`).
 *
 * The operator env `SYNAP_PRESENCE_PROOF=enforce` is a floor: it forces
 * `enforce` whatever the setting says, and can never force `report`.
 *
 * A failed read is NOT "report": it throws, and the approval or action that
 * asked fails with it.
 *
 * W5: the same row holds what asks for a passkey
 * (`pod_settings.settings.presenceSensitivity`, the rows a pod admin switched
 * off), read with the mode in one cached read and written only by
 * `presence.setSensitivity` (`sensitivity-change.ts`).
 */
import { randomUUID } from "node:crypto";
import {
  and,
  count,
  db,
  drizzleSql,
  eq,
  EventRepository,
  gt,
  sql,
} from "@synap/database";
import {
  events,
  podSettings,
  type PodSettingsBlob,
} from "@synap/database/schema";
import {
  normalizePresenceSensitivity,
  type PresenceSensitivityChoice,
} from "@synap-core/types/presence";

export type PresenceMode = "enforce" | "report";

export interface PresenceModeState {
  mode: PresenceMode;
  /** Where the mode comes from: the operator env floor, the pod setting, or the default. */
  source: "env" | "setting" | "default";
  changedBy: string | null;
  changedAt: string | null;
}

/** The mode of a pod whose admins never chose one. */
export const PRESENCE_MODE_DEFAULT: PresenceMode = "enforce";

/** The pod's choice of what asks for a passkey, and who last changed it. */
export interface PresenceSensitivityState extends PresenceSensitivityChoice {
  changedBy: string | null;
  changedAt: string | null;
}

interface StoredPresence {
  at: number;
  state: PresenceModeState;
  sensitivity: PresenceSensitivityState;
}

const CACHE_MS = 5_000;
/** The stored settings only; the env floor is applied on every read. */
let cached: StoredPresence | null = null;

function envForcesEnforce(): boolean {
  return process.env.SYNAP_PRESENCE_PROOF?.trim() === "enforce";
}

/** Drop the cached setting (after a write, and in tests). */
export function invalidatePresenceMode(): void {
  cached = null;
}

async function readStored(): Promise<StoredPresence> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached;
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const stored = pod?.settings?.presence;
  const state: PresenceModeState = stored
    ? {
        // Only an explicit `report` switches the check off: an unreadable
        // stored value fails closed.
        mode: stored.mode === "report" ? "report" : "enforce",
        source: "setting",
        changedBy: stored.changedBy ?? null,
        changedAt: stored.changedAt ?? null,
      }
    : {
        mode: PRESENCE_MODE_DEFAULT,
        source: "default",
        changedBy: null,
        changedAt: null,
      };
  const chosen = pod?.settings?.presenceSensitivity;
  const sensitivity: PresenceSensitivityState = {
    ...normalizePresenceSensitivity(chosen),
    changedBy: chosen?.changedBy ?? null,
    changedAt: chosen?.changedAt ?? null,
  };
  cached = { at: Date.now(), state, sensitivity };
  return cached;
}

async function readStoredMode(): Promise<PresenceModeState> {
  return (await readStored()).state;
}

/**
 * What asks for a passkey on this pod: the rows a pod admin switched off
 * (none by default). A failed read throws, like the mode's.
 */
export async function readPresenceSensitivity(): Promise<PresenceSensitivityState> {
  return (await readStored()).sensitivity;
}

/**
 * Store what asks for a passkey. The caller (`sensitivity-change.ts`) has
 * checked the pod admin and, when it switches a row off, the proof.
 */
export async function writePresenceSensitivity(input: {
  choice: PresenceSensitivityChoice;
  changedBy: string;
}): Promise<PresenceSensitivityState> {
  await mergePodSettings({
    presenceSensitivity: {
      ...normalizePresenceSensitivity(input.choice),
      changedBy: input.changedBy,
      changedAt: new Date().toISOString(),
    },
  });
  invalidatePresenceMode();
  return readPresenceSensitivity();
}

/** Merge `patch` into the singleton `pod_settings.settings` (creating the row). */
async function mergePodSettings(
  patch: Pick<PodSettingsBlob, "presence" | "presenceSensitivity">
): Promise<void> {
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify(
          patch
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: patch });
  }
}

/** The mode in force: the operator env floor, else the pod setting. */
export async function readPresenceMode(): Promise<PresenceModeState> {
  const stored = await readStoredMode();
  return envForcesEnforce()
    ? { ...stored, mode: "enforce", source: "env" }
    : stored;
}

/**
 * Store the mode. The caller has checked the pod admin and, for `report`, the
 * proof; this only stores and drops the cache.
 */
export async function writePresenceMode(input: {
  mode: PresenceMode;
  changedBy: string;
}): Promise<PresenceModeState> {
  const presence = {
    mode: input.mode,
    changedBy: input.changedBy,
    changedAt: new Date().toISOString(),
  };
  await mergePodSettings({ presence });
  invalidatePresenceMode();
  return readPresenceMode();
}

/**
 * What `enforce` would have refused in the last `days` days: the
 * `presence.missing` events, by what was missing a proof (an approval's
 * `targetType/proposalType`, a request kind, or an action path).
 */
export async function missingSince(days = 30): Promise<{
  total: number;
  byKind: Array<{ kind: string; count: number }>;
}> {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const kind = drizzleSql<string>`coalesce(${events.data}->>'proposalType', 'unknown')`;
  const rows = await db
    .select({ kind, n: count() })
    .from(events)
    .where(
      and(eq(events.type, "presence.missing"), gt(events.timestamp, since))
    )
    .groupBy(kind);
  const byKind = rows
    .map((r) => ({ kind: String(r.kind), count: Number(r.n) }))
    .sort((a, b) => b.count - a.count);
  return { total: byKind.reduce((n, r) => n + r.count, 0), byKind };
}

/** The audit event of a mode change (`presence.mode_changed`). */
export async function recordModeChange(args: {
  userId: string;
  from: PresenceMode;
  to: PresenceMode;
  proved: boolean;
}): Promise<void> {
  await new EventRepository(sql).append({
    id: randomUUID(),
    version: "v1",
    type: "presence.mode_changed",
    subjectType: "presence_mode",
    userId: args.userId,
    source: "api",
    timestamp: new Date(),
    data: { from: args.from, to: args.to, proved: args.proved },
  });
}
