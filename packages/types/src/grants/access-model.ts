/**
 * The access model — per tier (read / change / approve), WHAT a holder may
 * touch and WHERE, and the ONE sentence that says it (access model B, founder
 * decision of 2 Nov 2026, plan 2c8fca91 §1).
 *
 * The question is always per verb: "for this verb, where?". A holder's access
 * is a set of PARTS, each a gate (what its permissions match) and a `Place`
 * (`./reach.ts`, parsed once). A tier's reach is computed from the parts that
 * reach it, so "create people in Sales + read notes in Finance" says it
 * changes people in Sales only, and "change notes in Sales + read decisions
 * pod-wide" says the pod-wide read: one `where` for the whole sentence
 * overstated the first and hid the second.
 *
 * `describeAccess` writes the sentence every surface shows: the holder header
 * (`resolveHolderAccess`), the connect card, an app's sign-in and its
 * consent. Place words come from the vocabulary door (`resolvePlacePhrase`).
 *
 * Pure: no I/O.
 */

import {
  nounInSentence,
  resolvePlaceLabel,
  resolvePlacePhrase,
  sentenceCaseLabel,
} from "../vocabulary/index.js";
import { GRANT_SUBJECT_CATALOG, type GrantSubjectSpec } from "./catalog.js";
import { isFullAccess, type GrantDraft } from "./draft.js";
import { patternMatches, type GrantRequest } from "./grammar.js";
import {
  joinPlaces,
  parsePlace,
  placeCovers,
  placeKey,
  type Place,
  type PlaceHolder,
} from "./reach.js";
import {
  GRANT_FULL_ACCESS_SENTENCE,
  summarizeGrant,
  type GrantSummary,
  type GrantSummaryRow,
} from "./summary.js";

export type AccessTier = "read" | "change" | "approve";
export const ACCESS_TIERS: readonly AccessTier[] = [
  "read",
  "change",
  "approve",
];

/** What a tier reaches in one place: catalog labels ("Notes"), or "all". */
export interface TierReach {
  readonly labels: readonly string[] | "all";
  readonly place: Place;
}

/** One part of a holder's access: what it may do, and where. */
export interface AccessPart {
  readonly can: (req: GrantRequest) => boolean;
  /** A `*` part: every subject and every decision. */
  readonly full: boolean;
  readonly place: Place;
}

export interface AccessModel {
  /** `other` alone (patterns no catalog row names) still makes it limited. */
  readonly state: "nothing" | "limited" | "full";
  /** Where full access holds (state `full`); null otherwise. */
  readonly fullPlace: Place | null;
  /**
   * Per tier, each place it reaches and what there — widest place first,
   * labels a wider place already covers left out. Empty = it cannot.
   */
  readonly tiers: Readonly<Record<AccessTier, readonly TierReach[]>>;
  /** Every place a part reaches, in part order (the holder's `where`). */
  readonly places: readonly Place[];
}

export const HOLDER_EVERYTHING = "Everything";
export const HOLDER_NOTHING = "Nothing";
export const HOLDER_NO_ACCESS_SENTENCE = "No access yet";

const CHANGE_ACTIONS = ["create", "update", "delete"] as const;

/** Does any of these patterns grant the request? A malformed one grants nothing. */
export function permissionsMatch(
  permissions: readonly string[],
  req: GrantRequest
): boolean {
  return permissions.some((p) => {
    try {
      return patternMatches(p, req);
    } catch {
      return false;
    }
  });
}

/** The request a summary row stands for, at one action. */
export const rowRequest = (
  row: GrantSummaryRow,
  action: string
): GrantRequest => ({
  subject: row.subject,
  qualifier: row.kind === null || row.kind === "*" ? null : row.kind,
  action,
});

const top = (subject: string, action: string): GrantRequest => ({
  subject,
  qualifier: null,
  action,
});

/** One tier's labels from the candidate rows: a kind row hides under its subject's every-kind row. */
export function tierLabels(
  rows: readonly GrantSummaryRow[],
  test: (row: GrantSummaryRow) => boolean
): string[] | null {
  const hit = rows.filter(test);
  const covered = new Set(
    hit.filter((r) => r.kind === "*").map((r) => r.subject)
  );
  const labels: string[] = [];
  for (const r of hit) {
    if (r.kind !== null && r.kind !== "*" && covered.has(r.subject)) continue;
    if (!labels.includes(r.label)) labels.push(r.label);
  }
  return labels.length > 0 ? labels : null;
}

