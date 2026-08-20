/**
 * Intent classification for the WRITE side of the Rule Loop — the sibling of
 * `classify.ts`.
 *
 * `classifySubstrates` routes a QUESTION to the memory substrates that can
 * answer it. This routes a STATEMENT — a rule the user just told the pod — to
 * the SHAPES it implies, so the agent that materialises it knows what it is
 * building before it starts building. A rule is rarely one thing: "when a
 * Calendly event lands, research the prospect and brief me an hour before the
 * call" is a trigger, a schedule and an outward message at once, so this is
 * MULTI-LABEL by construction.
 *
 * The seven shapes:
 *   fact         — knowledge the agent should hold while reasoning. → instruction skill
 *   behaviour    — something that runs when the world changes.      → automation
 *   structure    — a mapping / identity claim ("a subfolder IS a client").
 *   schedule     — recurring or temporal ("every Monday", "an hour before").
 *   notification — an outward message ("tell me", "post to this channel").
 *   extraction   — deriving structured data from unstructured input.
 *   unknown      — could not classify confidently.
 *
 * Same engineering contract as `classify.ts`: a PURE, synchronous function over
 * cheap heuristics — no I/O, no LLM, no network — so it can run on the parse-only
 * fast path and be unit-tested with zero mocks. Matching is WORD-BOUNDARY, not
 * raw substring: "extract" must be the word "extract", not the head of
 * "Extractor Inc"; "index" won't fire on "reindex". And the cue lists avoid bare
 * single-word nouns that collide with this product's own entity vocabulary — a
 * trigger is signalled by a determiner-anchored PHRASE ("when a", "whenever"),
 * never by a lone word that is just as likely a company name.
 *
 * WHERE THE TWO SIBLINGS DIVERGE — the cost of a wrong label is not symmetric.
 * On the read side, over-routing only adds a cheap extra query. Here, a wrong
 * label BUILDS something: mis-reading a one-off request as a standing rule
 * leaves a permanent automation firing forever, and mis-reading a statement of
 * fact as a behaviour does the same. So the biases are:
 *
 *   1. Prefer `needsClarification` to a confident wrong label. When the rule is
 *      genuinely undecidable, or when two readings conflict, we STOP and ask
 *      rather than guess — guessing is worse than asking.
 *   2. Declarative beats executable on a confidence tie (see `PRECEDENCE`).
 *   3. A standing rule must carry an explicit standing marker. "if" alone is not
 *      one — in a rule, "if" almost always qualifies an action that is already
 *      being described ("if the client doesn't exist, create it first"), it does
 *      not declare a trigger. Requiring a temporal/distributive marker is what
 *      keeps a one-line request from becoming a permanent automation.
 *
 * Every fired cue is returned with its shape, so a human reviewing an
 * AI-authored rule can see WHY it routed that way. That is the whole point: an
 * unexplained classification is not reviewable.
 */

export type RuleShape =
  | "fact"
  | "behaviour"
  | "structure"
  | "schedule"
  | "notification"
  | "extraction"
  | "unknown";

/** Every shape that can actually be cued (i.e. all but the `unknown` fallback). */
type ShapeKey = Exclude<RuleShape, "unknown">;

/**
 * Tie-break order: DECLARATIVE before EXECUTABLE.
 *
 * When two shapes score equal, we lead with the one whose materialisation is
 * inert. A fact that should have been an automation is a missing feature the
 * user will notice; an automation that should have been a fact is a process
 * running forever that nobody asked for.
 */
const PRECEDENCE: ShapeKey[] = [
  "structure",
  "fact",
  "behaviour",
  "extraction",
  "notification",
  "schedule",
];

/**
 * One cue: the literal phrase, the confidence it contributes, and whether it is
 * strong enough to EMIT its shape on its own.
 *
 * `emits: false` cues are supporting evidence — they sharpen confidence for a
 * shape something else already established, but can never raise a shape from
 * nothing. That is what lets us keep generic verbs ("create", "update") in the
 * table without them classifying every imperative sentence as a behaviour.
 */
interface CueSpec {
  phrase: string;
  weight: number;
  emits?: boolean;
}

interface CompiledCue extends Required<CueSpec> {
  re: RegExp;
}

