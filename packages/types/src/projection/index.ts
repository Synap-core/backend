/**
 * Per-kind projection — THE door for "which fields of this kind matter".
 *
 * Surfaces across four repos (browser, relay, synap-app, the IS) each hand-list
 * the fields worth showing for a kind, which makes every one of them blind to
 * user-defined kinds and to workspace overlays. This module replaces those lists
 * with ONE pure function over the effective property defs the caller already
 * holds.
 *
 * ## Why a pure function and not a cached/materialised projection
 *
 * The projection is workspace-lensed (a workspace overlay changes the field set)
 * and fill-ranked (the data changes under it), so a server-cached or stamped
 * answer would be wrong the moment either moves. Directus and Strapi both
 * derive-once-then-freeze this into a metadata row, and their documented
 * "my new field won't show up" / stale-column bugs all trace back to that.
 * Same class of defect as this repo's own rule: never stamp a marker you did
 * not earn. So: computed at read time, every time. Never materialise.
 *
 * ## Role names come from OData / SAP `com.sap.vocabularies.UI.v1`
 *
 * A 15-year-old standard for exactly this problem, adopted rather than
 * reinvented: `UI.HeaderInfo.Title` -> {@link KindProjection.title},
 * `UI.LineItem` -> {@link KindProjection.lineItem},
 * `UI.SelectionFields` -> {@link KindProjection.selectionFields}.
 * The remaining buckets (`textKeys`, `dateKeys`, `identityKeys`) are the ones
 * existing Synap consumers need and have no OData equivalent.
 *
 * ## THE ORDERING RULE (this is the whole design)
 *
 * Candidates sort by, in order:
 *   1. `required` DESC — author intent always wins, so a required field shows
 *      even with no data behind it yet.
 *   2. fill ratio DESC (`filled / sampleSize`), contributing **0** when
 *      `sampleSize === 0` or when no `fill` entry exists for the slug.
 *   3. the caller's given order (already `layer -> displayOrder -> slug`).
 * Then cap at `limit`.
 *
 * Measured evidence, from the live pod (kind `task`, Builder-workspace lens,
 * 18 declared fields, sampleSize 134):
 *
 * - By declared order alone the capped list is
 *   `title, task-status, task-priority, status, priority, task-project,
 *   task-type` — which includes `assignee` further down (0 of 134 filled) and
 *   drops `description` (38 of 134) entirely.
 *   Under the rule above it is exactly the seven data-bearing columns:
 *   `title(134) status(118) priority(80) description(38) dueDate(15) tags(14)
 *   projectId(10)`.
 *
 * - It also dissolves the duplicate-twin problem WITHOUT a suppression rule.
 *   The pod ships twins (`status`/`task-status`, `priority`/`task-priority`)
 *   where the overlay twin is near-dead (`task-status`: 4 of 134). Fill-ranking
 *   sinks the dead twin below the cap on its own — and if a workspace genuinely
 *   adopts it, it rises. A suppression rule was considered and REJECTED:
 *   suppressing the base twin hid 223 filled values, and suppressing the
 *   less-filled one coin-flipped on 0-vs-0 ties and silently reversed the
 *   template author's deliberate choice.
 *
 * - With no fill data at all (new kind, cold start) the rule degrades cleanly to
 *   `required -> declared order`, i.e. never worse than today.
 *
 * `fill` is a TIEBREAKER, never a gate: nothing is ever filtered out for being
 * empty.
 *
 * ## Purity contract
 *
 * No I/O, no DB, no clock, no network, no module-level mutable state.
 * Deterministic for identical input. Inputs are never mutated.
 *
 * Classification reuses the bucket heuristic of
 * `synap-app/packages/views/bento/src/utils/default-entity-bento.ts`
 * (`classifyProperty`), with one correction: that function leads with
 * `uiHints.displayAs` on 5 of its 6 branches, and `displayAs` is populated on
 * 4 of 358 property defs (1.1%) on the live pod, so in practice it always fell
 * through to slug regexes. Here the lead signal is `uiHints.inputType`
 * (90% populated), then `valueType` and `constraints.enum` (20%), with
 * `displayAs` demoted to a secondary signal and the slug regexes kept as the
 * last resort they always effectively were.
 */

// ─── Input ───────────────────────────────────────────────────────────────────

