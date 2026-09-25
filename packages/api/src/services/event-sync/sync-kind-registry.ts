/**
 * Sync-kind registry — how a provider declares WHICH Synap kinds its connection
 * mirrors, and the one read helper every kind uses.
 *
 * A kind handler owns exactly three things: its provider READ (one page through a
 * capability verb — the one execution door + gate), its PURE mapper (page →
 * sync graph), and optionally its kind-specific dedup policy. Everything else —
 * leases, cursors, bounds, first-run vs steady, proposal vs upsert, progress —
 * belongs to the runner (`connection-sync.ts`), so a new kind is a handler +
 * mapper and never a second runner.
 *
 * Kept separate from the runner so handler modules can register at load time
 * without an import cycle through the runner.
 */

import {
  executeCapability,
  type ExecuteCapabilityResult,
} from "../capabilities/execute-capability.js";
import type { CapabilityNextAction } from "../capabilities/capability-enable-link.js";
import {
  capErrorMessage,
  isConnectionAuthError,
} from "../connection-health/notify-connector-unhealthy.js";
import {
  isFailureErrorClass,
  type FailureErrorClass,
} from "@synap-core/types/failures";
import type { SyncGraph, SyncGraphEntity } from "./sync-graph.js";

export type SyncPhase =
  | "fetching"
  | "mapping"
  | "review_ready"
  | "synced"
  | "failed"
  /** Sync is on but no live connection backs it — a state to connect, not a failure. */
  | "not_connected";

/** Entities per profile slug — what a run FOUND, not what it read. */
export type SyncProfileCounts = Record<
  string,
  { created: number; merged: number }
>;

export type SyncCounts = {
  fetched: number;
  created: number;
  merged: number;
  skipped: number;
  /** Absent on state written before it existed. */
  byProfile?: SyncProfileCounts;
};

/** Template default ⊕ stored override for one kind. */
export interface ResolvedKindSyncConfig {
  enabled: boolean;
  /** First-run lookback (and steady look-ahead for dated kinds). */
  windowDays: number;
  /** Max records read per run. */
  itemLimit: number;
  /** Sub-sources (calendar ids for `event`); empty = the provider default. */
  sources: string[];
}

export interface SyncKindContext {
  provider: string;
  kind: string;
  /** The connection's owner — the human the sync reads and writes as. */
  owner: string;
  /** Effective workspace lens of the connection's tool row (null = pod-wide). */
  workspaceId: string | null;
  /** The `secrets` connection row id. */
  connectionId: string;
  kindConfig: ResolvedKindSyncConfig;
  toolId: string;
  toolMetadata: Record<string, unknown>;
}

export interface SyncFetchRequest {
  /** `initial` = bounded first run; `steady` = changes since `since`. */
  mode: "initial" | "steady";
  /** ISO watermark of the last completed run (steady only). */
  since: string | null;
  /** now − windowDays / now + windowDays, ISO. */
  windowStart: string;
  windowEnd: string;
  /** Opaque handler token from the previous page; null = first page. */
  pageToken: string | null;
  /** Records still allowed this run (the handler clamps to its verb's max). */
  pageSize: number;
}

export interface SyncFetchPage {
  items: unknown[];
  nextPageToken: string | null;
}

export interface SyncKindHandler {
  /** External provider, e.g. `"google"`. */
  provider: string;
  /** Sync kind key (the `metadata.sync.kinds.<kind>` key), e.g. `"event"`. */
  kind: string;
  /** Template-default params; the stored override merges over them per field. */
  defaults: ResolvedKindSyncConfig;
  /** Every profile slug this kind's mapper writes. */
  profileSlugs: string[];
  /**
   * The subset whose entities carry a source-app url on their external link
   * (what "open where it lives" can actually open). Never guessed.
   */
  openableProfileSlugs: string[];
  fetchPage(
    ctx: SyncKindContext,
    req: SyncFetchRequest
  ): Promise<SyncFetchPage>;
  /** Pure: page items → graph. `skipped` = items that mapped to nothing. */
  mapItems(items: unknown[]): { graph: SyncGraph; skipped: number };
  /**
   * Kind-specific cross-source dedup, consulted when no external link exists
   * yet. Return an existing entity id, or null when this entity is not the
   * handler's kind or nothing matches.
   */
  findExisting?(
    entity: SyncGraphEntity,
    ctx: SyncKindContext
  ): Promise<string | null>;
  /**
   * Refresh volatile properties on an already-existing entity (an event's
   * times). Return true when something was written.
   */
  refreshExisting?(entityId: string, entity: SyncGraphEntity): Promise<boolean>;
}

const REGISTRY: SyncKindHandler[] = [];

/**
 * Register a provider's sync kind. Idempotent per (provider, kind) so a
 * re-import (dev HMR / repeated boot) replaces rather than duplicates.
 */
export function registerSyncKind(handler: SyncKindHandler): void {
  const idx = REGISTRY.findIndex(
    (h) => h.provider === handler.provider && h.kind === handler.kind
  );
  if (idx >= 0) REGISTRY[idx] = handler;
  else REGISTRY.push(handler);
}

export function getSyncKinds(provider: string): SyncKindHandler[] {
  return REGISTRY.filter((h) => h.provider === provider);
}