/** Compile each cue to a word-boundary regex once. Phrases are lowercase. */
const compileCues = (cues: CueSpec[]): CompiledCue[] =>
  cues.map((c) => ({
    phrase: c.phrase,
    weight: c.weight,
    emits: c.emits !== false,
    re: new RegExp(`\\b${escapeRe(c.phrase)}\\b`),
  }));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * FACT — a statement about how the world already is, with no trigger and no
 * imperative. Cued by possessive / locative phrasings rather than by bare nouns.
 */
const FACT_CUES: CueSpec[] = [
  { phrase: "holds all", weight: 0.5 },
  { phrase: "hold all", weight: 0.5 },
  { phrase: "contains all", weight: 0.5 },
  { phrase: "lives in", weight: 0.5 },
  { phrase: "live in", weight: 0.5 },
  { phrase: "is stored in", weight: 0.5 },
  { phrase: "are stored in", weight: 0.5 },
  { phrase: "is where we", weight: 0.5 },
  { phrase: "we keep", weight: 0.5 },
  { phrase: "we store", weight: 0.5 },
  { phrase: "our company", weight: 0.5 },
  { phrase: "all our", weight: 0.5 },
  { phrase: "is our", weight: 0.4 },
  { phrase: "are our", weight: 0.4 },
  { phrase: "inside it", weight: 0.5 },
  { phrase: "inside the", weight: 0.4 },
  { phrase: "within it", weight: 0.5 },
];

/**
 * BEHAVIOUR — a trigger. Determiner-anchored on purpose: bare "when" appears in
 * plenty of narrative prose ("when we started the Setup project"), while
 * "when a" / "when the" reliably introduces an event.
 */
const BEHAVIOUR_CUES: CueSpec[] = [
  { phrase: "when a", weight: 0.6 },
  { phrase: "when an", weight: 0.6 },
  { phrase: "when the", weight: 0.55 },
  { phrase: "when someone", weight: 0.6 },
  { phrase: "whenever", weight: 0.6 },
  { phrase: "every time", weight: 0.6 },
  { phrase: "each time", weight: 0.6 },
  { phrase: "as soon as", weight: 0.6 },
  { phrase: "upon receiving", weight: 0.6 },
  { phrase: "triggered by", weight: 0.6 },
  { phrase: "on every new", weight: 0.6 },
];

/**
 * Mutation verbs. Supporting-only (`emits: false`) — an imperative alone is a
 * one-shot request, not a rule. These only sharpen a behaviour that a trigger or
 * a distributive quantifier already established, and they double as the
 * "does this trigger actually DO anything" probe below.
 */
const ACTION_VERBS: CueSpec[] = [
  "create",
  "update",
  "attach",
  "index",
  "add",
  "assign",
  "link",
  "enrich",
  "tag",
  "move",
  "archive",
  "post",
  "send",
  "notify",
  "brief",
  "extract",
  "sync",
  "import",
  "ingest",
  "label",
].map((phrase) => ({ phrase, weight: 0.1, emits: false }));

/** Cap on stacked action-verb support, so a long imperative list can't dominate. */
const ACTION_VERB_CAP = 0.3;

/** SCHEDULE — recurrence adverbs. Weekday/interval forms are handled by `DISTRIBUTIVE_RE`. */
const SCHEDULE_CUES: CueSpec[] = [
  { phrase: "daily", weight: 0.6 },
  { phrase: "weekly", weight: 0.6 },
  { phrase: "monthly", weight: 0.6 },
  { phrase: "quarterly", weight: 0.6 },
  { phrase: "yearly", weight: 0.6 },
  { phrase: "annually", weight: 0.6 },
  { phrase: "hourly", weight: 0.6 },
  { phrase: "once a week", weight: 0.6 },
  { phrase: "twice a week", weight: 0.6 },
  { phrase: "on a schedule", weight: 0.6 },
  { phrase: "recurring", weight: 0.5 },
  { phrase: "cron", weight: 0.6 },
  { phrase: "before the deadline", weight: 0.5 },
  { phrase: "at each deadline", weight: 0.6 },
  // NB: bare "deadline" is deliberately NOT a cue. "map the deadlines" is a
  // one-shot research request (corpus rule 4), and "deadline" is just as likely
  // a property name on a grant as it is a temporal marker.
];

