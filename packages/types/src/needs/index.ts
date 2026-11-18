/**
 * THE NEED VOCABULARY — what a space needs filled, once, by one provider
 * (founder decisions D2 and D3, 16 Nov 2026; plan 0adf8352 W3).
 *
 * Published as its own LEAF subpath (`@synap-core/types/needs`), like
 * `capability-intents`: a VALUE import from the `./` barrel crashes Hermes
 * (relay ships React Native). Pure and dependency-free.
 *
 * ── WHAT IS A NEED ─────────────────────────────────────────────────────────
 * A need is a SEAT a provider fills: "code host", "deploy target",
 * "payments". It is a named group of capability intents (the routing axis
 * over verbs), coarser than an intent on purpose: Stripe, Shopify, PostHog
 * and github-read all provide `[list_records, fetch_record]`, so an intent
 * cannot tell payments from analytics from a code host. A capability pack
 * DECLARES which needs it fills (`fills`); a space BINDS each need once, to
 * one provider, shared by its members (`installation_bindings` rows with no
 * installation, migration 0426).
 *
 * The person's word is "Needs" (`resolveObjectNoun("need")`). A need is never
 * renamed, only aliased: an alias resolves to its slug ({@link canonicalNeedSlug}).
 *
 * ── HOW A NEED IS NAMED ────────────────────────────────────────────────────
 * A NEED REF is `need:<slug>` or `need:<slug>/<intent>`:
 *   - a playbook's `tools` (and a stage's `tools`) entry: the verbs the bound
 *     provider offers for the need's intents (or the one intent);
 *   - a playbook's or stage's `requires` entry: the bound provider's
 *     capability key must be installed on the runner's computer;
 *   - a criterion's `check.capability`, an automation `capability` node's
 *     `need`: the ONE verb of the bound provider serving the need (the
 *     `/<intent>` suffix picks it when the provider has several).
 * A space DECLARES the needs its processes name ({@link declaredNeedsOf}): no
 * template field, nothing stored (the retired `settings.taskIntents`).
 *
 * ── WHY A MIRROR AND NOT AN IMPORT ─────────────────────────────────────────
 * THE SSOT IS THE POD's `needs` TABLE, seeded by migrations `0426_needs.sql`
 * and `0431_compute_need_and_leases.sql` (`compute`).
 * This list is a hand mirror with a parity guard (`parity.test.ts`) that
 * re-derives the seed SQL. ⚠️ MIRRORED IN LOCKSTEP with:
 *   - the `INSERT INTO "needs"` rows — migrations `0426`, `0431`
 *   - `NEEDS` — synap-control-plane-api `src/seeds/need-vocabulary.ts`
 * A slug added in a NEW migration must be added to both guards' filename
 * lists: extending the list is part of adding the slug.
 */

/** One need: its slug (the seat), words, the intents it groups, its aliases. */
export interface NeedDefinition {
  /** Lowercase kebab slug ({@link NEED_SLUG_RE}); never renamed. */
  readonly slug: string;
  /** The person's words for it. */
  readonly label: string;
  readonly description: string;
  /** The capability intents a provider of this need serves. */
  readonly intents: readonly string[];
  /** Older or other names that resolve to this slug. */
  readonly aliases: readonly string[];
}

/** Slug seat: lowercase kebab. Never the snake_case of an intent slug. */
export const NEED_SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** The prefix of a need ref in `tools`, `requires`, a check or a node. */
export const NEED_REF_PREFIX = "need:";

