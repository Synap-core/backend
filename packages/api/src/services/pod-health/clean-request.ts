/**
 * The host action door, backend side: a pod admin asks the host to free room
 * (trim Docker's build cache, remove old release images) or to restart one
 * service. The backend never runs a host command: it writes ONE request file
 * that the host's `synap-clean.path` unit watches (lane p3a), the same
 * contract as the update and compose requests pod-agent writes
 * (`deploy/pod-agent/update-request.js`, `deploy/host-request.sh`):
 * `<name>.json` written as tmp + rename, 0600, one request at a time, and the
 * host's answer in a result file keyed by the request id.
 *
 * Every action here is reversible or regenerable (plan P3 firewall): a build
 * cache is rebuilt, old images are pulled again, a restarted service comes
 * back. Postgres is never restartable from here, and nothing deletes data,
 * backups, volumes or Redis keys. The host refuses anything outside its own
 * allowlist too; this list is the first fence, not the only one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

export const CLEAN_REQUEST_PATH =
  process.env.SYNAP_CLEAN_REQUEST_PATH ||
  "/opt/synap/deploy/state/requests/clean.json";

export const CLEAN_RESULT_PATH =
  process.env.SYNAP_CLEAN_RESULT_PATH ||
  "/opt/synap/deploy/state/clean-result.json";

export const HOST_ACTIONS = [
  "prune-build-cache",
  "prune-old-images",
  "restart-service",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];

/**
 * Services a pod admin may restart. Stateless or rebuildable ones only:
 * never postgres (and its backup job), redis, minio or kratos, whose restart
 * can lose in-flight writes or sign everyone out.
 */
export const RESTARTABLE_SERVICES = [
  "backend",
  "realtime",
  "pod-admin",
  "typesense",
  "browserless",
  "rsshub",
] as const;
export type RestartableService = (typeof RESTARTABLE_SERVICES)[number];

export function isRestartableService(s: unknown): s is RestartableService {
  return (
    typeof s === "string" &&
    (RESTARTABLE_SERVICES as readonly string[]).includes(s)
  );
}

export interface CleanRequest {
  id: string;
  action: HostAction;
  service?: RestartableService;
  requestedBy: string;
  requestedAt: string;
}

export interface CleanResult {
  id: string;
  action: HostAction;
  status: "done" | "refused" | "failed";
  detail: string | null;
  freedBytes: number | null;
  finishedAt: string | null;
}

/** What the page shows about host actions: one waiting, and the last answer. */
export interface HostActionsStatus {
  /** The request the host has not taken yet; null when none waits. */
  pending: Pick<
    CleanRequest,
    "id" | "action" | "service" | "requestedAt"
  > | null;
  /** The host's last answer: `absent` = none yet, `unreadable` ≠ none. */
  last:
    | { read: "ok"; result: CleanResult }
    | { read: "absent" }
    | { read: "unreadable" };
}

function isAction(v: unknown): v is HostAction {
  return (
    typeof v === "string" && (HOST_ACTIONS as readonly string[]).includes(v)
  );
}

function str(v: unknown, max = 300): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

export function parseCleanResult(raw: unknown): CleanResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 120);
  if (!id || !isAction(r.action)) return null;
  if (r.status !== "done" && r.status !== "refused" && r.status !== "failed")
    return null;
  const freed =
    typeof r.freedBytes === "number" &&
    Number.isFinite(r.freedBytes) &&
    r.freedBytes >= 0
      ? r.freedBytes
      : null;
  return {
    id,
    action: r.action,
    status: r.status,
    detail: str(r.detail),
    freedBytes: freed,
    finishedAt: str(r.finishedAt, 40),
  };
}

function parsePending(raw: unknown): HostActionsStatus["pending"] {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 120);
  if (!id || !isAction(r.action)) return null;
  return {
    id,
    action: r.action,
    ...(isRestartableService(r.service) ? { service: r.service } : {}),
    requestedAt: str(r.requestedAt, 40) ?? "",
  };
}

type Reader = (p: string) => Promise<string>;
const readText: Reader = (p) => readFile(p, "utf-8");

/** Never throws. A pending file that cannot be parsed reads as "one waits". */
export async function readHostActionsStatus(
  paths: { request: string; result: string } = {
    request: CLEAN_REQUEST_PATH,
    result: CLEAN_RESULT_PATH,
  },
  read: Reader = readText
): Promise<HostActionsStatus> {
  let pending: HostActionsStatus["pending"] = null;
  try {
    pending = parsePending(JSON.parse(await read(paths.request)));
  } catch {
    pending = null;
  }
  let last: HostActionsStatus["last"];
  try {
    const result = parseCleanResult(JSON.parse(await read(paths.result)));
    last = result ? { read: "ok", result } : { read: "unreadable" };
  } catch (err) {
    last =
      (err as { code?: unknown })?.code === "ENOENT"
        ? { read: "absent" }
        : { read: "unreadable" };
  }
  return { pending, last };
}

export type HostActionRefusal =
  /** Another request is still waiting for the host to take it. */
  | "busy"
  /** The service is not one this door may restart (postgres, an unknown…). */
  | "service_not_allowed"
  /** The request could not be written (deploy dir not writable, no host door). */
  | "unavailable";

export interface HostActionFs {
  exists(p: string): Promise<boolean>;
  mkdir(p: string): Promise<void>;
  write(p: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

const nodeFs: HostActionFs = {
  exists: async (p) => {
    try {
      await readFile(p);
      return true;
    } catch (err) {
      return (err as { code?: unknown })?.code !== "ENOENT";
    }
  },
  mkdir: async (p) => {
    await mkdir(p, { recursive: true, mode: 0o700 });
  },
  write: (p, text) => writeFile(p, text, { mode: 0o600 }),
  rename: (from, to) => rename(from, to),
  unlink: (p) => unlink(p),
};

/**
 * Writes one request. Returns it, or why it was refused. Never throws.
 * `restart-service` requires a service on the allowlist; the other two take
 * none (a stray `service` is dropped, not forwarded).
 */
export async function requestHostAction(
  input: { action: HostAction; service?: string; requestedBy: string },
  opts: {
    path?: string;
    fs?: HostActionFs;
    now?: Date;
    id?: string;
  } = {}
): Promise<
  { ok: true; request: CleanRequest } | { ok: false; reason: HostActionRefusal }
> {
  const path = opts.path ?? CLEAN_REQUEST_PATH;
  const fs = opts.fs ?? nodeFs;
  if (
    input.action === "restart-service" &&
    !isRestartableService(input.service)
  )
    return { ok: false, reason: "service_not_allowed" };
  const request: CleanRequest = {
    id: opts.id ?? randomUUID(),
    action: input.action,
    ...(input.action === "restart-service"
      ? { service: input.service as RestartableService }
      : {}),
    requestedBy: input.requestedBy,
    requestedAt: (opts.now ?? new Date()).toISOString(),
  };
  const tmp = join(dirname(path), `.${basename(path)}.${request.id}.tmp`);
  try {
    if (await fs.exists(path)) return { ok: false, reason: "busy" };
    await fs.mkdir(dirname(path));
    await fs.write(tmp, `${JSON.stringify(request)}\n`);
    await fs.rename(tmp, path);
    return { ok: true, request };
  } catch {
    await fs.unlink(tmp).catch(() => undefined);
    return { ok: false, reason: "unavailable" };
  }
}