/** NOTIFICATION — an outward message. Always a phrase with a recipient or a destination. */
const NOTIFICATION_CUES: CueSpec[] = [
  { phrase: "tell me", weight: 0.6 },
  { phrase: "let me know", weight: 0.6 },
  { phrase: "notify me", weight: 0.6 },
  { phrase: "send me", weight: 0.6 },
  { phrase: "email me", weight: 0.6 },
  { phrase: "message me", weight: 0.6 },
  { phrase: "ping me", weight: 0.6 },
  { phrase: "brief me", weight: 0.6 },
  { phrase: "alert me", weight: 0.6 },
  { phrase: "remind me", weight: 0.6 },
  { phrase: "post to", weight: 0.6 },
  { phrase: "post it to", weight: 0.6 },
  { phrase: "post in", weight: 0.6 },
  { phrase: "drop it in", weight: 0.5 },
  { phrase: "share it with", weight: 0.5 },
];

/** EXTRACTION — deriving structure from unstructured input. */
const EXTRACTION_CUES: CueSpec[] = [
  { phrase: "extract", weight: 0.6 },
  { phrase: "pull out", weight: 0.6 },
  { phrase: "pull the", weight: 0.4 },
  { phrase: "parse", weight: 0.6 },
  { phrase: "scrape", weight: 0.6 },
  { phrase: "pick out", weight: 0.5 },
  { phrase: "read the email and", weight: 0.6 },
  { phrase: "structured data", weight: 0.5 },
];

/**
 * STRUCTURE — a mapping or identity claim. The "already exists / doesn't exist"
 * phrasings matter most: they are the user telling us that identity RESOLUTION
 * must happen before any write, which is exactly the step an agent skips.
 */
const STRUCTURE_CUES: CueSpec[] = [
  { phrase: "belongs to", weight: 0.6 },
  { phrase: "belong to", weight: 0.6 },
  { phrase: "maps to", weight: 0.6 },
  { phrase: "map to", weight: 0.5 },
  { phrase: "corresponds to", weight: 0.6 },
  { phrase: "the same as", weight: 0.5 },
  { phrase: "named after", weight: 0.5 },
  { phrase: "names a", weight: 0.5 },
  { phrase: "names the", weight: 0.5 },
  { phrase: "already exists", weight: 0.5 },
  { phrase: "doesn't exist", weight: 0.5 },
  { phrase: "does not exist", weight: 0.5 },
  { phrase: "attach it to", weight: 0.6 },
  { phrase: "attach them to", weight: 0.6 },
  { phrase: "attached to", weight: 0.5 },
  { phrase: "identifies the", weight: 0.5 },
];

/**
 * ONE-SHOT, strong tier — task FRAMING. These phrases scope the request to now.
 * Strong enough that, if a standing marker ALSO fires, the two readings genuinely
 * conflict and we ask rather than pick.
 */
const ONE_SHOT_FRAMING: CueSpec[] = [
  { phrase: "we're working on", weight: 1 },
  { phrase: "we are working on", weight: 1 },
  { phrase: "i'm working on", weight: 1 },
  { phrase: "i am working on", weight: 1 },
  { phrase: "for now", weight: 1 },
  { phrase: "right now", weight: 1 },
  { phrase: "just this once", weight: 1 },
  { phrase: "one off", weight: 1 },
  { phrase: "one-off", weight: 1 },
];

/**
 * ONE-SHOT, weak tier — analysis verbs and request politeness. Real standing
 * rules contain these all the time ("when a lead lands, research them"), so a
 * standing marker SILENTLY wins over this tier; it never raises a conflict.
 */
const ONE_SHOT_VERBS: CueSpec[] = [
  { phrase: "research", weight: 1 },
  { phrase: "look into", weight: 1 },
  { phrase: "find out", weight: 1 },
  { phrase: "figure out", weight: 1 },
  { phrase: "map the", weight: 1 },
  { phrase: "summarize", weight: 1 },
  { phrase: "draft", weight: 1 },
  { phrase: "investigate", weight: 1 },
  { phrase: "compile a", weight: 1 },
  { phrase: "put together", weight: 1 },
  { phrase: "can you", weight: 1 },
  { phrase: "could you", weight: 1 },
  { phrase: "help me", weight: 1 },
  { phrase: "let's", weight: 1 },
];

/**
 * Nouns naming an external SOURCE of records. Only consulted alongside a
 * holding verb and an emitted `fact` — see `sourceImpliesIngest`.
 */
const SOURCE_NOUNS = new Set([
  "drive",
  "folder",
  "folders",
  "subfolder",
  "subfolders",
  "inbox",
  "mailbox",
  "calendar",
  "channel",
  "bucket",
  "repo",
  "repository",
  "spreadsheet",
  "sheet",
  "database",
  "feed",
  "dropbox",
]);

