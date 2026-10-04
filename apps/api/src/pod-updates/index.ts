/**
 * Pod updates — the owner's auto-update SETTING (founder decision U3) and the
 * last update OUTCOME the host-side engine recorded (U4). Pure pieces + the
 * one file read; the Postgres read/write lives in `routers/pod-updates-deps.ts`.
 *
 * ONE TRUTH. The setting lives on the POD (`pod_settings.settings.updates`),
 * never in the Control Plane: the pod is the owner's, a self-hosted pod has no
 * CP at all, and the CP only ever READS it (through `GET /api/provision/status`,
 * which its health poll already calls) to decide whether to push a release.
 * The CP's `data_pods.update_policy` column is a mirror of this value, written
 * only by that poll.
 *
 * The engine itself (`synap update`) never decides WHEN to run — that is this
 * setting's job, through whichever caller runs it (the CP rolling update today,
 * a host-side timer later). A caller that runs it passes `--release <channel>`
 * explicitly from `channel` here; `SYNAP_UPDATE_CHANNEL` in deploy/.env stays
 * only the default for an operator typing a bare `synap update`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

// ── U3: the setting ──────────────────────────────────────────────────────────

export const UPDATE_CHANNELS = ["stable", "fast"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export interface PodUpdateSettings {
  /** Apply new releases automatically. Founder default (U3): ON. */
  auto: boolean;
  /** `stable` = tagged v* releases; `fast` = every green main push. */
  channel: UpdateChannel;
}

export const DEFAULT_POD_UPDATE_SETTINGS: Readonly<PodUpdateSettings> =
  Object.freeze({ auto: true, channel: "stable" });

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return (
    typeof value === "string" &&
    (UPDATE_CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * The effective setting from the raw `pod_settings.settings.updates` value.
 * `explicit` says whether the OWNER chose it (a stored, valid value) or it is
 * the default — the CP uses it to log when it overwrites a legacy CP-side
 * choice with a pod default. A malformed stored field falls back per field.
 */
export function resolvePodUpdateSettings(
  raw: unknown
): PodUpdateSettings & { explicit: boolean } {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hasAuto = typeof obj.auto === "boolean";
  const hasChannel = isUpdateChannel(obj.channel);
  return {
    auto: hasAuto ? (obj.auto as boolean) : DEFAULT_POD_UPDATE_SETTINGS.auto,
    channel: hasChannel
      ? (obj.channel as UpdateChannel)
      : DEFAULT_POD_UPDATE_SETTINGS.channel,
    explicit: hasAuto || hasChannel,
  };
}

/** Validates a PUT body: a partial `{ auto?, channel? }`, at least one field. */
export function parseUpdateSettingsPatch(
  body: unknown
): Partial<PodUpdateSettings> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const patch: Partial<PodUpdateSettings> = {};
  if (b.auto !== undefined) {
    if (typeof b.auto !== "boolean") return null;
    patch.auto = b.auto;
  }
  if (b.channel !== undefined) {
    if (!isUpdateChannel(b.channel)) return null;
    patch.channel = b.channel;
  }
  for (const key of Object.keys(b)) {
    if (key !== "auto" && key !== "channel") return null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// ── U4: the last outcome ─────────────────────────────────────────────────────

/**
 * Where the engine writes its outcome (`synap` `_ue_record`): deploy/state/
 * last-update.json on the host, mounted read-only into the backend at
 * /opt/synap/deploy (compose `backend.volumes`).
 */
export const LAST_UPDATE_PATH =
  process.env.SYNAP_LAST_UPDATE_PATH ||
  "/opt/synap/deploy/state/last-update.json";

/** Outcomes the owner must hear about: the update did not land. */
export const NOTIFY_UPDATE_STATUSES = [
  "rolled_back",
  "rollback_failed",
  "failed",
] as const;
export type NotifyUpdateStatus = (typeof NOTIFY_UPDATE_STATUSES)[number];

export function isNotifyUpdateStatus(s: string): s is NotifyUpdateStatus {
  return (NOTIFY_UPDATE_STATUSES as readonly string[]).includes(s);
}

/**
 * The METADATA of one engine outcome — what leaves the pod. Deliberately not
 * the raw record: `backup` (a host file path) and `pod` (already known) are
 * dropped, and `reason` is one of the engine's fixed strings, capped.
 */
export interface PodUpdateOutcome {
  /** Stable id: the record's own `id`, else a hash of (ts, from, to, status). */
  updateId: string;
  status: string;
  from: string | null;
  to: string | null;
  at: string | null;
  reason: string | null;
  dbRestored: boolean;
}

/**
 * `ok` = a record was read; `absent` = no update has ever been recorded here
 * (or the deploy dir is not mounted); `failed` = the file exists but could not
 * be read or parsed. `absent` and `failed` are different facts — a consumer
 * must never treat a failed read as "nothing happened".
 */
export type LastUpdateRead =
  | { read: "ok"; outcome: PodUpdateOutcome }
  | { read: "absent" }
  | { read: "failed"; error: string };

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

/** Projects a parsed record to its metadata. Null when it is not a record. */
export function projectUpdateOutcome(raw: unknown): PodUpdateOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = str(r.status, 40);
  if (!status) return null;
  const at = str(r.ts, 40);
  const from = str(r.from, 120);
  const to = str(r.to, 120);
  const updateId =
    str(r.id, 120) ??
    createHash("sha256")
      .update(`${at ?? ""}|${from ?? ""}|${to ?? ""}|${status}`)
      .digest("hex")
      .slice(0, 24);
  return {
    updateId,
    status,
    from,
    to,
    at,
    reason: str(r.reason, 200),
    dbRestored: r.dbRestored === true,
  };
}

export async function readLastUpdate(
  path: string = LAST_UPDATE_PATH,
  read: (p: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<LastUpdateRead> {
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") return { read: "absent" };
    return {
      read: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const outcome = projectUpdateOutcome(JSON.parse(text));
    return outcome
      ? { read: "ok", outcome }
      : { read: "failed", error: "last-update.json is not an update record" };
  } catch (err) {
    return {
      read: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── The status section the CP reads ──────────────────────────────────────────

export interface PodUpdatesStatus {
  /** null ⇔ the settings read FAILED (never folded into the default). */
  settings: (PodUpdateSettings & { explicit: boolean }) | null;
  settingsRead: "ok" | "failed";
  lastUpdate: LastUpdateRead;
}

/**
 * `updates` on `GET /api/provision/status`. Never throws: each half degrades to
 * its own failed state. Contains no secret — the setting and outcome metadata.
 */
export async function buildPodUpdatesStatus(deps: {
  readSettingsRaw: () => Promise<unknown>;
  readLastUpdate: () => Promise<LastUpdateRead>;
}): Promise<PodUpdatesStatus> {
  const [settingsResult, lastUpdate] = await Promise.all([
    deps.readSettingsRaw().then(
      (raw) => ({ ok: true as const, raw }),
      () => ({ ok: false as const })
    ),
    deps.readLastUpdate().catch(
      (err): LastUpdateRead => ({
        read: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
    ),
  ]);
  return {
    settings: settingsResult.ok
      ? resolvePodUpdateSettings(settingsResult.raw)
      : null,
    settingsRead: settingsResult.ok ? "ok" : "failed",
    lastUpdate,
  };
}
