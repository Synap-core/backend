/**
 * recordSessionRunManifest — THE one writer of `focus_sessions.metadata.run`.
 *
 * A run IS a session (intake plan, locked founder decision 1). What makes a run
 * REPRODUCIBLE is the manifest on its session: which source documents came in,
 * which guidelines (id@version) the structurer was told, which engine / model /
 * provider / prompt version answered, and which idempotency namespace the
 * materialize keyed its rows under. Proposals already carry `sessionId`, so the
 * session plus this manifest is the review pack.
 *
 * ── Merge rule (a session can hold more than one structure call) ────────────
 *   - `sourceDocumentIds`, `guidelines`: UNION, first-seen order, never dropped.
 *   - scalars (`engine`, `model`, `provider`, `promptVersion`,
 *     `guidelineStatus`, `idempotencyNamespace`): the LATEST writer that
 *     supplied the field wins; a patch that omits a field keeps the stored one.
 *   A user's own work session that receives several captures therefore holds
 *   the facts of the most recent call only. A minted intake session holds
 *   exactly one run, which is what a rerun (lane B3) replays.
 *
 * ── Honesty ───────────────────────────────────────────────────────────────
 * An IS that sent no `meta` is an OLDER IS, not a known model: its facts are
 * recorded `"unknown"`, never guessed (`runFactsFromStructureMeta`). A pod-side
 * degrade (the IS never answered) is recorded as `engine: "degraded"` with a
 * NULL model, because the pod knows nothing answered.
 *
 * Owner floor: the row is loaded and written under `user_id = userId`; a
 * session the caller does not own reads as `not_found` and nothing is written.
 */

import { db, focusSessions, and, eq, drizzleSql } from "@synap/database";

export interface RunGuidelineRef {
  id: string;
  version: number;
}

/** `structure` / `degraded` come from the IS; the other two are pod facts. */
export type RunEngine = "structure" | "degraded" | "deterministic" | "unknown";

export interface SessionRunManifest {
  version: 1;
  sourceDocumentIds: string[];
  guidelines: RunGuidelineRef[];
  guidelineStatus?: "ok" | "unavailable";
  engine: RunEngine;
  /** `null` = nothing answered; `"unknown"` = an answer with no attribution. */
  model: string | null;
  provider?: string | null;
  promptVersion: string;
  idempotencyNamespace?: string;
  /** Set on a rerun session: which run it replays, and how (`rerunSession`). */
  rerun?: RunRerunLineage;
  /**
   * Per FILE source: who read it (the vision model/provider that saw a photo)
   * and whether its original bytes were kept. UNION by `sourceDocumentId`, the
   * latest writer for a document wins. The structure `model` above is the one
   * that STRUCTURED; this is the one that SAW.
   */
  extractions?: RunSourceExtraction[];
  /**
   * Where the latest structure call's time went (ms). IS facts
   * (`waitMs`/`extractMs`/`modelMs`/`salvaged`) are `null` when the IS did not
   * report them (degraded answer, older IS); pod facts (`dedupMs`,
   * `placementMs`) are `null` when that step did not run (a follow-up skips
   * dedup). Latest writer wins, as a whole.
   */
  timings?: RunTimings;
  updatedAt: string;
}

export interface RunTimings {
  waitMs: number | null;
  extractMs: number | null;
  modelMs: number | null;
  salvaged: boolean | null;
  dedupMs: number | null;
  placementMs: number | null;
}

/** Pod-side step timings `capture.structure` measures around the IS call. */
export interface PodStructureTimings {
  dedupMs: number | null;
  placementMs: number | null;
}

export interface RunSourceExtraction {
  sourceDocumentId: string;
  /** IS extractor id (`vision`, `pdf-parse`, …); `null` when none reported. */
  extractor: string | null;
  /** `null` = no model saw it (degraded, or a non-model extractor). */
  model: string | null;
  provider: string | null;
  originalKept: boolean;
}

export interface RunRerunLineage {
  parentSessionId: string;
  mode: "replace" | "add";
  requestedAt: string;
  reason?: string;
}

export type RunManifestPatch = Partial<
  Omit<SessionRunManifest, "version" | "updatedAt">
>;

/** The IS `client.structure()` run facts (`r.meta`), as the client types them. */
export interface StructureRunMeta {
  engine: "structure" | "degraded";
  model: string | null;
  provider: string | null;
  promptVersion: string;
  timings?: {
    waitMs: number;
    extractMs: number;
    modelMs: number;
    salvaged: boolean;
  };
}

const UNKNOWN = "unknown";

const nonNegativeOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** IS timings (when reported) + pod timings (when measured) → manifest timings. */
function runTimingsFrom(
  meta: StructureRunMeta | undefined | null,
  pod: PodStructureTimings | undefined
): RunTimings | undefined {
  if (!meta?.timings && !pod) return undefined;
  return {
    waitMs: nonNegativeOrNull(meta?.timings?.waitMs),
    extractMs: nonNegativeOrNull(meta?.timings?.extractMs),
    modelMs: nonNegativeOrNull(meta?.timings?.modelMs),
    salvaged:
      typeof meta?.timings?.salvaged === "boolean"
        ? meta.timings.salvaged
        : null,
    dedupMs: nonNegativeOrNull(pod?.dedupMs),
    placementMs: nonNegativeOrNull(pod?.placementMs),
  };
}

/**
 * Map what the structure call told us onto manifest facts.
 *  - `meta` present → recorded verbatim.
 *  - `podDegraded` (the IS never produced an answer) → degraded, NULL model.
 *  - otherwise an older IS answered without `meta` → `"unknown"`, never guessed.
 */
export function runFactsFromStructureMeta(
  meta: StructureRunMeta | undefined | null,
  opts: {
    podDegraded?: boolean;
    degraded?: boolean;
    podTimings?: PodStructureTimings;
  } = {}
): Pick<
  SessionRunManifest,
  "engine" | "model" | "provider" | "promptVersion" | "timings"
> {
  const timings = runTimingsFrom(meta, opts.podTimings);
  const withTimings = timings ? { timings } : {};
  if (meta) {
    return {
      engine: meta.engine,
      model: meta.model,
      provider: meta.provider,
      promptVersion: meta.promptVersion,
      ...withTimings,
    };
  }
  // `degraded`: the outcome itself is degraded but the IS sent no `meta` (an IS
  // build that predates it). No plan was produced, so no model's answer was
  // used — the same facts the IS's own degraded meta reports. Recording
  // "unknown" here erased the one thing the outcome DID say.
  if (opts.podDegraded || opts.degraded) {
    return {
      engine: "degraded",
      model: null,
      provider: null,
      promptVersion: UNKNOWN,
      ...withTimings,
    };
  }
  return {
    engine: "unknown",
    model: UNKNOWN,
    provider: UNKNOWN,
    promptVersion: UNKNOWN,
    ...withTimings,
  };
}

/**
 * Fold two structure calls' run facts (an import structures item by item). A
 * field the calls DISAGREE on is recorded as `"mixed"` rather than picking one;
 * the engine is `structure` when any call structured. Absent facts never
 * overwrite present ones.
 */
export function mergeStructureRunMeta(
  a: StructureRunMeta | null | undefined,
  b: StructureRunMeta | null | undefined
): StructureRunMeta | null {
  if (!b) return a ?? null;
  if (!a) return b;
  const same = <T>(x: T, y: T) => (x === y ? x : ("mixed" as unknown as T));
  return {
    engine:
      a.engine === "structure" || b.engine === "structure"
        ? "structure"
        : "degraded",
    model: same(a.model, b.model),
    provider: same(a.provider, b.provider),
    promptVersion: same(a.promptVersion, b.promptVersion),
    // Timings of two calls do not fold into one run's timings: omitted.
  };
}

/** Read the manifest back off a session's metadata bag (validated, not trusted). */
export function readSessionRunManifest(
  metadata: unknown
): SessionRunManifest | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const run = (metadata as Record<string, unknown>).run;
  if (!run || typeof run !== "object") return undefined;
  const r = run as Record<string, unknown>;
  const ids = Array.isArray(r.sourceDocumentIds)
    ? r.sourceDocumentIds.filter((v): v is string => typeof v === "string")
    : [];
  const guidelines = Array.isArray(r.guidelines)
    ? r.guidelines.filter(
        (g): g is RunGuidelineRef =>
          !!g &&
          typeof g === "object" &&
          typeof (g as RunGuidelineRef).id === "string" &&
          typeof (g as RunGuidelineRef).version === "number"
      )
    : [];
  return {
    version: 1,
    sourceDocumentIds: ids,
    guidelines,
    ...(r.guidelineStatus === "ok" || r.guidelineStatus === "unavailable"
      ? { guidelineStatus: r.guidelineStatus }
      : {}),
    engine: (typeof r.engine === "string" ? r.engine : UNKNOWN) as RunEngine,
    model: typeof r.model === "string" || r.model === null ? r.model : UNKNOWN,
    ...(typeof r.provider === "string" || r.provider === null
      ? { provider: r.provider }
      : {}),
    promptVersion:
      typeof r.promptVersion === "string" ? r.promptVersion : UNKNOWN,
    ...(typeof r.idempotencyNamespace === "string"
      ? { idempotencyNamespace: r.idempotencyNamespace }
      : {}),
    ...(readRerunLineage(r.rerun) ? { rerun: readRerunLineage(r.rerun) } : {}),
    ...(Array.isArray(r.extractions)
      ? { extractions: readSourceExtractions(r.extractions) }
      : {}),
    ...(readRunTimings(r.timings)
      ? { timings: readRunTimings(r.timings) }
      : {}),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
  };
}