const HOLDING_RE =
  /\b(?:hold|holds|contain|contains|store|stores|keep|keeps)\b/;

/**
 * "each|every|any <noun>". A TIME noun makes it a schedule ("every Monday"); any
 * other noun makes it a DISTRIBUTIVE quantifier over a population ("each client")
 * — which is a standing rule even with no trigger word, because it is asserted
 * over every current and future member of the set.
 */
const DISTRIBUTIVE_RE = /\b(each|every|any)\s+([a-z]+)/g;

const TIME_NOUNS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "morning",
  "afternoon",
  "evening",
  "night",
  "hour",
  "hours",
  "minute",
  "minutes",
  "quarter",
  "year",
  "weekday",
  "weekend",
]);

/**
 * "time" is excluded from both arms: "every time" / "each time" is already a
 * BEHAVIOUR cue phrase, and letting it fall through would score it as either a
 * schedule or a population.
 */
const DISTRIBUTIVE_SKIP = new Set(["time", "times", "other"]);

/** "an hour before the call", "2 days after submission". */
const OFFSET_RE =
  /\b(?:an?|one|two|three|four|five|\d+)\s+(?:minutes?|hours?|days?|weeks?|months?)\s+(?:before|after|ahead of)\b/;

/** "one folder per client" — the canonical container-to-entity mapping claim. */
const ONE_PER_RE = /\bone\s+[a-z]+\s+per\s+[a-z]+/;

/** "each client has an email address" — an identity ATOM is being declared. */
const IDENTITY_ATTR_RE =
  /\b(?:has|have|carries|carry)\s+(?:an?|one|its own|their own)\s+(?:[a-z]+\s+){0,2}(?:email|address|addresses|id|identifier|number|handle|url|domain|slug)\b/;

const FACT_RE = compileCues(FACT_CUES);
const BEHAVIOUR_RE = compileCues(BEHAVIOUR_CUES);
const SCHEDULE_RE = compileCues(SCHEDULE_CUES);
const NOTIFICATION_RE = compileCues(NOTIFICATION_CUES);
const EXTRACTION_RE = compileCues(EXTRACTION_CUES);
const STRUCTURE_RE = compileCues(STRUCTURE_CUES);
const ACTION_VERB_RE = compileCues(ACTION_VERBS);
const ONE_SHOT_FRAMING_RE = compileCues(ONE_SHOT_FRAMING);
const ONE_SHOT_VERB_RE = compileCues(ONE_SHOT_VERBS);

/**
 * Light, OPTIONAL context the caller may already have loaded. Mirrors the
 * `catalog?` parameter on `classifySubstrates`: it makes runtime-defined
 * vocabulary nameable without this function ever touching a store.
 *
 * Both arms contribute SUPPORTING weight only. A rule naming a connected
 * capability is more likely to be trigger-shaped, and a rule naming a real
 * profile is more likely to be an identity claim — but neither, alone, is
 * evidence that the sentence is a rule at all.
 */
export interface RuleIntentContext {
  /** Slugs / names of capabilities the pod actually has connected. */
  capabilities?: string[];
  /** Profile slugs / display names the pod actually defines (kinds AND roles). */
  profiles?: string[];
}

export interface ShapeMatch {
  shape: RuleShape;
  /** 0–1. Capped at 0.95 — a heuristic never claims certainty. */
  confidence: number;
  /** The literal cues that fired, so a reviewer can see WHY. */
  cues: string[];
}

export interface Clarification {
  /** What is ambiguous, in reviewer-facing terms. */
  reason: string;
  /** The question to put to the user. Downstream renders this as a form. */
  question: string;
}

export interface IntentRoute {
  /** Every implied shape, most confident first. Never empty. */
  shapes: ShapeMatch[];
  /** The lead shape — what the rule most is. `unknown` when nothing cued. */
  primary: RuleShape;
  /**
   * True when the text reads as a ONE-OFF request rather than a standing rule.
   * Materialising one of these as an automation is the expensive mistake this
   * classifier exists to prevent, so it is a first-class output, not a shape.
   */
  oneShot: boolean;
  /** Present when we refuse to guess. Absent when the routing is unambiguous. */
  needsClarification?: Clarification;
}

interface Accumulator {
  weight: number;
  cues: string[];
  emitted: boolean;
}

