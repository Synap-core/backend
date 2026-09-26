/**
 * Derive marketplace search tokens from a package definition.
 *
 * `rankByTerms` (pod `catalog-cache-query.ts`) scores `tags` as `secondary`.
 * The list-view catalog cache omits `definition`, so tokens the comparator
 * can see on the definition MUST land in `tags[]` at publish time — never a
 * `searchText` column, never a fat list body.
 *
 * Keep in lockstep with
 * `synap-control-plane-api/src/seeds/package-search-tokens.ts`.
 */

const MAX_TOKEN_LEN = 32;

/** Goal-word stopwords — overlap the ranker so we don't inflate tag density. */
const GOAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "than",
  "that",
  "the",
  "then",
  "this",
  "to",
  "with",
  "you",
  "your",
  "we",
  "our",
  "they",
  "them",
  "their",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeToken(raw: string): string | null {
  const token = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!token) return null;
  if (token.length > MAX_TOKEN_LEN) return token.slice(0, MAX_TOKEN_LEN);
  return token;
}

function pushToken(out: string[], value: string | null | undefined): void {
  if (!value) return;
  const token = normalizeToken(value);
  if (token) out.push(token);
}

/** Split a hyphen/underscore/dot slug into parts ≥ 3 chars; keep the whole slug. */
function pushSlug(out: string[], value: string | null | undefined): void {
  if (!value) return;
  pushToken(out, value);
  for (const part of value.split(/[-_.]+/)) {
    if (part.length >= 3) pushToken(out, part);
  }
}

/** Keep a short phrase as one tag; also split into words for substring ranking. */
function pushPhrase(out: string[], value: string | null | undefined): void {
  if (!value) return;
  pushToken(out, value);
  pushGoalWords(out, value);
}

function pushGoalWords(out: string[], value: string | null | undefined): void {
  if (!value) return;
  for (const word of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3) continue;
    if (GOAL_STOPWORDS.has(word)) continue;
    pushToken(out, word);
  }
}

function dedupeStable(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** `track-template` | `work-template` — derived from a playbook's `scope`. */
export function templateKindToken(scope: unknown): string {
  return scope === "project" ? "track-template" : "work-template";
}

function collectPlaybooks(out: string[], playbooks: unknown): void {
  for (const item of asArray(playbooks)) {
    const pb = asRecord(item);
    if (!pb) continue;
    pushPhrase(out, str(pb.name));
    pushGoalWords(out, str(pb.goal) ?? str(pb.goalTemplate));
    // The DERIVED template kind (W3b): `scope: "project"` is a track template,
    // anything else a work template — never declared by the author. Lets
    // `market.search "track template"` find a package that ships a method.
    // Same rule as the CP list projection `packageItemsSql`.
    pushToken(out, templateKindToken(pb.scope));
  }
}

function collectCapabilities(out: string[], capabilities: unknown): void {
  for (const item of asArray(capabilities)) {
    if (typeof item === "string") {
      pushSlug(out, item);
      continue;
    }
    const cap = asRecord(item);
    if (!cap) continue;
    pushSlug(out, str(cap.templateKey));
    pushSlug(out, str(cap.key));
    pushPhrase(out, str(cap.name));
  }
}

/**
 * Tokens derived from the definition fields `rankByTerms` cannot see on the
 * list cache: dependency slugs/names, playbook names/goals, capability
 * keys, plus `meta.tags` / `meta.domain`.
 */
export function derivePackageSearchTokens(
  definition: unknown,
  extras?: { domain?: string | null }
): string[] {
  const def = asRecord(definition) ?? {};
  const meta = asRecord(def.meta) ?? asRecord(def._meta) ?? {};
  const out: string[] = [];

  for (const tag of asArray(meta.tags)) {
    if (typeof tag === "string") pushToken(out, tag);
  }
  pushToken(out, extras?.domain ?? null);
  pushToken(out, str(meta.domain));
  pushToken(out, str(def.domain));

  for (const item of asArray(def.dependencies)) {
    const dep = asRecord(item);
    if (!dep) continue;
    pushSlug(out, str(dep.slug));
    pushPhrase(out, str(dep.name));
  }

  collectPlaybooks(out, def.playbooks);
  collectCapabilities(out, def.capabilities);
  // YAML source uses `integrations[].templateKey`; the converter renames it.
  collectCapabilities(out, def.integrations);

  const capability = asRecord(def.capability);
  if (capability) {
    pushSlug(out, str(capability.key));
    pushPhrase(out, str(capability.name));
    collectPlaybooks(out, capability.playbooks);
  }

  const workspace = asRecord(def.workspace);
  if (workspace) {
    collectCapabilities(out, workspace.capabilities);
  }

  return dedupeStable(out);
}

/**
 * Authored tags first (stable), then derived tokens. Case-insensitive dedupe.
 * `existing` is the publisher's `tags` (and, at cache-sync, the CP list tags).
 */
export function mergePackageSearchTags(
  existing: readonly string[] | null | undefined,
  definition: unknown,
  extras?: { domain?: string | null }
): string[] {
  const authored: string[] = [];
  for (const tag of existing ?? []) {
    if (typeof tag === "string") pushToken(authored, tag);
  }
  const derived = derivePackageSearchTokens(definition, extras);
  return dedupeStable([...authored, ...derived]);
}

export function tagsEqual(
  a: readonly string[] | null | undefined,
  b: readonly string[]
): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((tag, i) => tag === b[i]);
}
