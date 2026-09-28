/**
 * THE SPACE BRIEF — how an agent works inside one space (workspace).
 *
 * ONE type, ONE reader. Stored at `workspace.settings.onboarding` (the key is
 * kept: 28 templates and every installed space already write it there), and
 * called `SpaceBrief` in code. The interview fields (`goal`, `collect`,
 * `openingQuestions`, `doneWhen`) are the brief's ONBOARDING MODE — what the
 * shared `onboard` skill runs while a space is still empty. The steady-state
 * fields (`purpose`, `anchors`, `rules`, `fetch`) are what any agent entering
 * the space is told every time.
 *
 * WHY ONE TYPE (2026-09-28). The onboarding shape was declared in eight places
 * (package definition, workspace settings, template authoring, discover,
 * browser, CLI, CP, hub client) and they had drifted — one required `framing`,
 * another typed the whole thing `Record<string, unknown>`. This leaf is the
 * source; the others re-export it or, where a package boundary forbids the
 * import, mirror it under a compile-time parity floor.
 *
 * Pure and dependency-free: the pod, the browser, relay, the CLI and the
 * template authoring package import the same answer.
 */

/** How many of a kind the interview should aim for — guides depth. */
export type SpaceBriefCardinality = "one" | "few" | "several";

/** One kind the onboarding interview fills. */
export interface SpaceBriefCollectTarget {
  /** Profile slug to populate (e.g. "brand-identity"). */
  profileSlug: string;
  /** Human description of what to capture for this target. */
  what: string;
  /** Roughly how many to expect — guides interview depth. */
  cardinality?: SpaceBriefCardinality;
  /** Key fields the agent should make sure to fill. */
  keyFields?: string[];
  /**
   * The MINIMUM this space needs before it counts as onboarded: at least `min`
   * entities of this kind with every `keyFields` entry filled. Folded in from
   * the golden standards' `requires` so a pod can check itself.
   */
  min?: number;
}

/** Authored domain expertise the agent LEADS with. */
export interface SpaceBriefExpertise {
  /** Concrete starting points the agent proposes instead of asking blank. */
  starters?: string[];
  /** Blind spots people in this domain miss — surfaced proactively. */
  blindSpots?: string[];
  /** What a great result looks like here — the bar the agent pushes toward. */
  bar?: string;
}

/** `root` = THE entity this space is about; `context` = read it too. */
export type SpaceBriefAnchorRole = "root" | "context";

export const SPACE_BRIEF_ANCHOR_ROLES: readonly SpaceBriefAnchorRole[] = [
  "root",
  "context",
];

/**
 * An entity an agent reads FIRST in this space. A template names it by kind
 * (and optionally by one of its own suggested entities, `seedRef`); the pod
 * resolves `seedRef` to `entityId` at install. Without an `entityId`, the
 * anchor means "the `limit` most relevant entities of this kind here".
 */
export interface SpaceBriefAnchor {
  profileSlug: string;
  role: SpaceBriefAnchorRole;
  /** A suggested entity of the template (`refKey` | `kind:title` | unique title). */
  seedRef?: string;
  /** Resolved at install from `seedRef`, or set by the user. */
  entityId?: string;
  /** How many entities of the kind to read when no `entityId` is set. */
  limit?: number;
}

/** Where to look for context before acting — a kind, a query, or both. */
export interface SpaceBriefFetchHint {
  profileSlug?: string;
  query?: string;
  /** Why this is worth reading, in a few words. */
  note?: string;
}

/**
 * A reference to a RULE a template installed in this space. The brief lists
 * refs; the rule itself (intent, sentence, behaviour) lives in its own row,
 * written through the ONE rule door.
 */
export interface SpaceBriefRuleRef {
  /** The template's stable key for the rule (`SpaceTemplateRule.key`). */
  key: string;
  /** The installed rule row, once the pod created it. */
  ruleId?: string;
}