const CAP = 0.95;

export function classifyRuleIntent(
  rule: string,
  context: RuleIntentContext = {}
): IntentRoute {
  // Curly apostrophes are what a user actually types on a phone; normalizing
  // here is the difference between "doesn't exist" firing and not.
  const normalized = rule.toLowerCase().replace(/[‘’]/g, "'");
  const q = ` ${normalized} `;
  const tokenSet = new Set(tokenize(normalized));

  const acc: Record<ShapeKey, Accumulator> = {
    fact: blank(),
    behaviour: blank(),
    structure: blank(),
    schedule: blank(),
    notification: blank(),
    extraction: blank(),
  };

  const add = (
    shape: ShapeKey,
    phrase: string,
    weight: number,
    emits: boolean
  ) => {
    acc[shape].weight += weight;
    acc[shape].cues.push(phrase);
    if (emits) acc[shape].emitted = true;
  };

  const applyTable = (shape: ShapeKey, table: CompiledCue[]) => {
    for (const cue of table) {
      if (cue.re.test(q)) add(shape, cue.phrase, cue.weight, cue.emits);
    }
  };

  applyTable("fact", FACT_RE);
  applyTable("behaviour", BEHAVIOUR_RE);
  // Only an EXPLICIT trigger phrase ("when a…") makes "a trigger with nothing to
  // run" a coherent complaint. A behaviour inferred from a distributive
  // quantifier or from an external source has no dangling trigger to point at.
  const explicitTrigger = BEHAVIOUR_RE.some((cue) => cue.re.test(q));
  applyTable("schedule", SCHEDULE_RE);
  applyTable("notification", NOTIFICATION_RE);
  applyTable("extraction", EXTRACTION_RE);
  applyTable("structure", STRUCTURE_RE);

  // Action verbs support the behaviour lane, capped so a five-verb sentence
  // doesn't outrank an explicit trigger.
  const firedVerbs = ACTION_VERB_RE.filter((cue) => cue.re.test(q));
  if (firedVerbs.length > 0) {
    const each = Math.min(ACTION_VERB_CAP / firedVerbs.length, 0.1);
    for (const cue of firedVerbs) add("behaviour", cue.phrase, each, false);
  }

  // "each|every|any <noun>" — time noun ⇒ schedule, anything else ⇒ a standing
  // assertion over a population.
  for (const m of normalized.matchAll(DISTRIBUTIVE_RE)) {
    const [, quantifier, noun] = m;
    if (!noun || DISTRIBUTIVE_SKIP.has(noun)) continue;
    if (TIME_NOUNS.has(noun))
      add("schedule", `${quantifier} ${noun}`, 0.6, true);
    else add("behaviour", `${quantifier} ${noun}`, 0.4, true);
  }

  if (OFFSET_RE.test(q)) {
    add(
      "schedule",
      OFFSET_RE.exec(q)?.[0]?.trim() ?? "relative offset",
      0.6,
      true
    );
  }
  if (ONE_PER_RE.test(q)) {
    add(
      "structure",
      ONE_PER_RE.exec(q)?.[0]?.trim() ?? "one X per Y",
      0.6,
      true
    );
  }
  if (IDENTITY_ATTR_RE.test(q)) {
    add("structure", "identity attribute", 0.5, true);
  }

  // A fact that names an external SOURCE and says it HOLDS things implies a low
  // -confidence ingest behaviour ("…so index it"). Deliberately gated on the
  // fact already being emitted: without that gate, the bare noun "folder" would
  // make an automation out of any sentence mentioning one.
  if (acc.fact.emitted && HOLDING_RE.test(q) && namesSource(tokenSet)) {
    add(
      "behaviour",
      "external source + holding verb (implies ingest)",
      0.3,
      true
    );
  }

  // Context arms — supporting only. See `RuleIntentContext`.
  for (const name of matchNames(q, context.capabilities)) {
    add("behaviour", `capability: ${name}`, 0.15, false);
  }
  if (acc.structure.emitted || acc.behaviour.emitted) {
    for (const name of matchNames(q, context.profiles)) {
      add("structure", `profile: ${name}`, 0.15, false);
    }
  }

  const shapes = Object.entries(acc)
    .filter(([, a]) => a.emitted)
    .map(([shape, a]) => ({
      shape: shape as RuleShape,
      confidence: Math.min(CAP, Math.round(a.weight * 100) / 100),
      cues: a.cues,
    }))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        PRECEDENCE.indexOf(a.shape as ShapeKey) -
          PRECEDENCE.indexOf(b.shape as ShapeKey)
    );

  // Computed AFTER every scoring pass — `structure` can still be emitted by the
  // one-per / identity-attribute detectors below the cue tables.
  const hasAction =
    firedVerbs.length > 0 ||
    acc.notification.emitted ||
    acc.extraction.emitted ||
    acc.structure.emitted;

  const standing = shapes.length > 0;
  const framing = ONE_SHOT_FRAMING_RE.filter((c) => c.re.test(q)).map(
    (c) => c.phrase
  );
  const oneShotVerbs = ONE_SHOT_VERB_RE.filter((c) => c.re.test(q)).map(
    (c) => c.phrase
  );
  const oneShotCued = framing.length > 0 || oneShotVerbs.length > 0;

  // ── A one-shot ask is NOT a rule. Return it as such rather than shipping a
  //    low-confidence shape a downstream agent would happily build an automation
  //    from. `oneShot` is the signal; `unknown` is the honest shape.
  if (oneShotCued && !standing) {
    return {
      shapes: [
        {
          shape: "unknown",
          confidence: 0,
          cues: [...framing, ...oneShotVerbs],
        },
      ],
      primary: "unknown",
      oneShot: true,
    };
  }

  if (!standing) {
    return {
      shapes: [{ shape: "unknown", confidence: 0, cues: [] }],
      primary: "unknown",
      oneShot: false,
      needsClarification: {
        reason: normalized.trim()
          ? "No rule shape could be recognized — the text states no trigger, no schedule, no mapping and no fact about how things are arranged."
          : "The rule is empty.",
        question:
          'What should happen, and what should make it happen? (e.g. "when X, do Y", or a statement of how things are organised.)',
      },
    };
  }

  return {
    shapes,
    primary: shapes[0]!.shape,
    oneShot: false,
    ...(detectConflict({ framing, shapes, hasAction, explicitTrigger }) ?? {}),
  };
}

