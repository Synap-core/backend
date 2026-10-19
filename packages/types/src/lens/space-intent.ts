/**
 * OBJECT-FIRST HOMES — the pure models of a home's space cards and its
 * "Moving now" rows (homes plan §3), shared by the web (`@synap-core/web/
 * lens-page` `SpaceIntentCard` / `KindBar` / `MovingNowRow`) and relay
 * (`relay-app/src/components/lens/`). The reads are `lifecycle.home` and
 * `lifecycle.moving`; these models only turn their wire into words, tones
 * and doors — one derivation, so the phone and the desktop say the same.
 *
 *   Product · Dev
 *   Features                                 2 in pipeline · 1 done this week
 *   ▬▬▬▬ ▬▬ ▬ ▬▬▬                            ← `kindBarSegments` (ONE bar rule)
 *   ● Pinned surfaces · Building · Being worked     ← the headline line
 *
 * The input types are structural (this package never imports the API's wire),
 * so a pod that sends more fields still fits.
 */
import type { UnitStateInput, UnitTone } from "../units/state.js";
import {
  lifecycleOptionTone,
  type LifecycleCategory,
} from "../lifecycle/option.js";
import {
  pluralizeNoun,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveStatusLabel,
  sentenceCaseLabel,
} from "../vocabulary/index.js";
import { decodeHtmlEntities } from "../text/html-entities.js";
import { formatKpiFraction, lensCountDoorText, type LensKpiFact } from "./header.js";
import { lensIntentDoorText } from "./intent.js";
import type { LensBeingWorked, LensRow } from "./rows.js";
import type { LensSource } from "./scope.js";

// ── The kind bar: ONE rule for every one-line pipeline ──────────────────────

/** A pipeline column as the bar reads it (`lifecycle.home` / a board glance). */
export interface KindBarColumn {
  key: string;
  label: string;
  /** null = the unclassified column (things whose status is no option). */
  category: LifecycleCategory | null;
  count: number;
  /** The option's own tone, when the read carries it; else its category's. */
  tone?: UnitTone;
}

export interface KindBarSegment {
  key: string;
  label: string;
  tone: UnitTone;
  /** The segment's share of the bar (its count). */
  weight: number;
}

/**
 * A column's tone — THE option tone rule (`lifecycleOptionTone`: its authored
 * tone when a real token, else its category's); `warning` for the
 * unclassified column (no category: things whose status is no option).
 */
export function kindColumnTone(
  column: Pick<KindBarColumn, "category" | "tone">
): UnitTone {
  return column.category
    ? lifecycleOptionTone({ category: column.category, tone: column.tone })
    : "warning";
}

/**
 * THE one-line pipeline bar: the columns in option order, each a segment
 * weighted by its count in its column's tone (`kindColumnTone`).
 * An empty column draws no segment; an all-empty pipeline draws no bar ([]).
 */
export function kindBarSegments(
  columns: readonly KindBarColumn[]
): KindBarSegment[] {
  return columns
    .filter((c) => c.count > 0)
    .map((c) => ({
      key: c.key,
      label: c.label,
      tone: kindColumnTone(c),
      weight: c.count,
    }));
}

/** The bar, spoken: "Idea 5, Draft 2, Published 6". */
export function kindBarA11y(segments: readonly KindBarSegment[]): string {
  return segments.map((s) => `${s.label} ${s.weight}`).join(", ");
}

// ── A space card ─────────────────────────────────────────────────────────────

export type SpaceHeadlineReason =
  "needs_you" | "being_worked" | "stuck" | "recent";

/** One produced kind of a space, as `lifecycle.home` sends it. */
export interface SpaceProducedKindInput {
  profileSlug: string;
  label: string;
  plural: string;
  live: number;
  total: number;
  doneWindowed: number;
  windowDays: number;
  columns: readonly KindBarColumn[];
  needsYou: number | null;
  beingWorked: number | null;
  headline: {
    entityId: string;
    title: string | null;
    status: string | null;
    reason: SpaceHeadlineReason;
  } | null;
}

/** One space of `lifecycle.home`. */
export interface SpaceIntentInput {
  workspaceId: string;
  name: string;
  label: string;
  source: "template" | "inferred";
  kind: "producing" | "library";
  produces: readonly SpaceProducedKindInput[];
}