/**
 * A rule a template DECLARES (package definition `rules[]`). Applied as a rule
 * row in the space through the one rule door; never stored in the brief.
 */
export interface SpaceTemplateRule {
  /** Stable identity across template versions — the reconcile keys on it. */
  key: string;
  /** The standing instruction, in plain words. */
  intent: string;
  /** Optional WHEN/THEN sentence that compiles to a behaviour. */
  sentence?: unknown;
}

/** The brief, as stored at `settings.onboarding`. */
export interface SpaceBrief {
  /** What this space is for, day to day (steady state). */
  purpose?: string;
  /** Onboarding mode: the outcome the interview achieves, in one sentence. */
  goal?: string;
  /** The persona / voice to adopt in this space. */
  framing?: string;
  expertise?: SpaceBriefExpertise;
  /** Onboarding mode: what structured data to collect. */
  collect?: SpaceBriefCollectTarget[];
  /** Onboarding mode: a few opening questions — adapt from here. */
  openingQuestions?: string[];
  /** Onboarding mode: when the interview is done. */
  doneWhen?: string;
  /** Entities to read first. */
  anchors?: SpaceBriefAnchor[];
  /** Rules this space's template installed (refs, not bodies). */
  rules?: SpaceBriefRuleRef[];
  /** Where to look before acting. */
  fetch?: SpaceBriefFetchHint[];
}

/**
 * The fields a TEMPLATE seeds and the reconcile converges with a three-way
 * stamp. `rules` is NOT here: rule refs are written by the rule applier, and
 * each rule row carries its own seed marker (`metadata.rule.seed`).
 */
export const SPACE_BRIEF_TEMPLATE_FIELDS = [
  "purpose",
  "goal",
  "framing",
  "expertise",
  "collect",
  "openingQuestions",
  "doneWhen",
  "anchors",
  "fetch",
] as const satisfies ReadonlyArray<keyof SpaceBrief>;

/** Fields owned by an applier other than the brief reconcile. */
export const SPACE_BRIEF_APPLIER_OWNED_FIELDS = [
  "rules",
] as const satisfies ReadonlyArray<keyof SpaceBrief>;

export type SpaceBriefTemplateField =
  (typeof SPACE_BRIEF_TEMPLATE_FIELDS)[number];

// COMPILE FLOOR: a new SpaceBrief field that is neither template-seeded nor
// applier-owned stops the build — the reconcile must decide who owns it.
type _SpaceBriefClassified =
  Exclude<
    keyof SpaceBrief,
    SpaceBriefTemplateField
  > extends (typeof SPACE_BRIEF_APPLIER_OWNED_FIELDS)[number]
    ? true
    : never;
const _spaceBriefClassified: _SpaceBriefClassified = true;
void _spaceBriefClassified;

/** The fields that make a brief an INTERVIEW (the onboarding mode). */
export const SPACE_BRIEF_INTERVIEW_FIELDS = [
  "goal",
  "openingQuestions",
  "doneWhen",
] as const satisfies ReadonlyArray<keyof SpaceBrief>;

/**
 * Whose word wins when instructions disagree, highest first. Carried in the
 * brief's consumers and in the `onboard` skill; never re-typed elsewhere.
 */
export const SPACE_BRIEF_PRECEDENCE = [
  "governance floors",
  "the user's explicit instruction",
  "project rule",
  "space rule",
  "pod rule",
  "template persona",
] as const;

export const SPACE_BRIEF_PRECEDENCE_NOTE = `When instructions conflict: ${SPACE_BRIEF_PRECEDENCE.join(" > ")}.`;

// ─── The ONE reader ──────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const text = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const texts = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(text).filter((s): s is string => !!s);
  return out.length ? out : undefined;
};

const positiveInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