/**
 * Minimal structural shape of one row returned by `getEffectiveProperties`.
 *
 * Deliberately structural and loose: `@synap/database`'s `EffectiveProperty`
 * (and this package's own `EffectiveProperty` in `../profiles`) is assignable to
 * it, but this package imports neither — the door must stay usable from the
 * browser, relay, the CLI and the IS.
 *
 * `constraints` / `uiHints` are `Record<string, unknown>` upstream, so they are
 * accepted as such and narrowed internally rather than being declared in a
 * shape nothing actually satisfies.
 */
export interface ProjectionProperty {
  slug: string;
  valueType?: string | null;
  constraints?: Readonly<Record<string, unknown>> | null;
  uiHints?: Readonly<Record<string, unknown>> | null;
  required?: boolean;
  displayOrder?: number;
  workspaceId?: string | null;
  targetProfileId?: string | null;
}

/** Per-slug fill measurement. `sampleSize === 0` contributes nothing. */
export interface PropertyFill {
  filled: number;
  sampleSize: number;
}

export interface ResolveKindProjectionInput {
  /** Effective property defs, already ordered by the resolver. */
  properties: ReadonlyArray<ProjectionProperty>;
  /** Optional fill measurements, keyed by property slug. Tiebreaker only. */
  fill?: Readonly<Record<string, PropertyFill>>;
  /** Cap for {@link KindProjection.lineItem}. Default 7. */
  limit?: number;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface KindProjection {
  /** `UI.HeaderInfo.Title` — the field that names a record, or null. */
  title: string | null;
  /** `UI.LineItem` — ordered, capped column slugs. */
  lineItem: string[];
  /** `UI.SelectionFields` — filterable slugs (enum-constrained / boolean). */
  selectionFields: string[];
  /** Long-form prose fields (textarea / richtext / markdown). */
  textKeys: string[];
  /** Date and datetime fields. */
  dateKeys: string[];
  /** Identity handles — email, phone, url, handle. */
  identityKeys: string[];
}

// ─── Classification ──────────────────────────────────────────────────────────

export type PropertyBucket =
  "featured" | "date" | "identity" | "longtext" | "general";

/** Slug regexes carried over from `default-entity-bento.ts::classifyProperty`. */
const FEATURED_SLUG_RE =
  /status|stage|phase|priority|urgency|progress|completion|percent/;
const DATE_SLUG_RE = /date|due|deadline|start|end|created|updated/;
const PROGRESS_SLUG_RE = /progress|completion|percent/;
const IDENTITY_SLUG_RE =
  /email|phone|tel|mobile|fax|website|url|link|handle|linkedin|twitter|social/;
const LONGTEXT_SLUG_RE =
  /note|description|bio|summary|comment|body|content|detail|about|overview/;

const TITLE_SLUGS = [
  "title",
  "name",
  "label",
  "subject",
  "headline",
  "displayname",
  "fullname",
];

function str(
  bag: Readonly<Record<string, unknown>> | null | undefined,
  key: string
): string | undefined {
  const v = bag?.[key];
  return typeof v === "string" ? v.toLowerCase() : undefined;
}

function enumValues(p: ProjectionProperty): string[] {
  const fromConstraints = p.constraints?.["enum"];
  if (Array.isArray(fromConstraints) && fromConstraints.length > 0) {
    return fromConstraints.map(String);
  }
  const fromHints = p.uiHints?.["enumValues"];
  if (Array.isArray(fromHints) && fromHints.length > 0) {
    return fromHints.map(String);
  }
  return [];
}

/**
 * Bucket one property. Signal precedence — measured on the live pod, 358 defs:
 * `uiHints.inputType` (90% populated) > `valueType` / `constraints.enum` (20%)
 * > `uiHints.displayAs` (1.1%) > slug regexes.
 */
export function classifyProperty(p: ProjectionProperty): PropertyBucket {
  const slug = p.slug.toLowerCase();
  const inputType = str(p.uiHints, "inputType");
  const displayAs = str(p.uiHints, "displayAs");
  const valueType = (p.valueType ?? "").toLowerCase();
  const hasEnum = enumValues(p).length > 0;

  // 1 — inputType (the reliable signal)
  switch (inputType) {
    case "date":
    case "datetime":
    case "datetime-local":
    case "time":
      return "date";
    case "textarea":
    case "richtext":
    case "markdown":
      return "longtext";
    case "email":
    case "phone":
    case "tel":
    case "url":
    case "link":
      return "identity";
    case "select":
    case "radio":
    case "checkbox":
    case "switch":
    case "toggle":
    case "boolean":
      return "featured";
    default:
      break;
  }

  // 2 — valueType + constraints
  if (valueType === "date" || valueType === "datetime") return "date";
  if (valueType === "boolean") return "featured";
  if (hasEnum) return "featured";

  // 3 — displayAs (populated on ~1% of defs; kept as a secondary signal only)
  if (
    displayAs === "status" ||
    displayAs === "priority" ||
    displayAs === "progress"
  ) {
    return "featured";
  }
  if (displayAs === "richtext" || displayAs === "markdown") return "longtext";
  if (
    displayAs === "email" ||
    displayAs === "phone" ||
    displayAs === "url" ||
    displayAs === "link"
  ) {
    return "identity";
  }

  // 4 — slug regexes (last resort)
  if (valueType === "number" && PROGRESS_SLUG_RE.test(slug)) return "featured";
  if (FEATURED_SLUG_RE.test(slug) && hasEnum) return "featured";
  if (DATE_SLUG_RE.test(slug) && valueType !== "string") return "date";
  if (IDENTITY_SLUG_RE.test(slug)) return "identity";
  if (valueType === "string" && LONGTEXT_SLUG_RE.test(slug)) return "longtext";

  return "general";
}

/** A property that can be filtered on: enum-constrained or boolean. */
function isSelectable(p: ProjectionProperty): boolean {
  if ((p.valueType ?? "").toLowerCase() === "boolean") return true;
  const inputType = str(p.uiHints, "inputType");
  if (
    inputType === "checkbox" ||
    inputType === "switch" ||
    inputType === "toggle"
  ) {
    return true;
  }
  return enumValues(p).length > 0;
}

// ─── The door ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 7;

/** Fill ratio; 0 when unmeasured or when the sample is empty. */
function fillRatio(
  slug: string,
  fill: Readonly<Record<string, PropertyFill>> | undefined
): number {
  const f = fill?.[slug];
  if (!f) return 0;
  if (!Number.isFinite(f.filled) || !Number.isFinite(f.sampleSize)) return 0;
  if (f.sampleSize <= 0) return 0;
  return f.filled / f.sampleSize;
}

/**
 * Resolve which fields of a kind matter, from the property defs the caller
 * already holds. Pure; see the module docblock for the ordering rule and the
 * measured evidence behind it.
 */
export function resolveKindProjection(
  input: ResolveKindProjectionInput
): KindProjection {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const fill = input.fill;

  const ranked = input.properties
    .map((property, index) => ({
      property,
      index,
      bucket: classifyProperty(property),
      required: property.required === true,
      ratio: fillRatio(property.slug, fill),
    }))
    .sort(
      (a, b) =>
        // 1. author intent
        Number(b.required) - Number(a.required) ||
        // 2. fill ratio (0 when unmeasured — never a gate, only a tiebreaker)
        b.ratio - a.ratio ||
        // 3. the caller's given order
        a.index - b.index
    );

  const slugsIn = (bucket: PropertyBucket): string[] =>
    ranked.filter((r) => r.bucket === bucket).map((r) => r.property.slug);

  return {
    title: resolveTitle(input.properties),
    lineItem: (limit > 0 ? ranked.slice(0, limit) : []).map(
      (r) => r.property.slug
    ),
    selectionFields: ranked
      .filter((r) => isSelectable(r.property))
      .map((r) => r.property.slug),
    textKeys: slugsIn("longtext"),
    dateKeys: slugsIn("date"),
    identityKeys: slugsIn("identity"),
  };
}

/**
 * The field that names a record. Exact slug match against a small conventional
 * list first (normalised, so `display-name` / `display_name` / `displayName`
 * all hit); otherwise the first short-text field, preferring a required one.
 */
function resolveTitle(
  properties: ReadonlyArray<ProjectionProperty>
): string | null {
  let best: { slug: string; rank: number } | null = null;
  for (const p of properties) {
    const normalised = p.slug.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rank = TITLE_SLUGS.indexOf(normalised);
    if (rank >= 0 && (best === null || rank < best.rank)) {
      best = { slug: p.slug, rank };
    }
  }
  if (best) return best.slug;

  const isShortText = (p: ProjectionProperty): boolean =>
    (p.valueType ?? "").toLowerCase() === "string" &&
    classifyProperty(p) === "general";

  const required = properties.find(
    (p) => p.required === true && isShortText(p)
  );
  if (required) return required.slug;

  return properties.find(isShortText)?.slug ?? null;
}
