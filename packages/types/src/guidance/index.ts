/**
 * `@synap-core/types/guidance` — the rules a PLAYBOOK follows (design
 * b199a3a4, Question 1, slice 1a).
 *
 * A playbook declares `guidance`: an ordered list of REFERENCES, never ids, so
 * the same declaration is portable across pods and works verbatim in a catalog
 * manifest:
 *   - `kind:<profileSlug>` — the current (person-approved) entities of a kind,
 *     e.g. `kind:brand-voice-guide`, `kind:outreach-angle`;
 *   - `skill:<slug>` — an approved, active skill, e.g. `skill:creative-director`.
 *
 * The internal name is `guidance`, never `rule`: "rule" already names two other
 * objects in Synap (a rule-loop skill, a governance rule).
 *
 * Pure and dependency-free. The pod's write door validates with
 * {@link validateGuidanceList}; the pod's loader resolves the refs into
 * {@link ResolvedGuidance} items and {@link renderGuidance} turns them into the
 * "Rules this playbook follows" section of the ONE method renderer
 * (`renderPlaybookMethod`). The renderer is deterministic: the same items in
 * any row or field order give the same bytes and the same hash.
 */
import { canonicalJson, cyrb53 } from "../brand-kit/index.js";
import { estimateSkillTokens, isSpaceSkillSlug } from "../space-brief/index.js";
import { humanizeToken } from "../vocabulary/index.js";

/** The section heading, as the method renders it. */
export const GUIDANCE_HEADING = "## Rules this playbook follows";

/**
 * The section's budget, in tokens (~4 chars each, the IS estimate): the IS's
 * own STANDING RULES tier (`dynamic-skill-loader.ts`, `RULES: 2_000`).
 */
export const GUIDANCE_BUDGET_TOKENS = 2_000;

/** At most this many declared items per playbook. */
export const MAX_GUIDANCE_ITEMS = 12;

const LABEL_MAX = 120;
const WHEN_MAX = 500;
const WHERE_MAX_KEYS = 5;
const WHERE_MAX_VALUES = 20;

/** The sentence an ordered kind (rows with an `order`) renders under its heading. */
export const GUIDANCE_ORDERED_SENTENCE =
  "Take the first row whose condition fits the subject, else the last row.";

/** A profile (kind) slug: the pod's own grammar for kind slugs. */
const KIND_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;

// ─── Declaration ─────────────────────────────────────────────────────────────

/** One declared item, as a playbook (or a catalog manifest) stores it. */
export interface GuidanceDeclaration {
  /** `kind:<profileSlug>` or `skill:<slug>`. */
  ref: string;
  /** What the section calls it ("Voice"). Default: the kind or skill name. */
  label?: string;
  /** One line: when this applies. Rendered, never parsed. */
  when?: string;
  /**
   * Kind refs only: keep the entities whose property `<slug>` holds one of
   * the listed values (`{ "voice-context": ["general", "outreach"] }`). An
   * entity without the property does not match.
   */
  where?: Record<string, string[]>;
}

export type GuidanceRef =
  { type: "kind"; slug: string } | { type: "skill"; slug: string };

