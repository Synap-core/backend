/**
 * Workspace-identity fingerprinting — PURE.
 * =========================================
 *
 * 11 of 14 live workspaces carry no template identity: `settings.packageSlug`
 * null, `settings.workspaceSubtype` null, no `workspaceCapabilities`. The boot
 * reconciler (`reconcile-workspaces-to-templates.ts`) keys convergence on that
 * very field, so an unstamped workspace is PERMANENTLY invisible to it — the
 * field that identifies it is the field that is missing. Template fixes are
 * forward-only and reach zero existing workspaces.
 *
 * This module derives a candidate identity from evidence the workspace already
 * carries. It NEVER writes and NEVER touches the database: it maps
 * (workspace observation × template corpus) → verdict + the evidence for it.
 * `backfill-workspace-identity.ts` owns the read and the (gated) write.
 *
 * ⚠️ THE GOVERNING RULE — "never stamp a marker you did not earn"
 * (`.claude/rules/backend-rules.md`). A mis-identified workspace gets the WRONG
 * template reconciled onto it: profiles, properties and views it should not
 * have, additively and irreversibly. That is strictly worse than the status
 * quo, in which nothing converges. So this matcher is deliberately biased to
 * UNKNOWN: a candidate must EARN the UNAMBIGUOUS verdict, and every input that
 * fed the verdict is reported alongside it.
 *
 * EVIDENCE, strongest first
 * -------------------------
 *  1. PROFILE-SLUG FINGERPRINT (primary). A template declares a profile set;
 *     a workspace binds one. Two ratios, both load-bearing:
 *       • coverage    = |matched| / |template's profiles|  — how much of the
 *         template the workspace actually has.
 *       • distinctive = matched slugs declared by EXACTLY ONE template in the
 *         corpus. This is what makes the signal near-unique: `devplane_*` is
 *         declared only by `builder-workspace` (21 of its 25 profiles are
 *         corpus-unique), whereas `crm` has ZERO distinctive slugs because
 *         `business-developer` and `networking` are supersets of it — which is
 *         precisely why a bare CRM-shaped workspace must come back AMBIGUOUS
 *         and never be stamped.
 *  2. NAME (corroborating only). A workspace name is user-editable and freely
 *     typed, so it can confirm a profile match but can never carry one alone.
 *  3. `sourceRoles` (corroborating only). Present on Foundation/Radar; a
 *     template declares its own. Same standing as the name.
 *  4. `systemSlug` — an ANTI-signal. A system workspace ("pod-admin") has a
 *     real identity that is not a template; it is reported and never stamped.
 *
 * REJECTED as evidence
 * --------------------
 *  • `settings.appId` — null on every live row; carries nothing.
 *  • `settings.packageSlug` — that is the value being DERIVED; using it would
 *    be circular (the backfill skips any workspace that already has one).
 *  • view / bento names — authored from the same YAML as the profiles, so they
 *    add no INDEPENDENT signal while inflating an already-decided score.
 *  • entity counts / property values — expensive and not identifying; the
 *    count is reported for operator context only, never scored.
 *  • `createdAt` ordering — not evidence of anything.
 *
 * IDENTITY KEY = TEMPLATE SLUG, NOT SUBTYPE. `workspaceSubtype` is NOT
 * injective over the corpus: `crm` is the subtype of three templates (crm,
 * business-developer, networking), `research-base` of three, `brand-library`
 * / `ecosystem` / `operations` of two each — and 10 of 30 templates have a
 * subtype that differs from their slug (`builder-workspace` → "builder").
 * `WORKSPACE_TEMPLATES` and `cp_catalog_cache` are both keyed by SLUG, so the
 * slug is the only value that round-trips back to a template. A match
 * therefore reports both: the slug to key resolution on, and the subtype the
 * template itself declares.
 */

/**
 * The NEVER-OVERWRITE guard, as a pure predicate.
 *
 * Returns the identity a workspace ALREADY carries, or undefined. Any of the
 * three is enough: the JSONB `settings.packageSlug`, its promoted
 * `package_slug` column (migration 0039 — dual-written by
 * `WorkspaceRepository.mergeSettings`), or `settings.workspaceSubtype`. The
 * backfill applies this BEFORE scoring, so an identified workspace is never
 * even a candidate — which is both the "never overwrite" guarantee and the
 * reason a second run stamps nothing: the first run's own write makes the row
 * fail this predicate.
 */
