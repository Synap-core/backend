/**
 * Facet ATTACHED — IoC slot (R1, 2026-10-12).
 *
 * `FacetRepository.attach()` is THE door every role attach goes through: the
 * facet router, capture's upsert, a connection sync's upsert, the role adapter
 * of `EntityRepository.create`, the proposal materializer, the entity merge,
 * the team-person bridge. So the automation fan-out of an attach
 * (`entity_facet.attach` — what a role's `created` activator fires on, e.g.
 * "Qualify a lead") is announced HERE, once per NEWLY attached row, instead of
 * by one router — which meant a lead that arrived by capture, sync or merge
 * started nothing.
 *
 * @synap/database cannot import @synap/events (events → database), so the
 * emit itself is injected at boot by @synap/api (`registerFacetAttachEmitter`,
 * `setup-event-broadcasting.ts`) — the same IoC pattern as
 * `registerCpProjectSyncTrigger`. Unregistered (scripts, backfills, tests)
 * it is a no-op: a backfill attaching a thousand roles must not start a
 * thousand processes.
 */
import { createLogger } from "@synap-core/core";
import type { EntityFacet } from "../schema/entity-facets.js";

const logger = createLogger({ module: "facet-attached-hook" });

/** What the caller knows that the facet row cannot carry. All optional. */
export interface FacetAttachContext {
  sessionId?: string | null;
  /**
   * `"sync"`: a bulk mirror. `"merge"`: a role MOVED onto the surviving entity
   * of a merge — not a new role. Event automations skip both unless a rule
   * opts in (`AUTOMATION_ORIGIN_OPT_INS`, the matcher); listeners still see it.
   */
  origin?: "sync" | "merge";
  /** The proposal that authorized the attach (origin derives from it). */
  proposalId?: string | null;
  /** Automation chain tracking (cycle guard) — opaque here. */
  automationContext?: unknown;
  entityTitle?: string | null;
  contextEntityTitle?: string | null;
  /**
   * Where the fan-out lands when the facet itself is pod-wide (the matcher
   * needs a workspace): the caller's governance lens.
   */
  fallbackWorkspaceId?: string | null;
  /**
   * ONE bulk run (an import, a capture graph apply) attaching many roles. It
   * rides the attach event as `data.batchId`, so a propose-mode activator
   * files ONE proposal for the whole batch instead of one per record.
   */
  batchId?: string | null;
}

export interface FacetAttachedEvent {
  facet: EntityFacet;
  /**
   * The role-profile's slug, resolved by the NOTIFIER on its own connection
   * (the door has the profile in hand). Required so the emitter never has to
   * look it up: the announcement can run INSIDE the caller's transaction (the
   * team-person bridge attaches under `pg_advisory_xact_lock`), and an awaited
   * read on another pool connection there deadlocks a single-session database
   * (PGlite / pglite-socket serves only the open transaction) — the fresh
   * desktop pod wedged at boot this way.
   */
  profileSlug: string;
  userId: string;
  context?: FacetAttachContext;
}

/**
 * Must not await any read outside the notifier's connection — everything it
 * needs rides the event (see `profileSlug`).
 */
type FacetAttachedEmitter = (event: FacetAttachedEvent) => void | Promise<void>;

let emitter: FacetAttachedEmitter | null = null;

/** Wired once at boot by @synap/api. Last registration wins. */
export function registerFacetAttachedEmitter(
  fn: FacetAttachedEmitter | null
): void {
  emitter = fn;
}

/**
 * Announce a newly attached facet. Never throws: the row is written, and a
 * failed announcement must not un-attach it.
 */
export async function notifyFacetAttached(
  event: FacetAttachedEvent
): Promise<void> {
  if (!emitter) return;
  try {
    await emitter(event);
  } catch (err) {
    // Logged, not thrown: the attach stands (its event-log row exists), but
    // no automation saw it — say so.
    logger.error(
      { err, facetId: event.facet.id, entityId: event.facet.entityId },
      "facet attach announcement failed — automations did not see this attach"
    );
  }
}
