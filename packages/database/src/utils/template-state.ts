/**
 * Template state — ONE reader and ONE writer for where a space stands with
 * its template (APPLY-ONE-DOOR-PLAN §2).
 *
 * The state lives in `settings.template`, one typed object. Before it, the
 * same facts were spread over eight settings keys (`packageVersion`,
 * `provisioningStatus`, `failedStep`, `failedStepError`, `completedSteps`,
 * `templateApply`, `installedPacks`, plus the `package_slug` /
 * `provisioning_status` columns), written by ~15 writers, four of them
 * read-modify-write. Every template bug on 10-12/10-13 came from that spread.
 *
 *   - `readTemplateState(settings)` — the ONE reader. Returns `settings.template`
 *     when present, else DERIVES it from the legacy keys with exactly the
 *     semantics the readers used before (a space no apply has touched since
 *     this module landed carries only those).
 *   - `writeTemplateState(db, workspaceId, patch)` — the ONE writer. Under a
 *     row lock (`SELECT … FOR UPDATE` in one transaction) it merges the patch
 *     onto the CURRENT state, writes `settings.template`, mirrors the legacy
 *     keys and keeps the two columns in sync — one UPDATE, no unlocked
 *     read-then-write, so two concurrent writers never lose each other's
 *     change (two pack upserts both survive).
 *
 * LEGACY MIRROR — removed in W6. The writer also writes the eight legacy keys,
 * derived from the merged state, so code the later waves have not migrated
 * (and the CLI / browser, which read `packageVersion` / `installedPacks`) keep
 * working. W6 folds them into `template` with one SQL migration and drops the
 * mirror and the legacy fallback of the reader.
 *
 * Tripwire: `packages/api/src/__tripwires__/template-apply-one-finisher.test.ts`
 * (3) — only this module writes `settings.template` or a mirrored key.
 */