/** The seed rows of migrations 0426 and 0431, in order. */
export const NEEDS: readonly NeedDefinition[] = [
  {
    slug: "code-host",
    label: "Code host",
    description: "Where the code lives: repositories, branches, pull requests.",
    intents: ["fetch_record", "list_records", "run_external_job"],
    aliases: ["git-host", "repository"],
  },
  {
    slug: "deploy-target",
    label: "Deploy target",
    description: "Where a change is deployed and served.",
    intents: ["run_external_job", "fetch_record"],
    aliases: ["hosting"],
  },
  {
    slug: "gate",
    label: "Gate",
    description: "What checks a change before it lands: tests, typecheck, CI.",
    intents: ["run_external_job", "fetch_record"],
    aliases: ["ci"],
  },
  {
    slug: "payments",
    label: "Payments",
    description: "Where money is charged and recorded.",
    intents: ["list_records", "fetch_record"],
    aliases: [],
  },
  {
    slug: "messaging",
    label: "Messaging",
    description: "Where messages are sent to people outside the pod.",
    intents: ["send_message", "request_connection"],
    aliases: ["chat"],
  },
  {
    slug: "email",
    label: "Email",
    description: "The mailbox that sends and reads email.",
    intents: ["send_message", "list_records", "fetch_record"],
    aliases: ["mail"],
  },
  {
    slug: "calendar",
    label: "Calendar",
    description: "Where meetings and events are scheduled.",
    intents: ["schedule_event", "list_records"],
    aliases: [],
  },
  {
    slug: "file-store",
    label: "File store",
    description: "Where files are kept outside the pod.",
    intents: ["manage_file", "fetch_record", "list_records"],
    aliases: ["storage", "drive"],
  },
  {
    slug: "media-generation",
    label: "Media generation",
    description: "What makes and edits images, video and audio.",
    intents: ["generate_media", "edit_video", "transcribe_media"],
    aliases: ["media"],
  },
  {
    slug: "social-publishing",
    label: "Social publishing",
    description: "Where posts are published to social networks.",
    intents: ["publish_post"],
    aliases: ["social"],
  },
  {
    slug: "linkedin-reach",
    label: "LinkedIn reach",
    description: "What finds people and reaches them on LinkedIn.",
    intents: [
      "find_people",
      "request_connection",
      "send_message",
      "enrich_entity",
    ],
    aliases: ["linkedin"],
  },
  {
    slug: "analytics",
    label: "Analytics",
    description: "Where usage and traffic are measured.",
    intents: ["list_records", "fetch_record"],
    aliases: [],
  },
  {
    slug: "compute",
    label: "Compute",
    description:
      "Where temporary machines are started, run jobs and are released.",
    intents: [
      "provision_compute",
      "run_external_job",
      "fetch_record",
      "release_compute",
    ],
    aliases: ["cloud-compute", "gpu"],
  },
];

/** Every seeded need slug, in seed order. */
export const NEED_SLUGS: readonly string[] = NEEDS.map((n) => n.slug);

const BY_SLUG: ReadonlyMap<string, NeedDefinition> = new Map(
  NEEDS.map((n) => [n.slug, n])
);
const BY_ALIAS: ReadonlyMap<string, string> = new Map(
  NEEDS.flatMap((n) => n.aliases.map((a) => [a, n.slug] as const))
);

/**
 * The slug a name resolves to: the slug itself, or the slug an alias points
 * at. `null` for a name the vocabulary does not know.
 */
export function canonicalNeedSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (BY_SLUG.has(value)) return value;
  return BY_ALIAS.get(value) ?? null;
}

/** True when `value` is a seeded need slug or alias. */
export function isKnownNeed(value: unknown): value is string {
  return canonicalNeedSlug(value) !== null;
}

/** The need a slug or alias names, or `undefined`. */
export function needOf(value: unknown): NeedDefinition | undefined {
  const slug = canonicalNeedSlug(value);
  return slug ? BY_SLUG.get(slug) : undefined;
}

/** The values a list leaves UNKNOWN (neither slug nor alias), each once. */
export function unknownNeeds(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string" && !isKnownNeed(v) && !out.includes(v)) {
      out.push(v);
    }
  }
  return out;
}

/** A parsed need ref: the need as written, and the one intent it narrows to. */
export interface NeedRef {
  /** The slug AS WRITTEN (an alias stays an alias; canonicalize to compare). */
  need: string;
  /** The `/<intent>` suffix, or null for every intent of the need. */
  intent: string | null;
}

const NEED_REF_RE =
  /^need:([a-z][a-z0-9-]{0,63})(?:\/([a-z][a-z0-9_]{0,63}))?$/;

/**
 * Parse a need ref (`need:code-host`, `need:gate/fetch_record`). `null` for
 * anything that is not one, so a caller can try the other kinds of entry.
 * Shape only: an unknown slug still parses (the caller reports it).
 */
