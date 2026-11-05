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
 * The operator env `SYNAP_PRESENCE_PROOF=enforce` is a floor: it forces
 * `enforce` whatever the setting says, and can never force `report`.
 *
 * A failed read is NOT "report": it throws, and the approval or action that
 * asked fails with it.
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
import { events, podSettings } from "@synap/database/schema";

export type PresenceMode = "enforce" | "report";

export interface PresenceModeState {
  mode: PresenceMode;
  /** Where the mode comes from: the operator env floor, the pod setting, or the default. */
  source: "env" | "setting" | "default";
  changedBy: string | null;
  changedAt: string | null;
}

const CACHE_MS = 5_000;
/** The stored setting only; the env floor is applied on every read. */
let cached: { at: number; state: PresenceModeState } | null = null;

function envForcesEnforce(): boolean {
  return process.env.SYNAP_PRESENCE_PROOF?.trim() === "enforce";
}

/** Drop the cached setting (after a write, and in tests). */
export function invalidatePresenceMode(): void {
  cached = null;
}

async function readStoredMode(): Promise<PresenceModeState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  const [pod] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const stored = pod?.settings?.presence;
  const state: PresenceModeState = stored
    ? {
        mode: stored.mode === "enforce" ? "enforce" : "report",
        source: "setting",
        changedBy: stored.changedBy ?? null,
        changedAt: stored.changedAt ?? null,
      }
    : { mode: "report", source: "default", changedBy: null, changedAt: null };
  cached = { at: Date.now(), state };
  return state;
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
          { presence }
        )}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { presence } });
  }
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
