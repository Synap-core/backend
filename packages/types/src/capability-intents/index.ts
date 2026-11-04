/**
 * THE CLOSED INTENT VOCABULARY — what a capability DOES, vendor-independently.
 *
 * Published as its own LEAF subpath (`@synap-core/types/capability-intents`)
 * rather than through the `./` barrel: a VALUE import from a barrel crashes
 * Hermes (relay ships React Native). Pure and dependency-free — consumed by the
 * pod (`@synap/database` re-exports `ABSTRACT_INTENTS` as `ABSTRACT_VERBS`) and
 * by the workspace-template authoring package (`validate.ts` and
 * `task-intents.test.ts`).
 *
 * ── WHAT IS AN INTENT ───────────────────────────────────────────────────────
 * An intent is the ROUTING axis over the verb catalog. A verb's `id` is
 * vendor-keyed (`gmail_send`, `unipile_send_message`); its `intent` says what it
 * MEANS, so an agent can ask for "send a message" without already knowing the
 * vendor. Routing ONLY — an intent resolves to a concrete verb id BEFORE the
 * governance gate, which continues to decide on the verb exactly as before.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT ─────────────────────────────────────────
 * THE SSOT IS THE POD's `capability_intents` TABLE, seeded by migrations
 * `0283_capability_intents.sql` (the 13), `0284_publish_post_intent.sql`
 * (`publish_post`), `0314_delegate_agent_task_intent.sql` (`delegate_agent_task`),
 * `0329_read_webpage_intent.sql` (`read_webpage`), `0360_search_web_intent.sql`
 * (`search_web`), `0370_edit_video_intent.sql` (`edit_video`) and
 * `0398_reachability_intents.sql` (`expose_http`, `tunnel`, `dns_record`,
 * `tls_cert`, `render_video`, with their contracts). Slugs live in ROWS, not
 * in a TypeScript union.
 *
 * The pod reads THIS file: `ABSTRACT_VERBS` (`@synap/database`
 * `schema/tools.ts`) is `ABSTRACT_INTENTS`, re-exported.
 *
 * A hand copy that nothing checks is a comment. A hand copy with a parity guard
 * is a mirror — `src/capability-intents/parity.test.ts` re-derives the pod's
 * seed migration SQL and fails the build the moment these two disagree.
 *
 * ⚠️ MIRRORED IN LOCKSTEP with:
 *   - the `INSERT` slugs — migrations `0283`, `0284`, `0314`, `0329`, `0360`,
 *     `0370`, `0398`
 *   - `CAPABILITY_INTENTS` — synap-control-plane-api
 *       `src/seeds/capability-intent-vocabulary.ts`
 *
 * That is TWO copies, each with its own parity guard against the migration SQL
 * — neither importable from the other (the control plane is a separate deploy
 * target with its own lockfile). Two guards live in this repo, two in the
 * control plane.
 *
 * A THIRD copy — `AbstractVerb` in `@synap/playbooks` — was DELETED 2026-10-01.
 * It was a TYPE-only union of the 13, stale since 0284, and a whole-repo scan
 * found zero importers, so nothing could have noticed the staleness. Do not
 * re-add it; `packages/playbooks/src/required-intents.test.ts` refuses it.
 *
 * ADD A SLUG TO BOTH OR THE GUARDS GO RED AND THAT IS THE POINT. Note that
 * each guard lists its migration FILENAMES, so a slug added in a NEW migration is
 * invisible to all of them until that list is extended — extending it is part of
 * adding the slug, not a follow-up.
 *
 * Full procedure, including the deployment constraints: the
 * `intent-vocabulary-ssot` chapter of the `synap-schema` skill
 * (`skills/synap-schema/intent-vocabulary-ssot.md`), which is where an agent
 * should look first.
 */

/**
 * The 13 seed slugs from migration 0283 — the pod re-exports this list as
 * `ABSTRACT_VERBS` (`schema/tools.ts`). Grouped: ACQUIRE (bring information
 * in), ACT OUTWARD (change something outside the pod), BRIDGE (bring external
 * data INTO the pod), CONTROL.
 */
export const ABSTRACT_INTENTS = [
  // ACQUIRE — bring information in
  /** Query an outside corpus (web, provider DB, file store). */
  "search_external",
  /** Locate people or companies matching criteria. */
  "find_people",
  /** Add known facts to a person/company we already have. */
  "enrich_entity",
  /** Get ONE identified external record. */
  "fetch_record",
  /** Enumerate records of a kind. */
  "list_records",

  // ACT OUTWARD — change something outside the pod
  /** Deliver a message to a human outside the pod. */
  "send_message",
  /** Ask a person to connect (invite / relation request). */
  "request_connection",
  /** Create or modify a calendar commitment. */
  "schedule_event",
  /** Create/copy/move a file in external storage. */
  "manage_file",
  /** Produce an image, video, or audio artifact. */
  "generate_media",

  // BRIDGE — bring external data INTO the pod as proposed entities
  "capture_into_pod",

  // CONTROL
  /** Invoke an arbitrary external compute job. */
  "run_external_job",
  /** Establish or authorize a provider connection. */
  "connect_account",
] as const;