function readCollect(v: unknown): SpaceBriefCollectTarget[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpaceBriefCollectTarget[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const profileSlug = text(raw.profileSlug);
    if (!profileSlug) continue;
    const cardinality =
      raw.cardinality === "one" ||
      raw.cardinality === "few" ||
      raw.cardinality === "several"
        ? raw.cardinality
        : undefined;
    const keyFields = texts(raw.keyFields);
    const min = positiveInt(raw.min);
    out.push({
      profileSlug,
      what: text(raw.what) ?? "",
      ...(cardinality ? { cardinality } : {}),
      ...(keyFields ? { keyFields } : {}),
      ...(min ? { min } : {}),
    });
  }
  return out.length ? out : undefined;
}

function readExpertise(v: unknown): SpaceBriefExpertise | undefined {
  if (!isRecord(v)) return undefined;
  const starters = texts(v.starters);
  const blindSpots = texts(v.blindSpots);
  const bar = text(v.bar);
  if (!starters && !blindSpots && !bar) return undefined;
  return {
    ...(starters ? { starters } : {}),
    ...(blindSpots ? { blindSpots } : {}),
    ...(bar ? { bar } : {}),
  };
}

function readAnchors(v: unknown): SpaceBriefAnchor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpaceBriefAnchor[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const profileSlug = text(raw.profileSlug);
    if (!profileSlug) continue;
    const role: SpaceBriefAnchorRole = raw.role === "root" ? "root" : "context";
    const seedRef = text(raw.seedRef);
    const entityId = text(raw.entityId);
    const limit = positiveInt(raw.limit);
    out.push({
      profileSlug,
      role,
      ...(seedRef ? { seedRef } : {}),
      ...(entityId ? { entityId } : {}),
      ...(limit ? { limit } : {}),
    });
  }
  return out.length ? out : undefined;
}

function readRuleRefs(v: unknown): SpaceBriefRuleRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpaceBriefRuleRef[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const key = text(raw.key);
    if (!key) continue;
    const ruleId = text(raw.ruleId);
    out.push({ key, ...(ruleId ? { ruleId } : {}) });
  }
  return out.length ? out : undefined;
}