export function existingTemplateIdentity(row: {
  settings?: { packageSlug?: string; workspaceSubtype?: string } | null;
  packageSlug?: string | null;
}): string | undefined {
  return (
    row.settings?.packageSlug ??
    row.packageSlug ??
    row.settings?.workspaceSubtype ??
    undefined
  );
}

/** One template, reduced to what the matcher scores. */
export interface TemplateFingerprint {
  /** `meta.slug` — the key `resolveWorkspaceTemplate` / `cp_catalog_cache` use. */
  slug: string;
  /** `workspace.subtype` as the template declares it (may equal the slug, may differ, may be absent). */
  subtype?: string;
  /** `meta.name` and `workspace.name`, normalized. */
  names: string[];
  /** Declared profile slugs. */
  profileSlugs: string[];
  /** Declared `workspace.sourceRoles`. */
  sourceRoles?: Record<string, string>;
}

/** What the backfill reads off one live workspace row. */
export interface WorkspaceObservation {
  id: string;
  name: string;
  /** Profiles BOUND to this workspace: workspace-scoped rows + shared rows granted to it. */
  profileSlugs: string[];
  /** `settings.sourceRoles`, when present. */
  sourceRoles?: Record<string, string>;
  /** `system_slug` column / `settings.systemSlug` — an anti-signal. */
  systemSlug?: string;
  /** Reported for operator context; never scored. */
  entityCount?: number;
}

export interface CandidateEvidence {
  slug: string;
  subtype?: string;
  /** How many profiles the template declares (the coverage denominator). */
  templateProfileCount: number;
  /** Profile slugs the workspace and the template share. */
  matched: string[];
  /** Of `matched`, those declared by exactly ONE template in the corpus. */
  distinctiveMatched: string[];
  /** |matched| / |template profiles| — how much of the template is present. */
  coverage: number;
  /** |matched| / |workspace profiles| — how much of the workspace the template explains. */
  specificity: number;
  nameMatch: boolean;
  sourceRolesMatch: boolean;
  /** Whether this candidate cleared the strong-evidence bar. */
  strong: boolean;
}

export type IdentityVerdict = "UNAMBIGUOUS" | "AMBIGUOUS" | "UNKNOWN";

export interface IdentityMatch {
  workspaceId: string;
  workspaceName: string;
  entityCount?: number;
  verdict: IdentityVerdict;
  /** Human-readable justification — printed by the diagnostic and logged by the stamp. */
  reason: string;
  /** The single earned match. Present ONLY when verdict is UNAMBIGUOUS. */
  match?: { slug: string; subtype?: string };
  /** Every candidate with any evidence at all, strongest first. */
  candidates: CandidateEvidence[];
}

/**
 * The strong-evidence bar. Two ways to clear it, both requiring the primary
 * (profile) signal — corroboration can lower the distinctive-count requirement
 * but can never substitute for coverage.
 */
const MIN_COVERAGE = 0.6;
const MIN_DISTINCTIVE = 3;
const CORROBORATED_MIN_COVERAGE = 0.8;
const CORROBORATED_MIN_DISTINCTIVE = 1;

/** The ONE name-normalizer — the corpus adapter and the matcher must agree. */
export const normalizeName = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