export function getSyncProviders(): string[] {
  return [...new Set(REGISTRY.map((h) => h.provider))];
}

/**
 * WHY a sync kind failed, in the pod's ONE failure vocabulary
 * (`@synap-core/types/failures`) — plus, when the capability layer knew it, the
 * place the fix is performed. This is what lets a client say "Turn on Google"
 * instead of "Try again" for a failure no retry can clear: the executor already
 * returns both, and the sync used to flatten them into a bare string.
 */
export interface SyncFailure {
  errorClass: FailureErrorClass;
  next?: CapabilityNextAction;
  /**
   * The pack-enable request filed on the owner's behalf for a `permission`
   * failure — what the owner approves to fix it (one open per pack). Absent
   * when none could be filed; the `next` link still says where to enable.
   */
  enableProposalId?: string;
}

/** A provider read that did not produce data — carries the verb for the report. */
export class SyncReadError extends Error {
  constructor(
    message: string,
    readonly verbId: string,
    readonly failure: SyncFailure = { errorClass: "unknown" }
  ) {
    super(message);
    this.name = "SyncReadError";
  }
}

/**
 * Classify a capability outcome that did not produce data. Structure first —
 * the executor's own `errorClass` and next-action — and the message regex only
 * where the executor had nothing to say.
 *
 *   deny      → `permission`: the gate refused the verb (today: its pack is
 *               installed but not approved). Carries the `enable` link.
 *   not_found → `target_missing`: no such verb on THIS connection's tool.
 *   error     → the executor's `errorClass`, with its `connect` block.
 *   run with a failed envelope → the envelope's class, else `provider`.
 */
export function classifySyncRead(cap: ExecuteCapabilityResult): SyncFailure {
  if (cap.kind === "deny") {
    const offer = cap.enableProposal;
    return {
      errorClass: "permission",
      ...(cap.enable ? { next: cap.enable } : {}),
      ...(offer?.status === "proposed"
        ? { enableProposalId: offer.proposalId }
        : {}),
    };
  }
  if (cap.kind === "not_found") return { errorClass: "target_missing" };
  if (cap.kind === "error") {
    return {
      errorClass:
        cap.errorClass ??
        (isConnectionAuthError(cap.message) ? "auth" : "unknown"),
      ...(cap.enable ? { next: cap.enable } : {}),
    };
  }
  const env = (cap.kind === "run" ? cap.result : undefined) as
    { errorClass?: unknown; error?: unknown } | undefined;
  if (env && isFailureErrorClass(env.errorClass)) {
    return { errorClass: env.errorClass };
  }
  const message = typeof env?.error === "string" ? env.error : undefined;
  return { errorClass: isConnectionAuthError(message) ? "auth" : "provider" };
}

/**
 * Run ONE read verb as the connection owner, pinned to the connection, and hand
 * back its shaped result. Anything that is not a successful run THROWS — an
 * unapproved verb, a dead connection and a provider error must never read as
 * "this page was empty".
 */
export async function readVerbPage(
  ctx: SyncKindContext,
  verbId: string,
  parameters: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const cap = await executeCapability({
    verbId,
    parameters,
    userId: ctx.owner,
    workspaceId: ctx.workspaceId,
    connectionSelector: { connectionId: ctx.connectionId },
    // Resolve the verb through THIS connection's tool, never by bare name: a
    // stale same-named skill tied to an older tool (a pre-consolidation code
    // skill) would otherwise win the name lookup and refuse the selector above.
    toolId: ctx.toolId,
    // A mirror has no one to ask, so a not-enabled pack files ONE enable
    // request for the owner to approve (deduped per pack) instead of failing
    // every tick with nothing in the review queue.
    requestEnableForOwner: true,
    // A scheduled mirror has no review surface: an unapproved verb must come
    // back as a refusal, never as a new proposal row per tick.
    suppressProposal: true,
    // One call per page per tick: keep the run event, never deposit the page
    // into recall as a fact.
    observability: "mirror",
  });
  const err = capErrorMessage(cap);
  if (err) throw new SyncReadError(err, verbId, classifySyncRead(cap));
  if (cap.kind !== "run") {
    // `dry-run` / `proposed`: suppressProposal should make these impossible;
    // if one arrives the verb is governed in a way a mirror cannot satisfy.
    throw new SyncReadError(`${verbId} did not run (${cap.kind})`, verbId, {
      errorClass: "permission",
    });
  }
  const result = cap.result;
  if (!result || typeof result !== "object") {
    throw new SyncReadError(`${verbId} returned no result`, verbId, {
      errorClass: "provider",
    });
  }
  return result as Record<string, unknown>;
}

/** The collection a verb's responseShape declares; absent = a shape mismatch, thrown. */
export function readCollection(
  result: Record<string, unknown>,
  field: string,
  verbId: string
): unknown[] {
  const items = result[field];
  if (!Array.isArray(items)) {
    throw new SyncReadError(
      `${verbId} returned no "${field}" collection`,
      verbId
    );
  }
  return items;
}

export function readNextPageToken(
  result: Record<string, unknown>
): string | null {
  const t = result.nextPageToken;
  return typeof t === "string" && t.length > 0 ? t : null;
}
