/**
 * "A process runs this agent" — the per-key stamp (computers plan v2 S3 step 1,
 * wave contract 3).
 *
 * `api_keys.last_used_at` is ANY use of a key, so an interactive conversation
 * on the agent's identity reads exactly like a worker that takes handed work.
 * The CLI worker says what it is on its own polls: `X-Synap-Runner:
 * synap-worker/<version>`. A request carrying it stamps `worker_served_at`
 * (and the version) on the key it authenticated with, and nothing else sets
 * it. Another runner value, or no header, changes nothing.
 *
 * The header is a client's claim, so it only ever writes to the calling key's
 * own row: a key can say "I am a runner", never "that key is".
 *
 * Throttled like `recordKeyUse`: at most one write per key per minute
 * (`PULL_LIVE_WINDOW_MS` is 15 minutes). Fire-and-forget: a failed stamp never
 * fails the request; the presence read then reads it older, never newer.
 */

import { createLogger } from "@synap-core/core";
import { apiKeys, db, eq } from "@synap/database";

const logger = createLogger({ module: "worker-served" });

/** The request header a process running an agent sends (lower-case, as read). */
export const RUNNER_HEADER = "x-synap-runner";

/** The runner value of the CLI worker (`synap worker`). */
export const WORKER_RUNNER = "synap-worker";

const STAMP_THROTTLE_MS = 60_000;
const lastStampAt = new Map<string, number>();

/**
 * The worker's version when `header` names the CLI worker
 * (`synap-worker/<version>`, or bare `synap-worker` → `null` version);
 * `undefined` for any other runner, or no header. A version that is not a
 * short plain token is dropped, never stored.
 */
export function workerRunnerVersion(
  header: string | null | undefined
): string | null | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const [runner, version, ...rest] = value.split("/");
  if (runner !== WORKER_RUNNER || rest.length > 0) return undefined;
  if (version === undefined) return null;
  return /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : null;
}

/**
 * Stamp `worker_served_at` on `keyId` when `header` names the CLI worker.
 * Resolves `true` when it wrote, `false` when there was nothing to write
 * (another runner, no header, or throttled). Never rejects.
 */
export async function recordWorkerServed(
  keyId: string | null | undefined,
  header: string | null | undefined,
  now: Date = new Date()
): Promise<boolean> {
  if (!keyId) return false;
  const version = workerRunnerVersion(header);
  if (version === undefined) return false;
  const at = now.getTime();
  if (at - (lastStampAt.get(keyId) ?? -Infinity) < STAMP_THROTTLE_MS) {
    return false;
  }
  lastStampAt.set(keyId, at);
  try {
    await db
      .update(apiKeys)
      .set({ workerServedAt: now, workerServedVersion: version })
      .where(eq(apiKeys.id, keyId));
    return true;
  } catch (err) {
    // Best-effort, like `recordKeyUse`: let the next poll try again.
    lastStampAt.delete(keyId);
    logger.warn({ err, keyId }, "worker-served stamp failed");
    return false;
  }
}