import { eq, sql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import { workspaces, type WorkspaceSettings } from "../schema/workspaces.js";
import {
  assertWorkspaceIdentityFree,
  toWorkspaceIdentityError,
} from "./workspace-identity.js";

const logger = createLogger({ module: "template-state" });

/** Where the last template apply on a space stands. */
export type TemplateApplyStateName =
  /** Layer 1 is being built (legacy `provisioningStatus: "pending"`). */
  | "building"
  /** Built, nothing unfinished. The STAMP (`version`) says "converged". */
  | "active"
  /** Layer 2 only filed proposals (nothing failed). */
  | "awaiting-approval"
  /** A layer-2 item errored. */
  | "partial"
  /** This door ran layer 1 only; the living layers were never applied. */
  | "layer-2-not-run"
  /** An apply threw (`failedLayer` says which layer). */
  | "failed";

/** One overlay pack recorded on a space (legacy `installedPacks[]`). */
export interface TemplatePackEntry {
  slug: string;
  /** The pack version that CONVERGED; `null` = recorded, not yet earned. */
  version: string | null;
  installedAt: string;
}

export interface TemplateState {
  /**
   * The template identity (also the `package_slug` column). `null` for a space
   * built from a definition with no catalog identity, or one that only carries
   * packs — such a space still has a build state (and a resume ledger).
   */
  slug: string | null;
  /** The version stamp — written only on convergence. */
  version: string | null;
  state: TemplateApplyStateName;
  /**
   * The version an UNFINISHED apply (awaiting-approval · partial ·
   * layer-2-not-run) was converging to — never the stamp (legacy
   * `templateApply.version`).
   */
  pendingVersion?: string | null;
  failedLayer?: 1 | 2;
  failedStep?: string;
  error?: string;
  /** Layer-1 resume ledger. */
  completedSteps?: string[];
  proposals?: string[];
  failures?: string[];
  packs?: TemplatePackEntry[];
  /** When this state was last written ("" = unknown, a legacy record). */
  at: string;
}

/**
 * A change to the state. `undefined` = keep; `null` = clear. A `state` change
 * drops the fields that belong to other states (failure fields leave with
 * "failed", the unfinished record leaves with the unfinished states).
 */
export interface TemplateStatePatch {
  slug?: string | null;
  version?: string | null;
  state?: TemplateApplyStateName;
  pendingVersion?: string | null;
  failedLayer?: 1 | 2 | null;
  failedStep?: string | null;
  error?: string | null;
  completedSteps?: string[] | null;
  proposals?: string[] | null;
  failures?: string[] | null;
  packs?: TemplatePackEntry[] | null;
}

/** Promoted columns a reader can pass for a row whose settings lack the key. */
export interface TemplateStateColumns {
  packageSlug?: string | null;
  provisioningStatus?: string | null;
}

/** The failed step layer 2 (`applyPackagePostWorkspace`) records. */
export const LAYER_TWO_FAILED_STEP = "post-workspace";

const STATES: ReadonlySet<string> = new Set<TemplateApplyStateName>([
  "building",
  "active",
  "awaiting-approval",
  "partial",
  "layer-2-not-run",
  "failed",
]);
/** States in which the last apply did NOT earn its stamp. */
const UNFINISHED: ReadonlySet<TemplateApplyStateName> = new Set([
  "awaiting-approval",
  "partial",
  "layer-2-not-run",
  "failed",
]);
/** The legacy `templateApply.state` values (unfinished, not failed). */
const RECORDED: ReadonlySet<string> = new Set([
  "awaiting-approval",
  "partial",
  "layer-2-not-run",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : undefined;

function parsePacks(v: unknown): TemplatePackEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TemplatePackEntry[] = [];
  for (const e of v) {
    if (!isObject(e) || typeof e.slug !== "string" || !e.slug) continue;
    out.push({
      slug: e.slug,
      // Legacy wrote "" for "recorded without a version".
      version: str(e.version) ?? null,
      installedAt: typeof e.installedAt === "string" ? e.installedAt : "",
    });
  }
  return out;
}

/** A stored `settings.template`, read defensively (it is JSONB). */
function normalize(t: Record<string, unknown>): TemplateState {
  const state = STATES.has(t.state as string)
    ? (t.state as TemplateApplyStateName)
    : "active";
  const out: TemplateState = {
    slug: str(t.slug) ?? null,
    version: str(t.version) ?? null,
    state,
    at: typeof t.at === "string" ? t.at : "",
  };
  if (t.pendingVersion !== undefined)
    out.pendingVersion = str(t.pendingVersion) ?? null;
  if (t.failedLayer === 1 || t.failedLayer === 2)
    out.failedLayer = t.failedLayer;
  if (str(t.failedStep)) out.failedStep = str(t.failedStep);
  if (str(t.error)) out.error = str(t.error);
  const completed = strings(t.completedSteps);
  if (completed) out.completedSteps = completed;
  const proposals = strings(t.proposals);
  if (proposals) out.proposals = proposals;
  const failures = strings(t.failures);
  if (failures) out.failures = failures;
  const packs = parsePacks(t.packs);
  if (packs) out.packs = packs;
  return out;
}

/**
 * The state as the legacy keys say it — today's semantics, exactly:
 *   - `provisioningStatus: "failed"` → failed (it wins over any record);
 *     `failedStep: "post-workspace"` is a LAYER-2 failure, any other step
 *     (or none) a layer-1 one;
 *   - a `templateApply` record → its state (an unknown one → layer-2-not-run:
 *     a record of any shape meant "unfinished" before);
 *   - `provisioningStatus: "pending"` → building;
 *   - otherwise active (including no status at all).
 */
function deriveLegacy(
  s: Record<string, unknown>,
  columns?: TemplateStateColumns
): TemplateState | null {
  const slug = str(s.packageSlug) ?? str(columns?.packageSlug) ?? null;
  const status = str(s.provisioningStatus) ?? str(columns?.provisioningStatus);
  const record = isObject(s.templateApply) ? s.templateApply : null;
  const packs = parsePacks(s.installedPacks);
  const completedSteps = strings(s.completedSteps);
  const version = str(s.packageVersion) ?? null;
  if (!slug && !status && !record && !packs && !completedSteps && !version)
    return null;

  const out: TemplateState = {
    slug,
    version,
    state: "active",
    at: str(record?.at) ?? str(s.provisioningStartedAt) ?? "",
  };
  if (status === "failed") {
    out.state = "failed";
    const step = str(s.failedStep);
    out.failedLayer = step === LAYER_TWO_FAILED_STEP ? 2 : 1;
    if (step) out.failedStep = step;
    const error = str(s.failedStepError);
    if (error) out.error = error;
  } else if (record) {
    out.state = RECORDED.has(record.state as string)
      ? (record.state as TemplateApplyStateName)
      : "layer-2-not-run";
    out.pendingVersion = str(record.version) ?? null;
    const proposals = strings(record.proposals);
    if (proposals?.length) out.proposals = proposals;
    const failures = strings(record.failures);
    if (failures?.length) out.failures = failures;
  } else if (status === "pending") {
    out.state = "building";
  }
  if (completedSteps) out.completedSteps = completedSteps;
  if (packs) out.packs = packs;
  return out;
}

/**
 * THE reader. `settings.template` when present, else derived from the legacy
 * keys (and the promoted columns, for a row whose blob lacks them). `null` =
 * no template state at all (a plain space). Pure.
 */
export function readTemplateState(
  settings: unknown,
  columns?: TemplateStateColumns
): TemplateState | null {
  const s = isObject(settings) ? settings : {};
  if (isObject(s.template)) return normalize(s.template);
  return deriveLegacy(s, columns);
}

/** Did the last apply NOT earn its stamp? (failed, or layer 2 unfinished.) */
export function isTemplateApplyUnfinished(
  state: Pick<TemplateState, "state"> | null | undefined
): boolean {
  return !!state && UNFINISHED.has(state.state);
}

/** A layer-2 failure: layer 1 is built, so it is never resumed through the core. */
export function isFailedInLayerTwo(
  state: Pick<TemplateState, "state" | "failedLayer"> | null | undefined
): boolean {
  return !!state && state.state === "failed" && state.failedLayer === 2;
}

/**
 * Merge a patch onto a state. Pure. `now` stamps `at`.
 */
export function mergeTemplateState(
  current: TemplateState | null,
  patch: TemplateStatePatch,
  now: string
): TemplateState {
  const base: TemplateState = current ?? {
    slug: null,
    version: null,
    state: "active",
    at: now,
  };
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null && key !== "slug" && key !== "version") delete next[key];
    else next[key] = value;
  }
  const out = next as unknown as TemplateState;
  if (out.state !== "failed") {
    delete out.failedLayer;
    delete out.failedStep;
    delete out.error;
  }
  if (!RECORDED.has(out.state)) {
    delete out.pendingVersion;
    delete out.proposals;
    delete out.failures;
  }
  out.at = now;
  return out;
}

