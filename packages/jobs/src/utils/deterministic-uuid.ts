/**
 * deterministicUuidV5 — a stable, RFC-4122 version-5 UUID derived from a fixed
 * namespace + a name string (SHA-1, version 5, RFC-4122 variant). The same
 * inputs always produce the same UUID, so it can serve as an IDEMPOTENCY KEY: a
 * side-effecting insert re-executed after a crash (pg-boss redelivers the job)
 * re-derives the SAME row id, and the insert conflicts on the primary key
 * (`onConflictDoNothing`) instead of duplicating the effect. No `uuid` package
 * is installed in this workspace, so we compute it from `crypto` directly.
 *
 * Used by the automation executor's output steps to make channel_message and
 * notification inserts exactly-once per (runId, nodeId, loop iteration).
 */

import { createHash } from "crypto";

/**
 * Fixed namespace UUID for Synap job-side deterministic ids. A constant, valid
 * v4 UUID (its exact value is irrelevant — it only has to be stable so the
 * derived ids never drift between runs/deploys).
 */
const SYNAP_JOBS_NAMESPACE = "b1f7c0de-5a3e-4c9b-9e2d-6f8a1c4b7d20";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Derive a deterministic v5 UUID from `name` under the Synap jobs namespace.
 * @param name The idempotency key string (e.g. `channel_message:<runId>:<nodeId>:<iter>`).
 */
export function deterministicUuidV5(
  name: string,
  namespace: string = SYNAP_JOBS_NAMESPACE
): string {
  const hash = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(name, "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  // Set the version (5) and RFC-4122 variant bits so the result is a valid UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