/** What one gate reaches in each tier: "all", its labels, or null (nothing). */
export function tierReachOf(
  can: (req: GrantRequest) => boolean,
  full: boolean,
  rows: readonly GrantSummaryRow[],
  catalog: readonly GrantSubjectSpec[]
): Record<AccessTier, readonly string[] | "all" | null> {
  const readAll = catalog.every((s) => can(top(s.subject, "read")));
  const changeAll = catalog.every((s) =>
    s.actions.filter((a) => a !== "read").every((a) => can(top(s.subject, a)))
  );
  return {
    read: readAll ? "all" : tierLabels(rows, (r) => can(rowRequest(r, "read"))),
    change: changeAll
      ? "all"
      : tierLabels(rows, (r) =>
          CHANGE_ACTIONS.some((a) => can(rowRequest(r, a)))
        ),
    approve: full
      ? "all"
      : tierLabels(rows, (r) => can(rowRequest(r, "approve"))),
  };
}

/** The candidate rows of a set of summaries, each once, in order. */
export function candidateRows(
  summaries: readonly GrantSummary[]
): GrantSummaryRow[] {
  const out: GrantSummaryRow[] = [];
  for (const s of summaries)
    for (const r of s.rows) if (!out.some((c) => c.key === r.key)) out.push(r);
  return out;
}

/**
 * The model of a set of parts. Parts in the same place act as one (their
 * gates are joined), so a place's tier is "all" when its parts together cover
 * the catalog. A label a wider place already reaches is left out of the
 * narrower one ("reads decisions everywhere in your pod" covers decisions in
 * Sales); places with the same labels join ("notes in Sales and Finance").
 */
export function accessModelOfParts(
  parts: readonly AccessPart[],
  opts: {
    readonly summaries: readonly GrantSummary[];
    readonly catalog?: readonly GrantSubjectSpec[];
  }
): AccessModel {
  const catalog = opts.catalog ?? GRANT_SUBJECT_CATALOG;
  const rows = candidateRows(opts.summaries);
  const other = opts.summaries.some((s) => s.other.length > 0);

  // Parts by place, gates joined.
  const byPlace = new Map<string, { place: Place; parts: AccessPart[] }>();
  for (const p of parts) {
    const k = placeKey(p.place);
    const group = byPlace.get(k) ?? { place: p.place, parts: [] };
    group.parts.push(p);
    byPlace.set(k, group);
  }
  const groups = [...byPlace.values()].map((g) => ({
    place: g.place,
    full: g.parts.some((p) => p.full),
    reach: tierReachOf(
      (req) => g.parts.some((p) => p.can(req)),
      g.parts.some((p) => p.full),
      rows,
      catalog
    ),
  }));

  const fullGroups = groups.filter((g) => g.full);
  const fullPlace =
    fullGroups.length > 0
      ? fullGroups.map((g) => g.place).reduce(joinPlaces)
      : null;

  const tier = (t: AccessTier): TierReach[] => {
    const entries = groups
      .flatMap((g) => {
        const labels = g.reach[t];
        return labels === null ? [] : [{ place: g.place, labels }];
      })
      .map((e, _i, all) => {
        // Leave out what a strictly wider place already reaches.
        const wider = all.filter(
          (f) =>
            f !== e &&
            placeCovers(f.place, e.place) &&
            placeKey(f.place) !== placeKey(e.place)
        );
        if (wider.some((f) => f.labels === "all")) return null;
        if (e.labels === "all") return e;
        const kept = e.labels.filter(
          (l) => !wider.some((f) => f.labels !== "all" && f.labels.includes(l))
        );
        return kept.length > 0 ? { place: e.place, labels: kept } : null;
      })
      .filter((e): e is TierReach => e !== null);
    // Places that reach the same labels read as one place.
    const merged: TierReach[] = [];
    for (const e of entries) {
      const same = merged.findIndex(
        (m) =>
          m.place.kind === "spaces" &&
          e.place.kind === "spaces" &&
          sameLabels(m.labels, e.labels)
      );
      if (same >= 0)
        merged[same] = {
          place: joinPlaces(merged[same]!.place, e.place),
          labels: merged[same]!.labels,
        };
      else merged.push(e);
    }
    const width = { unbounded: 0, pod: 1, spaces: 2 } as const;
    return merged.sort((a, b) => width[a.place.kind] - width[b.place.kind]);
  };

  const tiers = {
    read: tier("read"),
    change: tier("change"),
    approve: tier("approve"),
  };
  const state: AccessModel["state"] =
    fullPlace !== null
      ? "full"
      : tiers.read.length + tiers.change.length + tiers.approve.length > 0 ||
          other
        ? "limited"
        : "nothing";
  return {
    state,
    fullPlace,
    tiers,
    places: groups.map((g) => g.place),
  };
}

function sameLabels(
  a: readonly string[] | "all",
  b: readonly string[] | "all"
): boolean {
  if (a === "all" || b === "all") return a === b;
  return a.length === b.length && a.every((l) => b.includes(l));
}