/**
 * Upsert a pack into a pack list (by slug). `version: undefined` keeps the
 * entry's previous version (recorded, not earned); the first `installedAt`
 * is kept. Pure.
 */
export function withPack(
  packs: TemplatePackEntry[] | undefined,
  pack: { slug: string; version?: string | null },
  now: string
): TemplatePackEntry[] {
  const list = packs ?? [];
  const existing = list.find((p) => p.slug === pack.slug);
  const entry: TemplatePackEntry = {
    slug: pack.slug,
    version:
      pack.version === undefined
        ? (existing?.version ?? null)
        : (pack.version ?? null),
    installedAt: existing?.installedAt ?? now,
  };
  return [...list.filter((p) => p.slug !== pack.slug), entry];
}

/** The settings keys the legacy mirror owns (all written by the writer). */
export const TEMPLATE_STATE_MIRROR_KEYS = [
  "packageVersion",
  "provisioningStatus",
  "failedStep",
  "failedStepError",
  "completedSteps",
  "templateApply",
  "installedPacks",
] as const;

/**
 * LEGACY MIRROR — removed in W6. The legacy keys as they must read for `t`:
 * `null`-valued `failedStep*` / `templateApply` are today's "cleared"
 * convention; the keys in `remove` are dropped from the blob. `packageSlug`
 * is written only when the state has one (identity is never erased here).
 */
export function legacyMirror(t: TemplateState): {
  set: Partial<WorkspaceSettings>;
  remove: string[];
} {
  const set: Partial<WorkspaceSettings> = {
    provisioningStatus:
      t.state === "building"
        ? "pending"
        : t.state === "failed"
          ? "failed"
          : "active",
    failedStep: t.state === "failed" ? (t.failedStep ?? null) : null,
    failedStepError: t.state === "failed" ? (t.error ?? null) : null,
    templateApply: RECORDED.has(t.state)
      ? {
          state: t.state as "awaiting-approval" | "partial" | "layer-2-not-run",
          version: t.pendingVersion ?? null,
          at: t.at,
          ...(t.proposals?.length ? { proposals: t.proposals } : {}),
          ...(t.failures?.length ? { failures: t.failures } : {}),
        }
      : null,
  };
  const remove: string[] = [];
  if (t.slug) set.packageSlug = t.slug;
  if (t.version) set.packageVersion = t.version;
  else remove.push("packageVersion");
  if (t.completedSteps) set.completedSteps = t.completedSteps;
  else remove.push("completedSteps");
  if (t.packs)
    set.installedPacks = t.packs.map((p) => ({
      slug: p.slug,
      version: p.version ?? "",
      installedAt: p.installedAt,
    }));
  else remove.push("installedPacks");
  return { set, remove };
}

/**
 * The settings keys a NEW workspace row carries for `t` — `template` plus its
 * legacy mirror — for the one INSERT (`WorkspaceRepository.create`), which
 * promotes `packageSlug` / `provisioningStatus` into their columns itself.
 */
export function templateStateSettings(
  patch: TemplateStatePatch,
  now: string = new Date().toISOString()
): Partial<WorkspaceSettings> {
  const template = mergeTemplateState(null, patch, now);
  return { ...legacyMirror(template).set, template };
}

type Tx = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  select: (...a: any[]) => any;
  update: (...a: any[]) => any;
};