function readFetch(v: unknown): SpaceBriefFetchHint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SpaceBriefFetchHint[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const profileSlug = text(raw.profileSlug);
    const query = text(raw.query);
    if (!profileSlug && !query) continue;
    const note = text(raw.note);
    out.push({
      ...(profileSlug ? { profileSlug } : {}),
      ...(query ? { query } : {}),
      ...(note ? { note } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Normalize a stored brief. Stored JSONB is DATA: a malformed part reads as
 * absent (never half-trusted), a whitespace-only string is absent, and a list
 * with nothing readable is absent. Returns `null` when there is no brief at
 * all — a space without one, which is different from an EMPTY brief (`{}`,
 * an object whose every field was unreadable).
 */
export function normalizeSpaceBrief(raw: unknown): SpaceBrief | null {
  if (!isRecord(raw)) return null;
  const purpose = text(raw.purpose);
  const goal = text(raw.goal);
  const framing = text(raw.framing);
  const expertise = readExpertise(raw.expertise);
  const collect = readCollect(raw.collect);
  const openingQuestions = texts(raw.openingQuestions);
  const doneWhen = text(raw.doneWhen);
  const anchors = readAnchors(raw.anchors);
  const rules = readRuleRefs(raw.rules);
  const fetch = readFetch(raw.fetch);
  return {
    ...(purpose ? { purpose } : {}),
    ...(goal ? { goal } : {}),
    ...(framing ? { framing } : {}),
    ...(expertise ? { expertise } : {}),
    ...(collect ? { collect } : {}),
    ...(openingQuestions ? { openingQuestions } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(anchors ? { anchors } : {}),
    ...(rules ? { rules } : {}),
    ...(fetch ? { fetch } : {}),
  };
}

/** THE reader: a workspace's `settings` → its brief, or `null` when it has none. */
export function readSpaceBrief(settings: unknown): SpaceBrief | null {
  if (!isRecord(settings)) return null;
  return normalizeSpaceBrief(settings.onboarding);
}

/** True when the brief carries the onboarding INTERVIEW (not only steady state). */
export function isInterviewBrief(
  brief: SpaceBrief | null | undefined
): boolean {
  if (!brief) return false;
  return SPACE_BRIEF_INTERVIEW_FIELDS.some((f) => brief[f] !== undefined);
}

/**
 * The brief half of the purpose ladder: steady-state `purpose`, else the
 * interview `goal`. Callers that say what a SPACE is for use
 * `resolveSpacePurpose` (the authored description outranks both).
 */
export function briefPurpose(
  brief: SpaceBrief | null | undefined
): string | null {
  return brief?.purpose ?? brief?.goal ?? null;
}

/**
 * A description that is a rendering of another field, never an authored
 * purpose: "Domain: personal" was written into 9 of 14 live workspaces.
 */
const PLACEHOLDER_DESCRIPTION = /^\s*domain:\s*\S+\s*$/i;

/**
 * A workspace's AUTHORED description — trimmed; `null` for empty, non-string
 * or placeholder text (`Domain: x`).
 */
export function resolveAuthoredDescription(
  description: unknown
): string | null {
  if (typeof description !== "string") return null;
  const t = description.trim();
  return t && !PLACEHOLDER_DESCRIPTION.test(t) ? t : null;
}

/**
 * THE purpose ladder — one rule for every surface that says what a space is
 * for (pod: pinned brief, orient, find, ask, diagnose; browser; relay):
 *
 *   1. the workspace's AUTHORED description (the user's own words, never a
 *      `Domain: x` placeholder) — it persists, so it wins;
 *   2. the brief's steady-state `purpose`;
 *   3. the brief's interview `goal`.
 *
 * `settings` is the workspace's settings; the brief is read through THE
 * reader. Returns `null` when the space states no purpose.
 */
export function resolveSpacePurpose(input: {
  description?: unknown;
  settings?: unknown;
}): string | null {
  return (
    resolveAuthoredDescription(input.description) ??
    briefPurpose(readSpaceBrief(input.settings))
  );
}

// ─── Editing: the narrow patch the `update_brief` door applies ───────────────

/**
 * A field-level patch. A value REPLACES that field; `null` REMOVES it; an
 * absent key leaves it alone. Only the template-seeded fields are editable
 * here — rule refs change through the rule door, never by editing the brief.
 */
export type SpaceBriefPatch = {
  [K in SpaceBriefTemplateField]?: SpaceBrief[K] | null;
};

/** Apply a patch, then normalize — the result is exactly what gets stored. */
export function applySpaceBriefPatch(
  current: SpaceBrief | null,
  patch: SpaceBriefPatch
): SpaceBrief {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const field of SPACE_BRIEF_TEMPLATE_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  return normalizeSpaceBrief(next) ?? {};
}

export interface SpaceBriefFieldChange {
  field: keyof SpaceBrief;
  before?: unknown;
  after?: unknown;
}

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`
    )
    .join(",")}}`;
};

/** The fields that differ between two briefs, in declaration order. */
export function diffSpaceBrief(
  before: SpaceBrief | null,
  after: SpaceBrief | null
): SpaceBriefFieldChange[] {
  const fields: Array<keyof SpaceBrief> = [
    ...SPACE_BRIEF_TEMPLATE_FIELDS,
    ...SPACE_BRIEF_APPLIER_OWNED_FIELDS,
  ];
  const out: SpaceBriefFieldChange[] = [];
  for (const field of fields) {
    const b = before?.[field];
    const a = after?.[field];
    if (canonical(b) === canonical(a)) continue;
    out.push({
      field,
      ...(b !== undefined ? { before: b } : {}),
      ...(a !== undefined ? { after: a } : {}),
    });
  }
  return out;
}
