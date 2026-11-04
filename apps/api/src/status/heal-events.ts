/**
 * The host self-heal's record, read by the backend (plan "Pod resilience" G7b).
 *
 * `synap heal` appends one `pod.heal` JSON line per act to
 * deploy/state/events.jsonl (`_synap_event`, also used by updates and units),
 * which the backend sees read-only at /opt/synap/deploy/state — the mount the
 * U4 reader uses for last-update.json (`pod-updates/index.ts`) and /health for
 * postgres-initialized (`podStateDir`, `pod-data-status.ts`).
 *
 * The file is append-only and nothing rotates it, so only its TAIL is read
 * (`HEAL_EVENTS_TAIL_BYTES`); a heal act older than that is old news anyway.
 * Each line is projected to the few fields the notice needs: a heal line
 * carries no secret (the host projects it), and this projection keeps it so.
 *
 * `absent` (no file: no host event yet, or the deploy dir is not mounted) and
 * `failed` (the file is there and could not be read) are different facts; a
 * malformed LINE is skipped and counted, never a reason to drop the others.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import type { PodHealEvent } from "@synap/api";
import { podStateDir } from "./pod-data-status.js";

export const HEAL_EVENTS_TAIL_BYTES = 256 * 1024;

export type HealEventsRead =
  | { read: "ok"; events: PodHealEvent[]; skipped: number }
  | { read: "absent" }
  | { read: "failed"; error: string };

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One parsed line → a heal event, or null when it is not one. Pure. */
export function projectHealEvent(raw: unknown): PodHealEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "pod.heal") return null;
  const ts = str(r.ts, 40);
  const status = str(r.status, 40);
  const service = str(r.service, 80);
  if (!ts || !status || !service) return null;
  const why =
    r.why && typeof r.why === "object"
      ? (r.why as Record<string, unknown>)
      : null;
  const ls =
    why?.lastStall && typeof why.lastStall === "object"
      ? (why.lastStall as Record<string, unknown>)
      : null;
  const requests: unknown[] = Array.isArray(ls?.requests)
    ? (ls?.requests as unknown[])
    : [];
  const first =
    requests[0] && typeof requests[0] === "object"
      ? (requests[0] as Record<string, unknown>)
      : null;
  const blockedMs = num(ls?.blockedMs);
  return {
    ts,
    status,
    service,
    restartsInWindow: num(r.restartsInWindow),
    class: str(why?.class, 20),
    waitedTicks: num(why?.waitedTicks),
    stall:
      blockedMs === null
        ? null
        : {
            blockedMs,
            method: str(first?.method, 10),
            path: str(first?.path, 200),
          },
  };
}

/** The `pod.heal` events of a chunk of events.jsonl (its first line may be cut). */
export function parseHealEvents(
  text: string,
  cutFirstLine: boolean
): { events: PodHealEvent[]; skipped: number } {
  const lines = text.split("\n");
  if (cutFirstLine) lines.shift();
  const events: PodHealEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.includes('"pod.heal"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const e = projectHealEvent(parsed);
    if (e) events.push(e);
    else skipped++;
  }
  return { events, skipped };
}

export async function readHealEvents(
  path: string = join(podStateDir(), "events.jsonl"),
  tailBytes: number = HEAL_EVENTS_TAIL_BYTES
): Promise<HealEventsRead> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, "r");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT")
      return { read: "absent" };
    return {
      read: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return { read: "ok", ...parseHealEvents(buf.toString("utf-8"), start > 0) };
  } catch (err) {
    return {
      read: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

export const HEAL_NOTICE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Read the heal events and hand them to `notify`, now and every
 * `intervalMs` (unref'd: never keeps the process alive). A heal restart of the
 * BACKEND is seen at the boot that follows; a restart of another service, or a
 * spent budget, at the next tick. A failed read is logged and notifies nobody.
 * Returns `stop`.
 */
export function startHealNoticeWatch(opts: {
  notify: (events: PodHealEvent[]) => Promise<unknown>;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  read?: () => Promise<HealEventsRead>;
  intervalMs?: number;
}): () => void {
  const read = opts.read ?? (() => readHealEvents());
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await read();
      if (r.read === "failed") {
        opts.warn({ error: r.error }, "Could not read the heal events");
      } else if (r.read === "ok" && r.events.length > 0) {
        await opts.notify(r.events);
      }
    } catch (err) {
      opts.warn({ err }, "Heal notices failed");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(
    () => void tick(),
    opts.intervalMs ?? HEAL_NOTICE_INTERVAL_MS
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