/** One produced kind's row on a space card — a door to that kind's surface. */
export interface SpaceKindRowModel {
  profileSlug: string;
  workspaceId: string;
  /** The kind, plural ("Features"). */
  title: string;
  segments: KindBarSegment[];
  /** "2 / 5 clients" (a goal), else "2 in pipeline · 1 done this week"; null = nothing to say. */
  fact: string | null;
  /** Needs-you on this kind when > 0 (the mark's count); null = none or unknown. */
  owed: number | null;
  /** The needs-you read FAILED: draw the unknown mark ("–"), never calm nothing. */
  owedUnknown: boolean;
  /** The being-worked read FAILED (unknown, not zero). */
  workUnknown: boolean;
  /** The row's spoken name: title, needs-you, the bar, the fact. */
  a11y: string;
}

/** The ONE thing a card names, with its mark. */
export interface SpaceHeadlineModel {
  entityId: string;
  profileSlug: string;
  reason: SpaceHeadlineReason;
  /** "Pinned surfaces · Building · Being worked". */
  text: string;
  /** The mark's state (the shared unit state); null = no mark (a recent move). */
  state: UnitStateInput | null;
}

export interface SpaceIntentCardModel {
  workspaceId: string;
  /** "Product · Dev"; one word when the label IS the name ("Content"). */
  title: string;
  library: boolean;
  kinds: SpaceKindRowModel[];
  headline: SpaceHeadlineModel | null;
}

/** "Product · Dev" — collapsed to one word when the purpose IS the name. */
export function spaceIntentTitle(
  space: Pick<SpaceIntentInput, "label" | "name">
): string {
  const label = space.label.trim();
  const name = space.name.trim();
  if (!label || label.toLowerCase() === name.toLowerCase())
    return name || label;
  return `${label} · ${name}`;
}

/** A headline's urgency: lower is louder (the read's own pick order). */
const HEADLINE_RANK: Record<SpaceHeadlineReason, number> = {
  needs_you: 0,
  being_worked: 1,
  stuck: 2,
  recent: 3,
};

/** The mark a headline wears — the shared unit state, never a hand-picked tone. */
const HEADLINE_STATE: Record<SpaceHeadlineReason, UnitStateInput | null> = {
  needs_you: { owedFromYou: 1 },
  being_worked: { running: true },
  stuck: { idle: true },
  recent: null,
};