/**
 * The three conflicts worth stopping for. Each names the SPECIFIC ambiguity —
 * a generic "please clarify" is not reviewable and is worse than a guess.
 */
function detectConflict(args: {
  framing: string[];
  shapes: ShapeMatch[];
  hasAction: boolean;
  explicitTrigger: boolean;
}): { needsClarification: Clarification } | undefined {
  const { framing, shapes, hasAction, explicitTrigger } = args;
  const has = (s: RuleShape) => shapes.some((m) => m.shape === s);

  if (framing.length > 0) {
    return {
      needsClarification: {
        reason: `Reads as both a one-off request (“${framing[0]}”) and a standing rule (${shapes
          .map((s) => s.shape)
          .join(", ")}).`,
        question: "Should this run once now, or stay on permanently as a rule?",
      },
    };
  }

  if (explicitTrigger && !hasAction) {
    return {
      needsClarification: {
        reason:
          "A trigger is stated but no action follows it — there is nothing to run.",
        question: "When this happens, what should the agent actually do?",
      },
    };
  }

  if (
    has("schedule") &&
    !has("behaviour") &&
    !has("notification") &&
    !has("extraction")
  ) {
    return {
      needsClarification: {
        reason:
          "A recurrence is stated with no accompanying action or message — the schedule has nothing to fire.",
        question: "What should happen on that schedule?",
      },
    };
  }

  return undefined;
}

const blank = (): Accumulator => ({ weight: 0, cues: [], emitted: false });

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function namesSource(tokenSet: Set<string>): boolean {
  for (const t of tokenSet) if (SOURCE_NOUNS.has(t)) return true;
  return false;
}

/**
 * Which caller-supplied names the rule mentions.
 *
 * Normalization mirrors `catalogWords` in `classify.ts` — kebab/underscore to
 * spaces, lowercase — and, for the same reason documented there, EMPTY results
 * are dropped BEFORE matching: a name of "-" normalizes to "" and would compile
 * to `\b\b`, which matches everything.
 */
function matchNames(q: string, names?: string[]): string[] {
  if (!names?.length) return [];
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.toLowerCase().replace(/[-_]+/g, " ").trim();
    if (!name) continue;
    if (new RegExp(`\\b${escapeRe(name)}\\b`).test(q)) out.push(name);
  }
  return out;
}