function sameSourceRoles(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  if (!a || !b) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length === 0 || ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * Reduce a template corpus to fingerprints, computing corpus-relative
 * distinctiveness in the same pass (a slug is distinctive iff exactly one
 * template in THIS corpus declares it — so the notion is always relative to
 * the candidate set actually being matched against, never a hardcoded list).
 *
 * Templates declaring NO profiles are dropped: `base` is an operational
 * overlay the reconciler applies to every workspace regardless of identity
 * (see its own docstring), so it is not any workspace's identity and a
 * zero-profile template would otherwise match everything with coverage 0/0.
 */
export function buildTemplateFingerprints(templates: TemplateFingerprint[]): {
  fingerprints: TemplateFingerprint[];
  distinctiveSlugs: Set<string>;
} {
  const fingerprints = templates.filter((t) => t.profileSlugs.length > 0);
  const counts = new Map<string, number>();
  for (const t of fingerprints) {
    for (const slug of new Set(t.profileSlugs)) {
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  const distinctiveSlugs = new Set(
    [...counts.entries()].filter(([, n]) => n === 1).map(([slug]) => slug)
  );
  return { fingerprints, distinctiveSlugs };
}

/**
 * Score one workspace against the corpus. Pure — no I/O, no clock, no DB.
 */
export function matchWorkspaceIdentity(
  ws: WorkspaceObservation,
  corpus: { fingerprints: TemplateFingerprint[]; distinctiveSlugs: Set<string> }
): IdentityMatch {
  const base = {
    workspaceId: ws.id,
    workspaceName: ws.name,
    entityCount: ws.entityCount,
  };

  // A system workspace's identity is its systemSlug, not a template. Report it
  // and stop — inferring a template for `pod-admin` would be exactly the
  // unearned stamp this module exists to prevent.
  if (ws.systemSlug) {
    return {
      ...base,
      verdict: "UNKNOWN",
      reason: `system workspace (systemSlug="${ws.systemSlug}") — its identity is not a template`,
      candidates: [],
    };
  }

  const wsSlugs = new Set(ws.profileSlugs);
  const wsNames = new Set([normalizeName(ws.name)]);

  const candidates: CandidateEvidence[] = [];
  for (const tpl of corpus.fingerprints) {
    const tplSlugs = [...new Set(tpl.profileSlugs)];
    const matched = tplSlugs.filter((s) => wsSlugs.has(s));
    const nameMatch = tpl.names.some((n) => wsNames.has(n));
    const sourceRolesMatch = sameSourceRoles(ws.sourceRoles, tpl.sourceRoles);

    if (matched.length === 0 && !nameMatch && !sourceRolesMatch) continue;

    const distinctiveMatched = matched.filter((s) =>
      corpus.distinctiveSlugs.has(s)
    );
    const coverage = matched.length / tplSlugs.length;
    const specificity = wsSlugs.size === 0 ? 0 : matched.length / wsSlugs.size;

    const strong =
      (coverage >= MIN_COVERAGE &&
        distinctiveMatched.length >= MIN_DISTINCTIVE) ||
      (coverage >= CORROBORATED_MIN_COVERAGE &&
        distinctiveMatched.length >= CORROBORATED_MIN_DISTINCTIVE &&
        (nameMatch || sourceRolesMatch));

    candidates.push({
      slug: tpl.slug,
      subtype: tpl.subtype,
      templateProfileCount: tplSlugs.length,
      matched,
      distinctiveMatched,
      coverage,
      specificity,
      nameMatch,
      sourceRolesMatch,
      strong,
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.strong) - Number(a.strong) ||
      b.distinctiveMatched.length - a.distinctiveMatched.length ||
      b.coverage - a.coverage ||
      a.slug.localeCompare(b.slug)
  );

  const strongOnes = candidates.filter((c) => c.strong);

  if (strongOnes.length === 1) {
    const w = strongOnes[0]!;
    return {
      ...base,
      verdict: "UNAMBIGUOUS",
      reason:
        `${w.slug}: ${w.matched.length}/${w.templateProfileCount} template profiles present ` +
        `(coverage=${w.coverage.toFixed(2)}, ${w.distinctiveMatched.length} corpus-unique: ` +
        `${w.distinctiveMatched.slice(0, 5).join(", ")}${w.distinctiveMatched.length > 5 ? ", …" : ""}), ` +
        `nameMatch=${w.nameMatch}, sourceRolesMatch=${w.sourceRolesMatch}`,
      match: { slug: w.slug, subtype: w.subtype },
      candidates,
    };
  }

  if (strongOnes.length > 1) {
    return {
      ...base,
      verdict: "AMBIGUOUS",
      reason: `${strongOnes.length} templates clear the strong-evidence bar (${strongOnes
        .map((c) => c.slug)
        .join(", ")}) — refusing to guess`,
      candidates,
    };
  }

  if (candidates.length > 0) {
    return {
      ...base,
      verdict: "UNKNOWN",
      reason: `${candidates.length} candidate(s) with partial evidence, none clearing the strong bar (best: ${candidates[0]!.slug} coverage=${candidates[0]!.coverage.toFixed(2)} distinctive=${candidates[0]!.distinctiveMatched.length})`,
      candidates,
    };
  }

  return {
    ...base,
    verdict: "UNKNOWN",
    reason:
      "no template shares a profile, a name, or a sourceRoles map with this workspace",
    candidates: [],
  };
}