function kindFact(
  kind: SpaceProducedKindInput,
  goal: LensKpiFact | null | undefined
): string | null {
  if (goal && goal.current !== null) {
    return formatKpiFraction(goal.current, goal.target, goal.unit);
  }
  const parts = [
    kind.live > 0 ? lensIntentDoorText("pipeline", kind.live) : null,
    kind.doneWindowed > 0
      ? lensIntentDoorText("produced", kind.doneWindowed, kind.windowDays)
      : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function headlineOf(space: SpaceIntentInput): SpaceHeadlineModel | null {
  let best: { kind: SpaceProducedKindInput; rank: number } | null = null;
  for (const kind of space.produces) {
    if (!kind.headline) continue;
    const rank = HEADLINE_RANK[kind.headline.reason];
    if (!best || rank < best.rank) best = { kind, rank };
  }
  if (!best) return null;
  const { kind } = best;
  const h = kind.headline!;
  const statusLabel = h.status
    ? (kind.columns.find((c) => c.key === h.status)?.label ??
      resolveStatusLabel(h.status))
    : null;
  const text = [
    // A row stored before the write doors decoded (`&amp;`) reads as `&`.
    decodeHtmlEntities(h.title ?? "").trim() ||
      resolveObjectNoun(kind.profileSlug),
    statusLabel,
    // A recent move says nothing the status does not; the others name why.
    h.reason === "recent" ? null : resolveStatusLabel(h.reason),
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
  return {
    entityId: h.entityId,
    profileSlug: kind.profileSlug,
    reason: h.reason,
    text,
    state: HEADLINE_STATE[h.reason],
  };
}

/**
 * ONE space of a home as its card: the title, one bar row per produced kind
 * (in the space's `produces` order — the read's), and the headline (the
 * loudest of its kinds' headlines; ties keep `produces` order). `goals`
 * carries a kind's stated goal (a track KPI) by profile slug, when the host
 * has one: it outranks the live/done words as the row's fact.
 */
export function spaceIntentCardModel(
  space: SpaceIntentInput,
  goals?: Readonly<Record<string, LensKpiFact | null | undefined>>
): SpaceIntentCardModel {
  const kinds = space.produces.map((kind): SpaceKindRowModel => {
    const segments = kindBarSegments(kind.columns);
    const fact = kindFact(kind, goals?.[kind.profileSlug]);
    const owed =
      typeof kind.needsYou === "number" && kind.needsYou > 0
        ? kind.needsYou
        : null;
    // Sentence case, like every other row title: a profile's stored plural
    // ("decisions") never sits lower-case beside "Features".
    const title = sentenceCaseLabel(kind.plural) || kind.label;
    return {
      profileSlug: kind.profileSlug,
      workspaceId: space.workspaceId,
      title,
      segments,
      fact,
      owed,
      owedUnknown: kind.needsYou === null,
      workUnknown: kind.beingWorked === null,
      a11y: [
        title,
        owed !== null ? lensIntentDoorText("blocking", owed) : null,
        segments.length > 0 ? kindBarA11y(segments) : null,
        fact,
      ]
        .filter(Boolean)
        .join(", "),
    };
  });
  return {
    workspaceId: space.workspaceId,
    title: spaceIntentTitle(space),
    library: space.kind === "library",
    kinds,
    headline: headlineOf(space),
  };
}

/** A home's spaces, split: producing cards (read order) and library chips. */
export function homeSpacesModel(
  spaces: readonly SpaceIntentInput[],
  goals?: Readonly<Record<string, LensKpiFact | null | undefined>>
): {
  cards: SpaceIntentCardModel[];
  library: Array<{ workspaceId: string; title: string }>;
} {
  const cards: SpaceIntentCardModel[] = [];
  const library: Array<{ workspaceId: string; title: string }> = [];
  for (const space of spaces) {
    if (space.kind === "library" || space.produces.length === 0) {
      library.push({
        workspaceId: space.workspaceId,
        title: spaceIntentTitle(space),
      });
    } else {
      cards.push(spaceIntentCardModel(space, goals));
    }
  }
  return { cards, library };
}

/**
 * A PROJECT's "What this project is making" (board D2, projects as places):
 * ONE card per produced kind that holds something in the project
 * (`total > 0` — the read is already narrowed to it), across every space,
 * each card naming its space in its title. A kind with nothing in the project
 * is not something the project makes. One rule for the desktop project page
 * and the relay project page (was browser-local `projectMakingCards`).
 */
export function projectMakingCards(
  spaces: readonly SpaceIntentInput[],
  goals?: Readonly<Record<string, LensKpiFact | null | undefined>>
): SpaceIntentCardModel[] {
  const cards: SpaceIntentCardModel[] = [];
  for (const space of spaces) {
    for (const kind of space.produces) {
      if (kind.total <= 0) continue;
      cards.push(spaceIntentCardModel({ ...space, produces: [kind] }, goals));
    }
  }
  return cards;
}

/**
 * The home's needs-you line — "3 need you · Content 2 · Sales 1" — grouped by
 * space (largest first), each part a door to that space. A zero total OMITS
 * the line (null); an unknown total keeps it, marked "–" (failed ≠ empty).
 * Spaces whose count is unknown or zero are left out of the parts.
 *
 * A capped count says so (ui-composition §11): `truncated` — the pod's own
 * flag off `signals.count`, on the total and on each space — reads "N+"
 * ("100+ need you · Content 60+"), and `floor` tells a renderer drawing the
 * number itself. Absent (an older pod) reads as exact.
 */
export function homeNeedsYouModel(
  needsYou: {
    total: number | null;
    truncated?: boolean | null;
    bySpace: ReadonlyArray<{
      workspaceId: string;
      count: number | null;
      truncated?: boolean | null;
    }>;
  },
  spaces: ReadonlyArray<
    Pick<SpaceIntentInput, "workspaceId" | "label" | "name">
  >
): {
  total: number | null;
  /** `total` is a lower bound — draw "N+". */
  floor: boolean;
  text: string;
  parts: Array<{
    workspaceId: string;
    label: string;
    count: number;
    /** `count` is a lower bound. */
    floor: boolean;
    /** "60" / "60+" — the part's number as the line says it. */
    countText: string;
  }>;
} | null {
  if (needsYou.total === 0) return null;
  const labelOf = new Map(
    spaces.map((s) => [s.workspaceId, s.label.trim() || s.name])
  );
  const parts = needsYou.bySpace
    .filter(
      (b): b is { workspaceId: string; count: number; truncated?: boolean | null } =>
        typeof b.count === "number" && b.count > 0
    )
    .map((b) => {
      const floor = b.truncated === true;
      return {
        workspaceId: b.workspaceId,
        label: labelOf.get(b.workspaceId) ?? "",
        count: b.count,
        floor,
        countText: floor ? `${b.count}+` : `${b.count}`,
      };
    })
    .filter((p) => p.label !== "")
    .sort((a, b) => b.count - a.count);
  const floor = needsYou.total !== null && needsYou.truncated === true;
  const head = lensCountDoorText("blocking", needsYou.total, floor);
  return {
    total: needsYou.total,
    floor,
    text: [head, ...parts.map((p) => `${p.label} ${p.countText}`)].join(" · "),
    parts,
  };
}

// ── Moving now ───────────────────────────────────────────────────────────────

export type MovingWorkKind = "session" | "worker" | "scheduled";

/** One thing with open work on it, as `lifecycle.moving` sends it. */
export interface MovingItemInput {
  entityId: string;
  title: string | null;
  profileSlug: string | null;
  workspaceId: string | null;
  status: string | null;
  category: string | null;
  work: ReadonlyArray<{
    kind: MovingWorkKind;
    sessionId: string;
    label: string;
    actor?: string;
    live: boolean;
    asksYou: boolean;
    since: string;
  }>;
}

/** One work line under a moving thing — a door to its session. */
export interface MovingWorkLineModel {
  key: string;
  sessionId: string;
  kind: MovingWorkKind;
  /** "Build: pin a pipeline · Claude Code · Asks you". */
  text: string;
  /** The line's mark (asks you ⇒ needs you; live ⇒ working; else quiet). */
  state: UnitStateInput;
  asksYou: boolean;
  live: boolean;
  since: string;
}

export interface MovingNowRowModel {
  /** THE lens row (`AttentionRow`): the thing, its status as the reason. */
  row: LensRow;
  /** The being-worked mark (a live work line), or null. */
  beingWorked: LensBeingWorked | null;
  /** The work under it, as the read ordered it. */
  work: MovingWorkLineModel[];
  asksYou: boolean;
}

/**
 * ONE thing of "Moving now" as a lens row + its work lines.
 *
 * The row is the THING (opens the thing): its title, its status as the
 * reason, its space as the source. Its class follows its work: any work that
 * asks you ⇒ Blocking (the needs-you mark); any live ⇒ Happening; else the
 * quiet Happened row. `kindLabel` names the kind ("Feature") when the host
 * knows it from the home read; else the vocabulary's noun for the slug.
 * The age is the longest-running work's start.
 */
export function movingNowRowModel(
  item: MovingItemInput,
  opts: { spaceName?: string | null; kindLabel?: string | null } = {}
): MovingNowRowModel {
  const work = item.work.map((w): MovingWorkLineModel => {
    const state: UnitStateInput = w.asksYou
      ? { owedFromYou: 1 }
      : w.live
        ? { running: true }
        : { idle: true };
    return {
      key: `${w.kind}:${w.sessionId}`,
      sessionId: w.sessionId,
      kind: w.kind,
      text: [
        w.label.trim() || resolveObjectNoun("session"),
        w.actor?.trim() || null,
        w.asksYou ? resolveStatusLabel("asks_you") : null,
      ]
        .filter((p): p is string => Boolean(p))
        .join(" · "),
      state,
      asksYou: w.asksYou,
      live: w.live,
      since: w.since,
    };
  });
  const asksYou = work.some((w) => w.asksYou);
  const liveLine = item.work.find((w) => w.live);
  const oldest = item.work
    .map((w) => w.since)
    .filter(Boolean)
    .sort()[0];
  const kindWord =
    opts.kindLabel?.trim() ||
    (item.profileSlug ? resolveObjectNoun(item.profileSlug) : null);
  const statusWord = item.status ? resolveStatusLabel(item.status) : null;
  const state: UnitStateInput = asksYou
    ? { owedFromYou: work.filter((w) => w.asksYou).length }
    : liveLine
      ? { running: true }
      : { idle: true };
  const source: LensSource | null =
    item.workspaceId && opts.spaceName?.trim()
      ? {
          kind: "workspace",
          id: item.workspaceId,
          label: opts.spaceName.trim(),
        }
      : null;
  return {
    row: {
      key: item.entityId,
      cls: asksYou ? "blocking" : liveLine ? "happening" : "happened",
      state,
      objectKind: item.profileSlug ?? "entity",
      // A row stored before the write doors decoded (`&amp;`) reads as `&`.
      title:
        decodeHtmlEntities(item.title ?? "").trim() ||
        kindWord ||
        resolveObjectNoun("entity"),
      reason: [kindWord, statusWord].filter(Boolean).join(" · ") || null,
      repeat: null,
      source,
      occurredAt: oldest ?? null,
      verb: null,
      door: { kind: "entity", id: item.entityId },
      count: 1,
    },
    beingWorked: liveLine
      ? { by: liveLine.actor ?? null, sessionId: liveLine.sessionId }
      : null,
    work,
    asksYou,
  };
}

/** An open work session with no subject yet, as `lifecycle.moving` sends it (`unattached`). */
export interface UnattachedLineInput {
  sessionId: string;
  label: string;
  actor?: string;
  live: boolean;
  asksYou: boolean;
  since: string;
  /**
   * The SESSION's own space; null = none. Absent = a pod older than the field
   * (homes A7 wire) — its space is unknown, so space counts become unknown.
   */
  workspaceId?: string | null;
}

/**
 * At most this many subjectless sessions ride a `lifecycle.moving` answer
 * (`min(limit, cap)`) — a nudge, not a session list. The pod reads it from here.
 */
export const MOVING_UNATTACHED_CAP = 10;

/** The words of a subjectless session's row (homes A7) — one copy, both apps. */
export const UNATTACHED_TITLE = "No thing yet";
export const UNATTACHED_INVITE = "attach one";

/**
 * A session working on NO thing yet, as a "Moving now" row (homes A7):
 * "No thing yet · attach one", with the session as its one work line. The
 * mark and class follow the line exactly as a thing's row does (asks you ⇒
 * Blocking, live ⇒ Happening, else Happened — `movingNowRowModel`). The row's
 * door is the SESSION, where the subject is set (there is no server-side
 * set-subject door yet).
 */
export function unattachedRowModel(
  line: UnattachedLineInput
): MovingNowRowModel {
  const m = movingNowRowModel({
    entityId: line.sessionId,
    title: null,
    profileSlug: null,
    workspaceId: null,
    status: null,
    category: null,
    work: [{ kind: "session", ...line }],
  });
  return {
    ...m,
    row: {
      ...m.row,
      key: `unattached:${line.sessionId}`,
      objectKind: "session",
      title: UNATTACHED_TITLE,
      reason: UNATTACHED_INVITE,
      door: { kind: "session", id: line.sessionId },
    },
  };
}

/**
 * THE "Moving now" list: the things (`items`, as the read ordered them) and
 * the sessions on no thing yet (`unattached`), merged so a row that asks you
 * is never below a calmer one — asks you, then live, then each read's own
 * order (things before subjectless sessions within a tier). A cap over this
 * list never buries a session that asks you under quieter things.
 */
export function movingNowRows(
  items: readonly MovingItemInput[],
  unattached: readonly UnattachedLineInput[],
  rowOf: (item: MovingItemInput) => MovingNowRowModel
): MovingNowRowModel[] {
  const tier = (m: MovingNowRowModel) =>
    m.asksYou ? 0 : m.beingWorked ? 1 : 2;
  return [...items.map(rowOf), ...unattached.map(unattachedRowModel)]
    .map((row, i) => ({ row, i }))
    .sort((a, b) => tier(a.row) - tier(b.row) || a.i - b.i)
    .map(({ row }) => row);
}

// ── The joins around the rows (ONE rule for browser and relay) ──────────────
//
// Moving now and a space home join two reads: `lifecycle.moving` (the things)
// and `lifecycle.home` (the spaces and their produced kinds). Each join below
// is decided ONCE here; the hosts only draw what comes back.

/** The space a home read holds, or null (not visible / gone / no read). */
function spaceIn(
  spaces: readonly SpaceIntentInput[] | null | undefined,
  workspaceId: string | null | undefined
): SpaceIntentInput | null {
  if (!spaces || !workspaceId) return null;
  return spaces.find((s) => s.workspaceId === workspaceId) ?? null;
}

/**
 * A kind's word ("Feature"): the produced kind's own label, read from ONE
 * space when given one, else from the first space of a home read (read
 * order) that produces it; else the vocabulary's noun for the slug.
 */
export function kindLabelOf(
  source: SpaceIntentInput | readonly SpaceIntentInput[] | null | undefined,
  profileSlug: string
): string {
  const spaces: readonly SpaceIntentInput[] = !source
    ? []
    : Array.isArray(source)
      ? source
      : [source as SpaceIntentInput];
  for (const space of spaces) {
    const label = space.produces
      .find((k) => k.profileSlug === profileSlug)
      ?.label.trim();
    if (label) return label;
  }
  return resolveObjectNoun(profileSlug);
}

/**
 * A moving row's SOURCE word: its space's title (`spaceIntentTitle`, "Product
 * · Dev" — the same words as that space's card), or null when the row's space
 * is unknown to the home read or the list is already narrowed to it.
 */
export function movingRowSpaceWord(
  item: Pick<MovingItemInput, "workspaceId">,
  spaces: readonly SpaceIntentInput[] | null | undefined,
  filteredTo: string | null = null
): string | null {
  if (!item.workspaceId || item.workspaceId === filteredTo) return null;
  const space = spaceIn(spaces, item.workspaceId);
  return space ? spaceIntentTitle(space) : null;
}

/**
 * What `movingNowRowModel` needs beyond the item: its space word and its
 * kind's label — the kind as ITS OWN space names it (a kind produced by two
 * spaces keeps each space's word), else the home read's, else the vocabulary.
 */
export function movingNowRowOpts(
  item: Pick<MovingItemInput, "workspaceId" | "profileSlug">,
  spaces: readonly SpaceIntentInput[] | null | undefined,
  filteredTo: string | null = null
): { spaceName: string | null; kindLabel: string | null } {
  const own = spaceIn(spaces, item.workspaceId);
  return {
    spaceName: movingRowSpaceWord(item, spaces, filteredTo),
    kindLabel: item.profileSlug
      ? kindLabelOf(
          own?.produces.some((k) => k.profileSlug === item.profileSlug)
            ? own
            : spaces,
          item.profileSlug
        )
      : null,
  };
}

/** One "Moving now" space filter chip — a door that narrows the read SERVER-side. */
export interface MovingSpaceChip {
  workspaceId: string;
  /** `spaceIntentTitle` — the words of the space's card and of its rows' source. */
  title: string;
  /** Things moving in this space; null = unknown (the read failed or was capped). */
  count: number | null;
}

/**
 * THE "Moving now" space chips.
 *
 *   - Which: every PRODUCING space of the home read, plus any other space a
 *     moving thing OR a subjectless session sits in; a space the home read
 *     does not hold gets no chip (no title to give it). When the counts are
 *     known, a space with nothing moving is left out (a chip is a door; an
 *     empty list is no place to go).
 *   - Order: the home read's (producing first, busiest first) — stable, so a
 *     chip never jumps when the list narrows.
 *   - Counts: from `items` + `unattached`, the UNNARROWED moving read of the
 *     same scope (pod or project) — the rows the narrowed list will draw.
 *     `items === null` (failed / loading), a read that hit its `limit`, an
 *     unattached list at its cap (a count would be a floor shown as a total)
 *     or an unattached line with no `workspaceId` (an older pod: its space is
 *     unknown) makes EVERY count null — unknown, never 0. `total` likewise,
 *     except that a line's missing space does not make the total unknown.
 *
 * `spaces === null` (no home read) ⇒ no chips: a chip without its space's
 * words is not drawable.
 */
export function movingSpaceChips(
  items: readonly Pick<MovingItemInput, "workspaceId">[] | null,
  spaces: readonly SpaceIntentInput[] | null | undefined,
  opts: {
    limit?: number;
    /**
     * The same read's subjectless sessions: they are rows of the list, so
     * "All" counts them, and each counts in its SESSION's space (a space
     * whose only work is unattached still gets its chip). A list at its cap
     * (`min(limit, MOVING_UNATTACHED_CAP)`) makes every count unknown.
     */
    unattached?: readonly Pick<UnattachedLineInput, "workspaceId">[];
  } = {}
): { total: number | null; chips: MovingSpaceChip[] } {
  const loose = opts.unattached ?? [];
  const looseCap =
    opts.limit === undefined
      ? MOVING_UNATTACHED_CAP
      : Math.min(opts.limit, MOVING_UNATTACHED_CAP);
  const totalKnown =
    items !== null &&
    (opts.limit === undefined || items.length < opts.limit) &&
    loose.length < looseCap;
  const known = totalKnown && loose.every((l) => l.workspaceId !== undefined);
  const counts = new Map<string, number>();
  for (const row of [...(items ?? []), ...loose]) {
    if (row.workspaceId)
      counts.set(row.workspaceId, (counts.get(row.workspaceId) ?? 0) + 1);
  }
  const chips: MovingSpaceChip[] = [];
  for (const space of spaces ?? []) {
    const producing = space.kind === "producing" && space.produces.length > 0;
    const n = counts.get(space.workspaceId) ?? 0;
    if (known ? n === 0 : !producing && n === 0) continue;
    chips.push({
      workspaceId: space.workspaceId,
      title: spaceIntentTitle(space),
      count: known ? n : null,
    });
  }
  return { total: totalKnown ? items!.length + loose.length : null, chips };
}

/** A profile as a space's "Also here" reads it (`profiles.list`). */
export interface AlsoHereProfileInput {
  slug: string;
  name: string;
  /** The profile's own plural, when it declares one. */
  plural?: string | null;
  workspaceId: string | null;
  profileKind: "kind" | "role";
}

/** One "Also here" chip — a door to that kind's list NARROWED to the space. */
export interface AlsoHereChip {
  profileSlug: string;
  /** Plural ("Notes"): the profile's own, else the vocabulary's. */
  title: string;
  count: number;
  /** The door's scope: the kind list narrowed to THIS space (count = destination). */
  workspaceId: string;
}

/**
 * THE "Also here" / "Also in <space>" rule: the kinds DECLARED in this space
 * (its own profiles — never a pod-wide or system kind, never a role) that it
 * does not produce, holding at least one thing IN this space — most first.
 * `counts` = things per profile slug in this space (`entities.countByProfileAll
 * ({workspaceId})`); null (that read failed) ⇒ null, never an empty row.
 * Each chip's door is the kind list narrowed to the space, so the count and
 * the list it opens agree.
 */
export function alsoInKinds(
  space: Pick<SpaceIntentInput, "workspaceId" | "produces">,
  profiles: readonly AlsoHereProfileInput[],
  counts: Readonly<Record<string, number>> | null
): AlsoHereChip[] | null {
  if (counts === null) return null;
  const produced = new Set(space.produces.map((k) => k.profileSlug));
  const seen = new Set<string>();
  const out: AlsoHereChip[] = [];
  for (const p of profiles) {
    if (
      p.workspaceId !== space.workspaceId ||
      p.profileKind !== "kind" ||
      produced.has(p.slug) ||
      seen.has(p.slug)
    )
      continue;
    const count = counts[p.slug] ?? 0;
    if (count <= 0) continue;
    seen.add(p.slug);
    out.push({
      profileSlug: p.slug,
      // The profile's own words keep their deliberate casing ("UI designs"),
      // sentence-cased like every title ("decisions" → "Decisions"); only a
      // nameless profile falls back to the slug's vocabulary noun.
      title: sentenceCaseLabel(
        p.plural?.trim() ||
          (p.name.trim()
            ? pluralizeNoun(p.name)
            : resolveObjectNounPlural(p.slug))
      ),
      count,
      workspaceId: space.workspaceId,
    });
  }
  return out.sort(
    (a, b) => b.count - a.count || a.title.localeCompare(b.title)
  );
}