export interface WriteTemplateStateOptions {
  /**
   * Emit `workspaces.update.completed` as this user (realtime caches + peer
   * sync), through the module-level event repository. Omitted = no event.
   */
  userId?: string;
}

/**
 * THE writer. Merges `patch` onto the space's CURRENT state under a row lock
 * and writes, in ONE UPDATE: `settings.template`, the legacy mirror (removed
 * in W6) and the `package_slug` / `provisioning_status` columns. Every other
 * settings key is untouched (`settings - <mirror keys> || <new keys>`).
 *
 * `patch` may be a function of the current state (read under the lock), so a
 * decision ("only if not failed", "upsert this pack") is made against the row
 * it then writes. Returning `null` writes nothing.
 *
 * Returns the state written, or `null` when nothing was (the function
 * declined, or the workspace does not exist).
 */
export async function writeTemplateState(
  db: any,
  workspaceId: string,
  patch:
    | TemplateStatePatch
    | ((current: TemplateState | null) => TemplateStatePatch | null),
  opts: WriteTemplateStateOptions = {}
): Promise<TemplateState | null> {
  const result = await (
    db as { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }
  ).transaction(async (tx) => {
    const [row] = (await tx
      .select({
        settings: workspaces.settings,
        packageSlug: workspaces.packageSlug,
        provisioningStatus: workspaces.provisioningStatus,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update")
      .limit(1)) as Array<{
      settings: unknown;
      packageSlug: string | null;
      provisioningStatus: string | null;
    }>;
    if (!row) return null;
    const current = readTemplateState(row.settings, row);
    const change = typeof patch === "function" ? patch(current) : patch;
    if (!change) return null;
    const next = mergeTemplateState(current, change, new Date().toISOString());

    // Identity (0308): taking a template slug must not take one another
    // active space holds — refused as the typed conflict.
    const identity = { name: null, packageSlug: next.slug };
    if (next.slug && next.slug !== row.packageSlug) {
      await assertWorkspaceIdentityFree(tx, {
        ...identity,
        excludeId: workspaceId,
      });
    }

    // LEGACY MIRROR — removed in W6.
    const mirror = legacyMirror(next);
    const written = { ...mirror.set, template: next };
    const removeKeys = sql.join(
      mirror.remove.map((k) => sql`${k}`),
      sql`, `
    );
    const [updated] = await tx
      .update(workspaces)
      .set({
        settings: mirror.remove.length
          ? sql`(COALESCE(${workspaces.settings}, '{}'::jsonb) - ARRAY[${removeKeys}]::text[]) || ${JSON.stringify(written)}::jsonb`
          : sql`COALESCE(${workspaces.settings}, '{}'::jsonb) || ${JSON.stringify(written)}::jsonb`,
        ...(next.slug ? { packageSlug: next.slug } : {}),
        provisioningStatus: mirror.set.provisioningStatus,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()
      .catch((err: unknown) => {
        throw toWorkspaceIdentityError(err, identity);
      });
    return { next, updated };
  });
  if (!result) return null;
  if (opts.userId && result.updated) {
    // After the commit, best-effort: the state LANDED, so a failed announce
    // must not make the caller believe the write failed (it would retry or
    // record a failure over a state that is true). Logged, never swallowed
    // silently.
    try {
      const { WorkspaceRepository } =
        await import("../repositories/workspace-repository.js");
      const { eventRepository } =
        await import("../repositories/event-repository.js");
      await new WorkspaceRepository(db, eventRepository).announceUpdated(
        result.updated,
        opts.userId
      );
    } catch (err) {
      logger.warn(
        { err, workspaceId },
        "writeTemplateState: state written, workspaces.update.completed not announced"
      );
    }
  }
  return result.next;
}

/**
 * Record a pack on a space. `version: undefined` = recorded WITHOUT a version
 * (compose: layer 2 has not run); a version is the finisher's / the boot
 * ledger pass's to write, on convergence.
 */
export function upsertPack(
  db: any,
  workspaceId: string,
  pack: { slug: string; version?: string | null },
  opts: WriteTemplateStateOptions = {}
): Promise<TemplateState | null> {
  return writeTemplateState(
    db,
    workspaceId,
    (current) => ({
      packs: withPack(current?.packs, pack, new Date().toISOString()),
    }),
    opts
  );
}

/** Drop a pack from a space's ledger (no-op when it is not there). */
export function removePack(
  db: any,
  workspaceId: string,
  slug: string,
  opts: WriteTemplateStateOptions = {}
): Promise<TemplateState | null> {
  return writeTemplateState(
    db,
    workspaceId,
    (current) =>
      current?.packs?.some((p) => p.slug === slug)
        ? { packs: current.packs.filter((p) => p.slug !== slug) }
        : null,
    opts
  );
}