/** Parse a ref; `null` when it is not `kind:<slug>` or `skill:<slug>`. */
export function parseGuidanceRef(ref: unknown): GuidanceRef | null {
  if (typeof ref !== "string") return null;
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const type = ref.slice(0, at);
  const slug = ref.slice(at + 1);
  if (type === "kind" && KIND_SLUG.test(slug)) return { type, slug };
  if (type === "skill" && isSpaceSkillSlug(slug)) return { type, slug };
  return null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate ONE declared item. A human-readable reason, or `null` when it is
 * well-formed. The pod's write door and the catalog validator both call this,
 * so author time and install time cannot disagree.
 */
export function validateGuidanceDeclaration(item: unknown): string | null {
  if (!isRecord(item)) return "a guidance item must be an object: { ref }";
  const known = new Set(["ref", "label", "when", "where"]);
  const extra = Object.keys(item).filter((k) => !known.has(k));
  if (extra.length > 0) {
    return `a guidance item takes only ref, label, when and where (got ${extra.join(", ")})`;
  }
  const ref = parseGuidanceRef(item.ref);
  if (!ref) {
    return `\`${String(item.ref ?? "")}\` is not a guidance ref: write kind:<kind slug> (kind:brand-voice-guide) or skill:<skill slug> (skill:creative-director). A ref names a kind or a skill, never an id`;
  }
  for (const [key, max] of [
    ["label", LABEL_MAX],
    ["when", WHEN_MAX],
  ] as const) {
    const v = item[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) {
      return `a guidance item's \`${key}\` must be non-empty text`;
    }
    if (v.length > max) {
      return `a guidance item's \`${key}\` is at most ${max} characters`;
    }
  }
  if (item.where !== undefined) {
    if (ref.type !== "kind") {
      return "`where` filters the entities of a kind: only a kind:<slug> ref takes it";
    }
    if (!isRecord(item.where)) {
      return '`where` must be an object: { "<property slug>": ["value", ...] }';
    }
    const keys = Object.keys(item.where);
    if (keys.length === 0 || keys.length > WHERE_MAX_KEYS) {
      return `\`where\` names 1 to ${WHERE_MAX_KEYS} properties`;
    }
    for (const k of keys) {
      if (!KIND_SLUG.test(k))
        return `\`where\` key \`${k}\` is not a property slug`;
      const values = item.where[k];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > WHERE_MAX_VALUES ||
        !values.every((v) => typeof v === "string" && v.length > 0)
      ) {
        return `\`where.${k}\` must list 1 to ${WHERE_MAX_VALUES} non-empty values`;
      }
    }
  }
  return null;
}

/** The identity of a declared item: its ref plus its filter. */
function declarationKey(item: GuidanceDeclaration): string {
  return canonicalJson({ ref: item.ref, where: item.where });
}

/**
 * Validate a whole declared list: every item, at most
 * {@link MAX_GUIDANCE_ITEMS}, and no item repeated (same ref, same `where`).
 * `index` is the offending item's position, `-1` for the list itself.
 */
export function validateGuidanceList(
  list: unknown
): Array<{ index: number; message: string }> {
  if (!Array.isArray(list)) {
    return [{ index: -1, message: "guidance must be a list of { ref } items" }];
  }
  const issues: Array<{ index: number; message: string }> = [];
  if (list.length > MAX_GUIDANCE_ITEMS) {
    issues.push({
      index: -1,
      message: `a playbook declares at most ${MAX_GUIDANCE_ITEMS} guidance items`,
    });
  }
  const seen = new Set<string>();
  list.forEach((item, index) => {
    const reason = validateGuidanceDeclaration(item);
    if (reason) {
      issues.push({ index, message: reason });
      return;
    }
    const key = declarationKey(item as GuidanceDeclaration);
    if (seen.has(key)) {
      issues.push({
        index,
        message: `guidance repeats ${(item as GuidanceDeclaration).ref} with the same filter`,
      });
    }
    seen.add(key);
  });
  return issues;
}

// ─── Resolved items (what the pod's loader hands the renderer) ───────────────

/** One property of a rendered entity. */
export interface GuidanceField {
  /** The property slug. */
  key: string;
  /** Its label as the kind declares it. */
  label: string;
  /** Its value, already as text. */
  value: string;
  /** Its declared display order (ties break on `key`). */
  position: number;
}

/** One current version: an entity of a kind, or a skill. */
export interface GuidanceRow {
  id: string;
  title: string;
  /** The version the record carries, when it has one. */
  version: string | null;
  /** A kind's row order (an `order` property); `null` when unordered. */
  order: number | null;
  fields: GuidanceField[];
  /** A skill's prose. */
  body?: string;
  /** Set when a trial override rendered this row in place of another id. */
  replaces?: string;
}