/**
 * THE access model of a set of grants: one part per grant, its place parsed
 * for this holder (`parsePlace`). An AI's capability ceiling and a key's
 * narrowing compose parts the same way (`resolveHolderAccess`).
 */
export function accessModel(
  grants: readonly GrantDraft[],
  holder: PlaceHolder,
  opts: {
    readonly catalog?: readonly GrantSubjectSpec[];
    readonly kindNames?: Readonly<Record<string, string>>;
  } = {}
): AccessModel {
  return accessModelOfParts(
    grants.map((g) => ({
      can: (req) => permissionsMatch(g.permissions, req),
      full: isFullAccess(g),
      place: parsePlace(g, holder),
    })),
    {
      catalog: opts.catalog,
      summaries: grants.map((g) =>
        summarizeGrant(g, { kindNames: opts.kindNames, catalog: opts.catalog })
      ),
    }
  );
}

function and(parts: readonly string[]): string {
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
    : (parts[0] ?? "");
}

/**
 * A tier's labels inside a sentence: nouns mid-sentence ("notes and people"),
 * never the listed labels' capitals ("Notes, People").
 */
export function tierPhrase(labels: readonly string[] | "all"): string {
  return labels === "all"
    ? HOLDER_EVERYTHING.toLowerCase()
    : and(labels.map(nounInSentence));
}

/**
 * A tier's value beside its label ("Can read  Notes and people"): one
 * phrase, nouns mid-sentence after the first word.
 */
export function tierValue(labels: readonly string[] | null): string | null {
  return labels ? sentenceCaseLabel(and(labels.map(nounInSentence))) : null;
}

/** One place of a tier, in words. */
export interface TierPlace {
  /** "notes and people" / "everything". */
  readonly what: string;
  /** The place as a chip: "Everywhere in your pod", "Sales and Finance". */
  readonly where: string;
  readonly place: Place;
}

export interface AccessDescription {
  /**
   * The ONE access sentence, ending with a period: "Reads decisions
   * everywhere in your pod; changes notes in Sales." When every tier holds in
   * one place it is said once, at the end ("Reads notes, changes notes in
   * Sales."), and not at all when that place is anywhere you can reach.
   */
  readonly sentence: string;
  readonly tiers: Readonly<Record<AccessTier, readonly TierPlace[]>>;
}

const VERBS: Readonly<Record<AccessTier, string>> = {
  read: "Reads",
  change: "changes",
  approve: "approves",
};

/** The sentence and the tiers' places of a model, in the vocabulary's words. */
export function describeAccess(
  model: AccessModel,
  opts: { readonly names?: Readonly<Record<string, string>> } = {}
): AccessDescription {
  const names = opts.names;
  const tiers = {
    read: model.tiers.read.map((r) => tierPlace(r, names)),
    change: model.tiers.change.map((r) => tierPlace(r, names)),
    approve: model.tiers.approve.map((r) => tierPlace(r, names)),
  };
  const out = (sentence: string): AccessDescription => ({
    sentence: `${sentence}.`,
    tiers,
  });
  if (model.state === "nothing") return out(HOLDER_NO_ACCESS_SENTENCE);
  if (model.state === "full") {
    const where =
      model.fullPlace && model.fullPlace.kind !== "unbounded"
        ? ` ${resolvePlacePhrase(model.fullPlace, names)}`
        : "";
    return out(`${GRANT_FULL_ACCESS_SENTENCE}${where}`);
  }
  const said = ACCESS_TIERS.filter(
    (t) => t === "read" || model.tiers[t].length > 0
  );
  const places = new Map<string, Place>();
  for (const t of said)
    for (const r of model.tiers[t]) places.set(placeKey(r.place), r.place);
  const verb = (t: AccessTier) => VERBS[t];
  if (places.size <= 1) {
    const [place] = [...places.values()];
    const what = said
      .map((t) => {
        const [r] = model.tiers[t];
        return `${verb(t)} ${r ? tierPhrase(r.labels) : HOLDER_NOTHING.toLowerCase()}`;
      })
      .join(", ");
    const where =
      place && place.kind !== "unbounded"
        ? ` ${resolvePlacePhrase(place, names)}`
        : "";
    return out(`${what}${where}`);
  }
  return out(
    said
      .map((t) => {
        const reach = model.tiers[t];
        if (reach.length === 0)
          return `${verb(t)} ${HOLDER_NOTHING.toLowerCase()}`;
        return `${verb(t)} ${reach
          .map(
            (r) =>
              `${tierPhrase(r.labels)} ${resolvePlacePhrase(r.place, names)}`
          )
          .join(" and ")}`;
      })
      .join("; ")
  );
}

function tierPlace(
  r: TierReach,
  names: Readonly<Record<string, string>> | undefined
): TierPlace {
  return {
    what: tierPhrase(r.labels),
    where: resolvePlaceLabel(r.place, names),
    place: r.place,
  };
}