/**
 * Slugs inserted by a later migration, so NOT in the seed union. Kept separate
 * deliberately: a reader can see at a glance which slugs came from 0283 and
 * which were added after, rather than one flat list hiding the distinction.
 */
export const REGISTERED_EXTRAS = [
  "publish_post",
  "delegate_agent_task",
  "read_webpage",
  "search_web",
  "edit_video",
  // 0398 — the reachability family and render_video, each with a contract
  "expose_http",
  "tunnel",
  "dns_record",
  "tls_cert",
  "render_video",
] as const;

/**
 * The intent every verb an agent binding lists carries (migration 0314) —
 * `tools.config.agentBinding.verbs.*`. ONE spelling for the pod and the
 * browser.
 */
export const DELEGATE_AGENT_TASK_INTENT =
  "delegate_agent_task" satisfies (typeof REGISTERED_EXTRAS)[number];

/**
 * Every intent slug a capability or a workspace template may declare — the
 * closed vocabulary as the wire sees it.
 */
export const CAPABILITY_INTENTS: readonly string[] = [
  ...ABSTRACT_INTENTS,
  ...REGISTERED_EXTRAS,
];

const INTENT_SET: ReadonlySet<string> = new Set(CAPABILITY_INTENTS);

/** True when `value` is a slug the pod's router knows. */
export function isKnownIntent(value: unknown): value is string {
  return typeof value === "string" && INTENT_SET.has(value);
}

/**
 * The intents a declared list leaves UNKNOWN — the actionable answer for a
 * validator, which wants the offenders, not a boolean. `isKnownIntent` stays the
 * membership test; this is the same vocabulary turned into a diagnostic.
 */
export function unknownIntents(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (
      typeof value === "string" &&
      !INTENT_SET.has(value) &&
      !seen.has(value)
    ) {
      seen.add(value);
    }
  }
  return [...seen];
}

/**
 * One value of the closed vocabulary. Deliberately `string`-widened rather than
 * the seed union: the table — not this list — is the SSOT, so a template that
 * declares `publish_post` must typecheck, and a slug added to the pod must not
 * break authoring here before its parity guard has had a chance to run.
 */
export type CapabilityIntentSlug = string;

/**
 * The intents a set of sources PROVIDES, derived from their declared intents.
 *
 * This is the derivation the `provides` field is required to match — declared in
 * ONE place so the seeder, a guard, and any future consumer cannot each reinvent
 * it (and disagree, which is precisely the failure a routing axis cannot
 * afford). Dedupe preserves first-seen order so the result is stable.
 */
export function deriveProvidedIntents(
  sources: ReadonlyArray<{ intent?: unknown }> | undefined
): CapabilityIntentSlug[] {
  if (!sources) return [];
  const seen = new Set<string>();
  for (const source of sources) {
    const intent = source?.intent;
    if (typeof intent === "string" && !seen.has(intent)) seen.add(intent);
  }
  return [...seen];
}

/**
 * What granting `capability.<intent>.run` lets an app do, in the person's
 * words — the consent screen's line for it (decision 2A, 2026-10-28). Every
 * slug of the vocabulary has its own sentence (`run-labels.test.ts`); a slug
 * added on a pod before this list learns it still reads as a sentence.
 */
const INTENT_RUN_LABELS: Readonly<Record<string, string>> = {
  search_external: "Search outside sources with your tools",
  find_people: "Find people and companies with your tools",
  enrich_entity: "Add facts to your records with your tools",
  fetch_record: "Fetch outside records with your tools",
  list_records: "List outside records with your tools",
  send_message: "Send messages with your tools",
  request_connection: "Send connection requests with your tools",
  schedule_event: "Schedule events with your tools",
  manage_file: "Manage files with your tools",
  generate_media: "Make images, video and audio with your tools",
  capture_into_pod: "Bring outside data into your pod with your tools",
  run_external_job: "Run outside jobs with your tools",
  connect_account: "Connect accounts with your tools",
  publish_post: "Publish posts with your tools",
  delegate_agent_task: "Hand tasks to your agents",
  read_webpage: "Read web pages with your tools",
  search_web: "Search the web with your tools",
  edit_video: "Edit videos with your tools",
  expose_http: "Make your services reachable at a web address",
  tunnel: "Connect your computers to the internet edge, outbound only",
  dns_record: "Change DNS records in your domains",
  tls_cert: "Get and renew certificates for your web addresses",
  render_video: "Render videos with your tools",
};

export function intentRunLabel(slug: CapabilityIntentSlug): string {
  return (
    INTENT_RUN_LABELS[slug] ?? `Run your tools to ${slug.replace(/_/g, " ")}`
  );
}

// ── Intent contracts (migration 0398, plan U1) ───────────────────────────────