export function parseNeedRef(entry: unknown): NeedRef | null {
  if (typeof entry !== "string") return null;
  const m = NEED_REF_RE.exec(entry.trim());
  if (!m) return null;
  return { need: m[1]!, intent: m[2] ?? null };
}

/** True when the entry starts like a need ref (well formed or not). */
export function looksLikeNeedRef(entry: unknown): boolean {
  return typeof entry === "string" && entry.trim().startsWith(NEED_REF_PREFIX);
}

/** Spell a need ref. */
export function needRef(slug: string, intent?: string | null): string {
  return `${NEED_REF_PREFIX}${slug}${intent ? `/${intent}` : ""}`;
}

/**
 * The intents a need ref asks for: its one intent, or every intent of the
 * need. `[]` for an unknown need.
 */
export function needRefIntents(ref: NeedRef): string[] {
  const need = needOf(ref.need);
  if (!need) return [];
  if (ref.intent) return need.intents.includes(ref.intent) ? [ref.intent] : [];
  return [...need.intents];
}

/**
 * What a malformed or unknown need ref is, in one sentence; `null` when it is
 * a ref to a known need (and, with a suffix, to one of that need's intents).
 * The ONE validation every write door and the catalog run.
 */
export function needRefProblem(entry: string): string | null {
  const ref = parseNeedRef(entry);
  if (!ref) {
    return `"${entry}" is not a need ref: write need:<need> or need:<need>/<intent>.`;
  }
  const need = needOf(ref.need);
  if (!need) {
    return `"${entry}" names no need. Needs: ${NEED_SLUGS.join(", ")}.`;
  }
  if (ref.intent && !need.intents.includes(ref.intent)) {
    return `"${entry}": the need "${need.slug}" does not group the intent "${ref.intent}" (it groups ${need.intents.join(", ")}).`;
  }
  return null;
}

/** The loose shape of a playbook (row, definition or catalog yaml) a scan reads. */
export interface NeedDeclaringPlaybook {
  tools?: unknown;
  requires?: unknown;
  stages?: unknown;
  criteria?: unknown;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function checkCapabilityOf(criterion: unknown): string | null {
  if (!criterion || typeof criterion !== "object") return null;
  const check = (criterion as { check?: unknown }).check;
  if (!check || typeof check !== "object") return null;
  const cap = (check as { capability?: unknown }).capability;
  return typeof cap === "string" ? cap : null;
}

/**
 * Every need ref a playbook names, in order, each once: its `tools`,
 * `requires` and criteria, then each stage's `tools`, `requires` and
 * criteria. Refs only (well formed), as written. PURE and tolerant.
 */
export function needRefsOf(playbook: NeedDeclaringPlaybook): string[] {
  const out: string[] = [];
  const take = (v: string | null) => {
    if (v && parseNeedRef(v) && !out.includes(v.trim())) out.push(v.trim());
  };
  strings(playbook.tools).forEach(take);
  strings(playbook.requires).forEach(take);
  if (Array.isArray(playbook.criteria)) {
    for (const c of playbook.criteria) take(checkCapabilityOf(c));
  }
  if (Array.isArray(playbook.stages)) {
    for (const s of playbook.stages) {
      if (!s || typeof s !== "object") continue;
      const stage = s as NeedDeclaringPlaybook;
      strings(stage.tools).forEach(take);
      strings(stage.requires).forEach(take);
      if (Array.isArray(stage.criteria)) {
        for (const c of stage.criteria) take(checkCapabilityOf(c));
      }
    }
  }
  return out;
}

/**
 * The needs (canonical slugs) a set of playbooks declares, in first-seen
 * order, each once. Unknown slugs are kept as written, so a caller reports
 * them instead of dropping them. PURE.
 */
export function declaredNeedsOf(
  playbooks: readonly NeedDeclaringPlaybook[]
): string[] {
  const out: string[] = [];
  for (const p of playbooks) {
    for (const entry of needRefsOf(p)) {
      const ref = parseNeedRef(entry)!;
      const slug = canonicalNeedSlug(ref.need) ?? ref.need;
      if (!out.includes(slug)) out.push(slug);
    }
  }
  return out;
}