function readRunTimings(raw: unknown): RunTimings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as Record<string, unknown>;
  return {
    waitMs: nonNegativeOrNull(t.waitMs),
    extractMs: nonNegativeOrNull(t.extractMs),
    modelMs: nonNegativeOrNull(t.modelMs),
    salvaged: typeof t.salvaged === "boolean" ? t.salvaged : null,
    dedupMs: nonNegativeOrNull(t.dedupMs),
    placementMs: nonNegativeOrNull(t.placementMs),
  };
}

function readSourceExtractions(raw: unknown[]): RunSourceExtraction[] {
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  return raw.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const x = e as Record<string, unknown>;
    if (typeof x.sourceDocumentId !== "string") return [];
    return [
      {
        sourceDocumentId: x.sourceDocumentId,
        extractor: strOrNull(x.extractor),
        model: strOrNull(x.model),
        provider: strOrNull(x.provider),
        originalKept: x.originalKept === true,
      },
    ];
  });
}

function readRerunLineage(raw: unknown): RunRerunLineage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.parentSessionId !== "string") return undefined;
  if (r.mode !== "replace" && r.mode !== "add") return undefined;
  return {
    parentSessionId: r.parentSessionId,
    mode: r.mode,
    requestedAt: typeof r.requestedAt === "string" ? r.requestedAt : "",
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
  };
}

/** Pure: fold a patch over the stored manifest. See the header for the rule. */
export function mergeRunManifest(
  prior: SessionRunManifest | undefined,
  patch: RunManifestPatch,
  now: Date = new Date()
): SessionRunManifest {
  const union = <T>(a: T[], b: T[] | undefined, key: (v: T) => string) => {
    const seen = new Set(a.map(key));
    const out = [...a];
    for (const v of b ?? []) {
      if (seen.has(key(v))) continue;
      seen.add(key(v));
      out.push(v);
    }
    return out;
  };
  const pick = <K extends keyof RunManifestPatch>(k: K) =>
    patch[k] !== undefined ? patch[k] : prior?.[k];

  const guidelineStatus = pick("guidelineStatus");
  const provider = pick("provider");
  const idempotencyNamespace = pick("idempotencyNamespace");
  const timings = pick("timings");
  // Lineage is set once, at mint; a later structure call's patch never drops it.
  const rerun = pick("rerun");
  return {
    version: 1,
    sourceDocumentIds: union(
      prior?.sourceDocumentIds ?? [],
      patch.sourceDocumentIds,
      (v) => v
    ),
    guidelines: union(
      prior?.guidelines ?? [],
      patch.guidelines,
      (g) => `${g.id}@${g.version}`
    ),
    ...(guidelineStatus ? { guidelineStatus } : {}),
    engine: (pick("engine") ?? UNKNOWN) as RunEngine,
    // NOT `?? UNKNOWN`: an explicit null ("nothing answered") must survive —
    // folding it into "unknown" erases the one distinction this field carries.
    model:
      pick("model") === undefined ? UNKNOWN : (pick("model") as string | null),
    ...(provider !== undefined ? { provider } : {}),
    promptVersion: (pick("promptVersion") as string | undefined) ?? UNKNOWN,
    ...(idempotencyNamespace ? { idempotencyNamespace } : {}),
    ...(rerun ? { rerun } : {}),
    ...(timings ? { timings } : {}),
    ...(prior?.extractions?.length || patch.extractions?.length
      ? {
          extractions: [
            // Latest writer for a document wins; first-seen order is kept.
            ...new Map(
              [...(prior?.extractions ?? []), ...(patch.extractions ?? [])].map(
                (e) => [e.sourceDocumentId, e] as const
              )
            ).values(),
          ],
        }
      : {}),
    updatedAt: now.toISOString(),
  };
}

export type RecordSessionRunManifestResult =
  | { ok: true; manifest: SessionRunManifest }
  | { ok: false; reason: "not_found" };

export async function recordSessionRunManifest(args: {
  sessionId: string;
  userId: string;
  patch: RunManifestPatch;
  database?: typeof db;
}): Promise<RecordSessionRunManifestResult> {
  const database = args.database ?? db;
  return database.transaction(async (tx) => {
    // Row lock: two captures filing into one session must not lose a source.
    const [row] = await tx
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, args.sessionId),
          eq(focusSessions.userId, args.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const manifest = mergeRunManifest(
      readSessionRunManifest(row.metadata),
      args.patch
    );
    await tx
      .update(focusSessions)
      .set({
        metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || jsonb_build_object('run', ${JSON.stringify(manifest)}::jsonb)`,
      })
      .where(
        and(
          eq(focusSessions.id, args.sessionId),
          eq(focusSessions.userId, args.userId)
        )
      );
    return { ok: true as const, manifest };
  });
}