/**
 * The operations an intent's contract may declare. A one-shot intent has no
 * contract; an intent whose result LIVES (a URL, a record, a certificate) has
 * one: `create` makes it, `status` checks it, `renew` extends it, `revoke`
 * tears it down. Closed on purpose: the resolver and the host runner key on
 * these four, and a verb's `skills.intent_op` must name one of them.
 */
export const INTENT_OPS = ["create", "status", "renew", "revoke"] as const;
export type IntentOp = (typeof INTENT_OPS)[number];

const INTENT_OP_SET: ReadonlySet<string> = new Set(INTENT_OPS);

/** True when `value` is one of the four contract ops. */
export function isIntentOp(value: unknown): value is IntentOp {
  return typeof value === "string" && INTENT_OP_SET.has(value);
}

/** A JSON Schema object, as stored. The pod validates with it; this file does not. */
export type IntentJsonSchema = Record<string, unknown>;

/** One op of a contract. */
export interface IntentContractOp {
  /** A provider must implement it to qualify for the intent. */
  required: boolean;
  /**
   * Owed although not `required`, once an output carries this field (today
   * only `"expiresAt"`: a provider that returns an expiry must also renew).
   */
  requiredWhen?: string;
  /**
   * The op's input. Absent on `create`: its input is the intent row's
   * `input_schema` (0368), so the app intent doors read it unchanged and the
   * shape lives in one column.
   */
  input?: IntentJsonSchema;
}

/**
 * `capability_intents.contract` — what any provider of the intent implements,
 * whoever its vendor is. A provider qualifies when it has a verb for every
 * required op and an `offers` entry for the intent; then it resolves exactly
 * like any other (addendum 000e75ff §3–§4).
 */
export interface IntentContract {
  version: 1;
  /** The ONE output shape every op returns (JSON Schema). */
  output: IntentJsonSchema;
  /** `create` is always declared. */
  ops: { create: IntentContractOp } & Partial<
    Record<Exclude<IntentOp, "create">, IntentContractOp>
  >;
  /** The keys a need may constrain and a provider's `offers` declare. */
  constraints: string[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with a value meant to be an `IntentContract`, one sentence per
 * problem; empty when it is one. A checker, not a JSON Schema validator: it
 * reads the contract's own frame (version, ops, output, constraints), never the
 * schemas inside it.
 */
export function intentContractProblems(value: unknown): string[] {
  if (!isPlainObject(value)) return ["The contract is not an object."];
  const problems: string[] = [];
  if (value.version !== 1) problems.push("The contract's version is not 1.");
  if (!isPlainObject(value.output)) {
    problems.push("The contract declares no output schema.");
  }
  const ops = value.ops;
  if (!isPlainObject(ops)) {
    problems.push("The contract declares no ops.");
  } else {
    if (!("create" in ops)) problems.push("The contract has no create op.");
    for (const [name, op] of Object.entries(ops)) {
      if (!isIntentOp(name)) {
        problems.push(
          `"${name}" is not an op (they are ${INTENT_OPS.join(", ")}).`
        );
        continue;
      }
      if (!isPlainObject(op)) {
        problems.push(`The ${name} op is not an object.`);
        continue;
      }
      if (typeof op.required !== "boolean") {
        problems.push(`The ${name} op does not say whether it is required.`);
      }
      if (
        op.requiredWhen !== undefined &&
        typeof op.requiredWhen !== "string"
      ) {
        problems.push(`The ${name} op's requiredWhen is not a field name.`);
      }
      if (name === "create") {
        if (op.input !== undefined) {
          problems.push(
            "The create op declares its own input; it is the intent's input_schema."
          );
        }
      } else if (!isPlainObject(op.input)) {
        problems.push(`The ${name} op declares no input schema.`);
      }
    }
  }
  const constraints = value.constraints;
  if (
    !Array.isArray(constraints) ||
    constraints.some((c) => typeof c !== "string" || c.length === 0)
  ) {
    problems.push("The contract's constraints are not a list of keys.");
  } else if (new Set(constraints).size !== constraints.length) {
    problems.push("The contract's constraints repeat a key.");
  }
  return problems;
}

/** True when `value` is a well-formed contract. */
export function isIntentContract(value: unknown): value is IntentContract {
  return intentContractProblems(value).length === 0;
}

/** The ops every provider must implement, in contract order. */
export function requiredIntentOps(contract: IntentContract): IntentOp[] {
  return INTENT_OPS.filter((op) => contract.ops[op]?.required === true);
}

/**
 * The required ops a provider's verbs leave out — the reason a provider is a
 * misfit ("it cannot revoke"). `implemented` is the set of `intent_op` values
 * its verbs declare for this intent.
 */
export function missingIntentOps(
  contract: IntentContract,
  implemented: Iterable<string>
): IntentOp[] {
  const have = new Set(implemented);
  return requiredIntentOps(contract).filter((op) => !have.has(op));
}