/** A declared item, resolved by the pod. */
export interface ResolvedGuidance {
  declaration: GuidanceDeclaration;
  /** The current versions; empty when none is current. */
  rows: GuidanceRow[];
  /** Why nothing renders for it ("no approved version yet"). */
  missingReason?: string;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** What a run used: recorded in the run's definition snapshot. */
export interface GuidanceUsed {
  ref: string;
  label: string;
  /** Content hash of the item (its declaration and current rows). */
  hash: string;
  rows: Array<{ id: string; version: string | null; replaces?: string }>;
}

export interface GuidanceLeftOut {
  ref: string;
  label: string;
  /** Over the budget: how the agent loads it. Not available: why. */
  reason: string;
}

export interface RenderedGuidance {
  /** The section; "" when the playbook declares no guidance. */
  text: string;
  /** cyrb53 of `text`; `null` when there is no section. */
  hash: string | null;
  /** The items rendered in full, in declared order. */
  used: GuidanceUsed[];
  /** Items left out to stay within the budget (named in the section). */
  demoted: Array<GuidanceLeftOut & { hash: string }>;
  /** Items with no current version (named in the section). */
  missing: GuidanceLeftOut[];
  /** Estimated tokens of the heading plus the rendered items. */
  tokens: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A kind or skill slug as words: the last path segment, through the one door. */
function humanize(slug: string): string {
  return humanizeToken(slug.split("/").pop() ?? slug) || slug;
}

function canonicalRows(rows: GuidanceRow[]): GuidanceRow[] {
  return rows
    .map((r) => ({
      ...r,
      title: r.title.trim(),
      body: r.body?.trim() || undefined,
      fields: r.fields
        .map((f) => ({ ...f, value: f.value.trim() }))
        .filter((f) => f.value.length > 0)
        .sort((a, b) => a.position - b.position || cmp(a.key, b.key)),
    }))
    .sort(
      (a, b) =>
        (a.order ?? Number.POSITIVE_INFINITY) -
          (b.order ?? Number.POSITIVE_INFINITY) ||
        cmp(a.title, b.title) ||
        cmp(a.id, b.id)
    );
}

function labelOf(item: ResolvedGuidance, rows: GuidanceRow[]): string {
  const declared = item.declaration.label?.trim();
  if (declared) return declared;
  const ref = parseGuidanceRef(item.declaration.ref);
  if (ref?.type === "skill" && rows.length === 1 && rows[0]!.title) {
    return rows[0]!.title;
  }
  return humanize(ref?.slug ?? item.declaration.ref);
}

const versionTag = (r: GuidanceRow) => (r.version ? ` (v${r.version})` : "");

function fieldLines(fields: GuidanceField[], indent: string): string[] {
  return fields.map((f) => {
    const [first, ...rest] = f.value.split("\n");
    return [
      `${indent}- ${f.label}: ${first}`,
      ...rest.map((l) => `${indent}  ${l}`),
    ].join("\n");
  });
}

function renderItem(
  label: string,
  when: string | undefined,
  rows: GuidanceRow[]
): string {
  const ordered = rows.some((r) => r.order !== null);
  const lines: string[] = [];
  if (rows.length === 1 && !ordered) {
    const r = rows[0]!;
    lines.push(
      `### ${label}${r.title && r.title !== label ? ` · ${r.title}` : ""}${versionTag(r)}`
    );
    if (when) lines.push(`When: ${when}`);
    lines.push(...fieldLines(r.fields, ""));
    if (r.body) lines.push(r.body);
    return lines.join("\n");
  }
  lines.push(`### ${label}`);
  if (when) lines.push(`When: ${when}`);
  if (ordered) lines.push(GUIDANCE_ORDERED_SENTENCE);
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title || r.id}${versionTag(r)}`);
    lines.push(...fieldLines(r.fields, "   "));
    if (r.body) lines.push(...r.body.split("\n").map((l) => `   ${l}`));
  });
  return lines.join("\n");
}

function loadHint(ref: GuidanceRef | null, rows: GuidanceRow[]): string {
  if (ref?.type === "skill") return `load it with synap_load_skill ${ref.slug}`;
  return `load it with synap_get_entity ${rows.map((r) => r.id).join(", ")}`;
}

/**
 * THE renderer of a playbook's guidance. Items render in DECLARED order, each
 * whole or not at all; an item that does not fit the remaining budget is left
 * out and named with how to load it (a later, smaller item may still fit). An
 * item with no current version is named as not available. The budget counts
 * the heading and the rendered items; the closing "left out" lines are a few
 * tokens each and are not counted.
 *
 * Deterministic: rows sort by `order`, then title, then id; fields by declared
 * position, then key. The same items in any row or field order give the same
 * bytes and the same hashes.
 */
export function renderGuidance(
  items: readonly ResolvedGuidance[],
  budget: number = GUIDANCE_BUDGET_TOKENS
): RenderedGuidance {
  const empty: RenderedGuidance = {
    text: "",
    hash: null,
    used: [],
    demoted: [],
    missing: [],
    tokens: 0,
  };
  if (items.length === 0) return empty;

  const blocks: string[] = [];
  const used: GuidanceUsed[] = [];
  const demoted: RenderedGuidance["demoted"] = [];
  const missing: GuidanceLeftOut[] = [];
  let tokens = estimateSkillTokens(GUIDANCE_HEADING);

  for (const item of items) {
    const rows = canonicalRows(item.rows);
    const label = labelOf(item, rows);
    const ref = item.declaration.ref;
    if (rows.length === 0) {
      missing.push({
        ref,
        label,
        reason: item.missingReason ?? "no approved version yet",
      });
      continue;
    }
    const when = item.declaration.when?.trim() || undefined;
    const hash = cyrb53(canonicalJson({ declaration: item.declaration, rows }));
    const block = renderItem(label, when, rows);
    // +2 for the blank line joining the block to the previous one.
    const cost = estimateSkillTokens(`\n\n${block}`);
    if (tokens + cost > budget) {
      demoted.push({
        ref,
        label,
        hash,
        reason: loadHint(parseGuidanceRef(ref), rows),
      });
      continue;
    }
    tokens += cost;
    blocks.push(block);
    used.push({
      ref,
      label,
      hash,
      rows: rows.map((r) => ({
        id: r.id,
        version: r.version,
        ...(r.replaces ? { replaces: r.replaces } : {}),
      })),
    });
  }

  const sections = [GUIDANCE_HEADING, ...blocks];
  if (demoted.length > 0) {
    sections.push(
      `Left out to stay within the budget:\n${demoted
        .map((d) => `- ${d.label} (${d.ref}): ${d.reason}`)
        .join("\n")}`
    );
  }
  if (missing.length > 0) {
    sections.push(
      `Not available:\n${missing
        .map((m) => `- ${m.label} (${m.ref}): ${m.reason}`)
        .join("\n")}`
    );
  }
  const text = sections.join("\n\n");
  return { text, hash: cyrb53(text), used, demoted, missing, tokens };
}

/**
 * The section a door renders when the guidance could not be READ — never an
 * empty section, which would read as "this playbook follows no rules".
 */
export function guidanceUnavailableText(error: string): string {
  return `${GUIDANCE_HEADING}\nThe rules this playbook follows could not be loaded (${error}). Ask the person before relying on a house style.`;
}

/** What a run records in its definition snapshot under `guidance`. */
export type GuidanceSnapshot =
  | {
      status: "ok";
      hash: string | null;
      used: GuidanceUsed[];
      demoted: RenderedGuidance["demoted"];
      missing: GuidanceLeftOut[];
    }
  | { status: "unavailable"; error: string };

export function guidanceSnapshotOf(
  rendered: RenderedGuidance
): GuidanceSnapshot {
  return {
    status: "ok",
    hash: rendered.hash,
    used: rendered.used,
    demoted: rendered.demoted,
    missing: rendered.missing,
  };
}
