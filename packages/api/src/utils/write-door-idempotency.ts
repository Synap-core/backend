/**
 * Acknowledgment integrity for the single-write MCP doors (C1).
 *
 * THE BUG CLASS THIS CLOSES: a write LANDS on the server, but the CLIENT perceives
 * a failure (a dropped connection, a timeout, a torn response). The agent, seeing
 * "failure", RE-EMITS the same call — and a second row is written. Graph-capture
 * already closed this with a content-hash idempotency key
 * (`pending-capture-dedup.ts` `computeCaptureGraphIdempotencyKey`), and the
 * proposal SSOT hash-dedups identical AGENT proposals. But the single-write doors
 * (`post_message`, `remember_fact`, `create_document`, direct `run_capability`)
 * still duplicated on the AUTO-APPROVED / operator DIRECT-WRITE path — no proposal,
 * so no SSOT dedup — and no door told the caller "this was a replay, here's the
 * prior id" so it could stop retrying.
 *
 * This module is the shared half: (1) a canonical, order-independent content-hash
 * derivation — the SAME idiom as `computeCaptureGraphIdempotencyKey`, generalized
 * so every door folds every content field the same way; (2) the `WriteAckState`
 * contract each door stamps on its receipt so the client can tell `applied` from
 * `proposed` from `duplicate-ignored`. The STORAGE/lookup is per-door (each door
 * already has a queryable surface — the message row, the fact row, the document
 * row / proposal, all owner-floored) and lives in the door itself.
 *
 * TWO WRITES CAN'T COLLIDE: `computeWriteContentHash` folds every content-bearing
 * field through the recursive key-sort, so any difference in any field changes the
 * digest → a different key → a separate write. A byte-identical re-submit
 * reproduces the SAME key → the door's lookup returns the prior row instead of
 * writing again. The key is NEVER derived from a random id or a timestamp (a retry
 * would mint a new one → not idempotent) — that is the whole point.
 *
 * BEST-EFFORT: every door wraps its idempotency lookup so a lookup hiccup DEGRADES
 * to a normal write — it must never block a real write. Idempotency is orthogonal
 * to governance: a governed write still proposes; this is about the re-submit, not
 * about the approval.
 */

import { createHash } from "crypto";
import { stableStringify } from "./stable-stringify.js";

/**
 * The client-vs-server truth of a write, stamped on every single-write door's
 * receipt so a caller can distinguish a fresh write from an idempotent replay
 * WITHOUT diffing ids:
 *   - `applied`          — the write executed and materialized now.
 *   - `proposed`         — a governed write was queued for review (NOT a failure).
 *   - `duplicate-ignored`— an idempotent replay of a prior write; no second row.
 *                          The receipt still carries the prior id (same shape as a
 *                          first write) so the caller lands on the real record.
 */
export type WriteAckState = "applied" | "proposed" | "duplicate-ignored";

/**
 * The window a content-hash replay is honored within. A retry of a "failed" call
 * arrives within seconds; this bounds the lookup to recent writes so a
 * legitimately-repeated write much later (an agent genuinely posting the same line
 * again next week) is NOT collapsed into the old one. An EXPLICIT idempotencyKey
 * is honored the same way — the window is about the CONTENT-derived key, which is
 * the only case where "identical content" might be a real second intent.
 */
export const WRITE_IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The Date floor for a windowed idempotency lookup.
 *
 * ⚠ DO NOT bind the returned Date into a DB `WHERE` predicate on the pod:
 * postgres.js 3.4.8 CRASHES on Date bind params on the pod image (the same rule
 * the reapers document — `focus-session-reaper.ts`, `automation-run-reaper.ts`).
 * A crashing dedup lookup degrades (best-effort) to a normal write, which
 * silently DEFEATS idempotency. For the DB-side window predicate use
 * `idempotencyWindowSeconds()` inside a `drizzleSql\`… now() - (N * interval …)\``
 * fragment instead — computed in-DB, no Date param bound. This function is only
 * for non-DB use (tests, in-memory comparisons).
 */
export function idempotencyWindowStart(
  windowMs: number = WRITE_IDEMPOTENCY_WINDOW_MS
): Date {
  return new Date(Date.now() - windowMs);
}

/**
 * The window as a whole number of SECONDS, for building an in-DB cutoff without
 * binding a JS Date: `drizzleSql\`${col} >= now() - (${idempotencyWindowSeconds()}::int * interval '1 second')\``.
 * See the warning on `idempotencyWindowStart` for why the Date form must not
 * reach a pod query.
 */
export function idempotencyWindowSeconds(
  windowMs: number = WRITE_IDEMPOTENCY_WINDOW_MS
): number {
  return Math.max(1, Math.ceil(windowMs / 1000));
}

/**
 * Content-hash idempotency key for a single-write door. Deterministic over the
 * STABLE content of the write: the `door` discriminator (so two doors can never
 * share a key) plus every content-bearing field, canonically key-sorted so field
 * order never changes the digest. Undefined/empty fields are dropped so an absent
 * optional and an explicit empty string don't diverge.
 *
 * This is the generalized form of `computeCaptureGraphIdempotencyKey`'s idiom —
 * same recursive canonicalize, same "fold every content field" guarantee — so a
 * caller that omits an explicit key still gets a stable key that survives retries
 * and can't collide with a genuinely different payload.
 */
export function computeWriteContentHash(
  door: string,
  fields: Record<string, unknown>
): string {
  const stable: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.length === 0) continue;
    stable[k] = v;
  }
  // `stableStringify` recursively key-sorts, so field order never changes the
  // digest. Top-level `door` sorts before `fields`, matching the prior inline
  // canonicalize byte-for-byte — the deployed key is unchanged by this dedup.
  const payload = stableStringify({ door, fields: stable });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Resolve the effective idempotency key for a write: the caller's explicit key
 * when supplied (trimmed), else the derived content hash. Centralized so every
 * door resolves it identically.
 */
export function resolveWriteIdempotencyKey(
  explicit: string | undefined,
  door: string,
  fields: Record<string, unknown>
): string {
  const trimmed = typeof explicit === "string" ? explicit.trim() : "";
  return trimmed.length > 0 ? trimmed : computeWriteContentHash(door, fields);
}

/**
 * A stable UUID derived from an idempotency key. Used when a door keys idempotency
 * on the ROW PRIMARY KEY (no spare column to store the key): a retry with the same
 * key reproduces the same id, so an `INSERT … ON CONFLICT (id) DO NOTHING` collapses
 * to the prior row. Formats the first 16 bytes of `sha256(key)` as a UUID (version
 * nibble 8 = custom, RFC-4122 variant) — Postgres's `uuid` type accepts any valid
 * uuid string regardless of version, and the mapping is deterministic + collision-
 * resistant (full sha256 preimage). NEVER call this on a random/timestamp input.
 */
export function deterministicUuidFromKey(key: string): string {
  const h = createHash("sha256").update(key).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x80; // version 8 (custom)
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20, 32)}`;
}
