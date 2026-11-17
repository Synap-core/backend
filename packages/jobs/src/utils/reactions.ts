/**
 * REACTIONS (plan 7d71ddcc §2, wave 2) — "when X moves, move Y": the ONE
 * registry of the rules the `reactions` reactor applies, and the pure guards
 * it decides with. The person calls them "Rules" (decision D8); "reaction" is
 * an internal word.
 *
 * A reaction is WHEN (a subject type, statuses or categories it lands on) →
 * VIA (one existing link from what moved to what it moves) → DO (one effect,
 * applied through the TARGET's own door, as the `system`, with a `cause`).
 *
 * WHO DECLARES THEM. Built-in reactions are declared in code below
 * (`BUILT_IN_REACTIONS`, the pod defaults 3 and 4 in this wave). Declarations
 * compiled elsewhere (lane E: relation-level roll-ups, stage outputs) join the
 * SAME list through {@link registerReactionSource}; the person's pause of any
 * of them through {@link registerReactionStateSource}. Nothing else holds
 * rules: there is no reactions table (a rules table was rejected, api
 * `services/rules/index.ts`).
 *
 * THE GUARDS ({@link decideReactionWrites}, pure), from the prior art:
 *   - chaining is off by default: a move a reaction made fires further
 *     reactions only when THAT reaction declares `chains: true` (Jira's
 *     opt-in), and never deeper than {@link MAX_REACTION_DEPTH} (the depth
 *     rides `cause.depth`, so the stop is attributable);
 *   - one fixed order per move (`order`, then `id`);
 *   - two reactions writing the same target with DIFFERENT values is a
 *     conflict: logged, nothing applied to that target (DMN UNIQUE);
 *   - a reaction's move into done or lost is a PROPOSAL unless the reaction
 *     opts out (`terminal: "apply"`, decision D3);
 *   - a person's move always wins: the effect's write is a compare-and-set
 *     from the status the plan read, and a conflict is a logged skip (D6),
 *     decided by the worker (`workers/reactions.ts`), not here;
 *   - every skip is logged with its reason (`recordReactionOutcomes`).
 */
import type {
  AnyTransitionPayload,
  LifecycleCategory,
  ProposalTransitionPayload,
  TransitionCause,
  TransitionSubjectType,
} from "@synap-core/types/lifecycle";
import { PROPOSAL_STATUS_DECLARATION } from "@synap-core/types/units";

/** How many moves deep a chain of reactions may go (Jira caps at 10; D7 keeps it short). */
export const MAX_REACTION_DEPTH = 3;

/** WHEN: the move a reaction listens to. Empty `to` and `category` = any move. */
export interface ReactionWhen {
  subjectType: TransitionSubjectType;
  /** The move lands on one of these statuses. */
  to?: readonly string[];
  /** …or in one of these categories. */
  category?: readonly LifecycleCategory[];
}

/**
 * VIA: the ONE existing link a reaction walks from what moved to what it
 * moves. A closed union: a declaration names a link, never an expression.
 * Lane E adds the relation arm (`part_of` roll-ups).
 */
export type ReactionVia =
  /** An approved proposal → every outcome (slot) whose own `ref` names its target. */
  | { link: "outcome_ref" }
  /** A run → the session it drives. */
  | { link: "run_session" }
  /** A slot → the stage of its session that declares it, and that session's subject. */
  | { link: "slot_stage" };

/** DO: the one effect, applied through the target's own door. Closed. */
export type ReactionDo =
  /** Meet the outcome (the done door, `satisfy-expected-output.ts`). */
  | { effect: "meet_outcomes" }
  /** Pause the session with a hold on the person (`setSessionStatus`). */
  | { effect: "pause_session" }
  /** Move the subject to the stage's `onApproved` (the status door, `moveStatus`). */
  | { effect: "reach_stage_status" };

export type ReactionEffectKey = ReactionDo["effect"];

export interface ReactionDeclaration {
  /** Stable: the dedupe key, the log's subject and the cause's `reactionId`. */
  id: string;
  /** Plain words, as the person's Rules list shows it. */
  title: string;
  when: ReactionWhen;
  via: ReactionVia;
  do: ReactionDo;
  /** Lower runs first; ties by `id`. */
  order: number;
  /** A move this reaction makes may fire further reactions (off by default). */
  chains?: boolean;
  /**
   * D3: a move into done or lost is PROPOSED unless this says `apply`. The
   * reason it is safe to apply goes in `terminalWhy`.
   */
  terminal?: "propose" | "apply";
  terminalWhy?: string;
  /** Where it was declared. */
  source: "built_in" | "declared";
  /** Built-in rules are on unless their owner paused them. */
  enabled: boolean;
}

/**
 * The pod's built-in rules (plan §2 "The four defaults"; 3 and 4 in this
 * wave, 1 and 2 are lane E's declarations).
 */
export const BUILT_IN_REACTIONS: readonly ReactionDeclaration[] = [
  {
    id: "builtin:outcome-met-where-filed",
    title: "An outcome is met wherever it was filed",
    when: { subjectType: "proposal", to: ["approved", "auto_approved"] },
    via: { link: "outcome_ref" },
    do: { effect: "meet_outcomes" },
    order: 10,
    // An outcome it meets may complete a stage's work: that slot's move must
    // reach the stage's status (`builtin:approved-output-reaches-status`,
    // decision D2; review 6bf3101d M2b). Its moves are slots only, so the
    // only rule they fire is that one.
    terminal: "apply",
    terminalWhy:
      "The approval is already the person's decision: meeting the outcome it delivers asks nothing new.",
    source: "built_in",
    enabled: true,
  },
  {
    id: "builtin:stopped-run-needs-you",
    title: "A run that stops early goes to Needs you",
    when: { subjectType: "playbook_run", to: ["waiting_on_you"] },
    via: { link: "run_session" },
    do: { effect: "pause_session" },
    order: 20,
    source: "built_in",
    enabled: true,
  },
  {
    // Decision D2, approval signal 1: a stage's `onApproved` is reached when
    // its declared outputs are all delivered — whichever door delivered the
    // last one (an approval, an attestation, an answer, evidence, a merge, a
    // child run, default 3 meeting it by its ref).
    id: "builtin:approved-output-reaches-status",
    title: "A stage's approved work moves its thing to the stage's result",
    when: { subjectType: "slot", category: ["done"] },
    via: { link: "slot_stage" },
    do: { effect: "reach_stage_status" },
    order: 30,
    source: "built_in",
    enabled: true,
  },
];

/** A pull request merge is not a transition: default 3's other trigger. */
export const OUTCOME_MET_REACTION_ID = "builtin:outcome-met-where-filed";

// ── The registry: built-ins + what other declarers register ───────────────

/**
 * A source of compiled declarations (lane E: relation roll-ups, stage
 * outputs). `subjectTypes` is what its declarations listen to, so the
 * reactor queues a job only for a move some rule can match.
 */
export interface ReactionSource {
  id: string;
  subjectTypes: readonly TransitionSubjectType[];
  list(): Promise<readonly ReactionDeclaration[]>;
}

/** Who paused which rule (lane E backs it with the rule list's own pause). */
export type ReactionStateSource = () => Promise<ReadonlyMap<string, boolean>>;

const sources: ReactionSource[] = [];
let stateSource: ReactionStateSource | null = null;

/** Add a source of declarations to the ONE list (idempotent by `id`). */
export function registerReactionSource(source: ReactionSource): void {
  const at = sources.findIndex((s) => s.id === source.id);
  if (at >= 0) sources[at] = source;
  else sources.push(source);
}

/** Back the enabled flag (rule id → enabled) with the person's pause. */
export function registerReactionStateSource(fn: ReactionStateSource): void {
  stateSource = fn;
}

/** Tests only: forget what was registered. */
export function resetReactionRegistryForTests(): void {
  sources.length = 0;
  stateSource = null;
}

/** The subject types the DECLARED rules (registered sources) listen to. */
export function declaredSubjectTypes(): ReadonlySet<TransitionSubjectType> {
  return new Set(sources.flatMap((s) => s.subjectTypes));
}

/** The subject types any rule listens to. */
export function reactionSubjectTypes(): ReadonlySet<TransitionSubjectType> {
  return new Set([
    ...BUILT_IN_REACTIONS.map((r) => r.when.subjectType),
    ...sources.flatMap((s) => s.subjectTypes),
  ]);
}

/**
 * THE ONE READ of every rule the reactor applies, in its fixed order:
 * built-in and declared, each with its enabled flag. The person's Rules list
 * (lane E) renders this; the reactor decides from it.
 */
export async function listReactions(): Promise<ReactionDeclaration[]> {
  const declared = (await Promise.all(sources.map((s) => s.list()))).flat();
  const state = stateSource ? await stateSource() : new Map<string, boolean>();
  const seen = new Set<string>();
  const all: ReactionDeclaration[] = [];
  for (const r of [...BUILT_IN_REACTIONS, ...declared]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    all.push({ ...r, enabled: state.get(r.id) ?? r.enabled });
  }
  return all.sort(byReactionOrder);
}

/** Is this rule on (its owner did not pause it)? */
export async function isReactionEnabled(id: string): Promise<boolean> {
  const r = (await listReactions()).find((x) => x.id === id);
  return r?.enabled ?? false;
}

export function byReactionOrder(
  a: Pick<ReactionDeclaration, "order" | "id">,
  b: Pick<ReactionDeclaration, "order" | "id">
): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Does this rule listen to this move? Pure. */
export function reactionMatches(
  r: Pick<ReactionDeclaration, "when">,
  t: Pick<AnyTransitionPayload, "subjectType" | "to" | "category">
): boolean {
  if (r.when.subjectType !== t.subjectType) return false;
  const byTo = r.when.to && r.when.to.length > 0;
  const byCategory = r.when.category && r.when.category.length > 0;
  if (!byTo && !byCategory) return true;
  return Boolean(
    (byTo && r.when.to!.includes(t.to)) ||
    (byCategory && r.when.category!.includes(t.category))
  );
}

// ── The plan and the guards (pure) ────────────────────────────────────────

/** One write a reaction's effect would make, read BEFORE anything is written. */
export interface PlannedWrite {
  /** What it moves: the subject of the transition the write will owe. */
  target: { subjectType: TransitionSubjectType; subjectId: string };
  to: string;
  toCategory: LifecycleCategory;
  /** The status the plan read: the compare-and-set's `from`. */
  expectedFrom: string | null;
  /** The person the target belongs to (the log's owner). */
  ownerUserId: string;
  /** The effect's own facts (the session, the slot, the hold). */
  detail: Record<string, unknown>;
  /**
   * The person's words for it: the target's own name (an outcome's label, a
   * session's title) and the sentence its log row says once it is applied.
   */
  say: { name: string; applied: string };
}

export type ReactionSkipCode =
  /** The rule's owner paused it. */
  | "paused"
  /** The chain would go deeper than {@link MAX_REACTION_DEPTH}. */
  | "chain_depth"
  /** A reaction made this move, and it does not chain. */
  | "not_chained"
  /** Another rule writes a different value to the same target. */
  | "conflict"
  /** An earlier rule already writes the same value to it. */
  | "same_write"
  /** The target moved since the plan read it (a person's move wins). */
  | "moved_meanwhile"
  /** A done/lost move must be proposed and this effect cannot propose. */
  | "needs_proposal"
  /** The effect is not available in this process (its slot is unfilled). */
  | "effect_unavailable"
  /** The target's door refused the move. */
  | "refused"
  /** Applying it threw (the job is retried). */
  | "failed";

export interface DecidedWrite {
  reaction: ReactionDeclaration;
  write: PlannedWrite;
  /** `propose`: a move into done or lost from a rule that did not opt out. */
  mode: "apply" | "propose";
  cause: TransitionCause;
}

export interface SkippedWrite {
  reaction: ReactionDeclaration;
  write: PlannedWrite;
  code: ReactionSkipCode;
  /** In the person's words (`reactionReason`): the Rules list shows it. */
  reason: string;
  /** The machine's detail (statuses, values, an error), never shown as is. */
  detail?: string | null;
  cause: TransitionCause;
}

/** Every code a reaction's log row carries. */
export type ReactionLogCode = ReactionSkipCode | "applied" | "proposed";

/**
 * THE WORDS of a reaction's log row, in the person's language: the Rules list
 * (D8) shows them. The target is named by its own name (an outcome's label, a
 * session's title), never by a type and an id; no internal word ("door",
 * "transition", "reaction", a status key). The machine's facts ride beside
 * them (`code`, `target`, `detail`). Pure.
 */
export function reactionReason(
  code: ReactionSkipCode | "proposed",
  name: string | null,
  extra: { others?: readonly string[] } = {}
): string {
  const it = name ? `\u201c${name}\u201d` : "it";
  const kept = `Left ${it} as it was`;
  const others = (extra.others ?? []).map((t) => `\u201c${t}\u201d`);
  switch (code) {
    case "proposed":
      return `Asked you before closing ${it}: closing it is your call.`;
    case "paused":
      return `${kept}: this rule is paused.`;
    case "not_chained":
      return `${kept}: another rule made the change, and rules do not set each other off.`;
    case "chain_depth":
      return `${kept}: rules had already changed ${MAX_REACTION_DEPTH} things in a row.`;
    case "conflict":
      return `${kept}: ${others.join(" and ") || "two rules"} would change it in different ways.`;
    case "same_write":
      return `Nothing more to do on ${it}: ${others[0] ?? "another rule"} already changes it the same way.`;
    case "moved_meanwhile":
      return `${kept}: it changed since, and that change wins.`;
    case "needs_proposal":
      return `${kept}: closing it needs your approval, and this rule cannot ask for it yet.`;
    case "effect_unavailable":
      return "Did not run this time: this rule is not available right now.";
    case "refused":
      return `${kept}: it could not be changed.`;
    case "failed":
      return `Could not change ${it} this time: it will be tried again.`;
  }
}

/** The cause a reaction's move carries, one link deeper than the move that fired it. */
export function nextCause(
  reactionId: string,
  source: Pick<AnyTransitionPayload, "transitionId" | "cause">
): TransitionCause {
  return {
    reactionId,
    transitionId: source.transitionId,
    chainId: source.cause?.chainId ?? source.transitionId,
    depth: (source.cause?.depth ?? 0) + 1,
  };
}

const targetKey = (w: PlannedWrite) =>
  `${w.target.subjectType}:${w.target.subjectId}`;

/**
 * THE GUARDS, pure: which planned writes apply, which are proposed, which are
 * skipped and why. `planned` is every matching rule with the writes its
 * effect planned (an empty list: nothing to do, nothing logged).
 * `causedBy` is the rule that made the source move, when one did.
 */
export function decideReactionWrites(input: {
  source: Pick<AnyTransitionPayload, "transitionId" | "cause">;
  planned: ReadonlyArray<{
    reaction: ReactionDeclaration;
    writes: readonly PlannedWrite[];
  }>;
  causedBy: ReactionDeclaration | null;
}): { decided: DecidedWrite[]; skipped: SkippedWrite[] } {
  const decided: DecidedWrite[] = [];
  const skipped: SkippedWrite[] = [];
  const sourceCause = input.source.cause ?? null;
  const live: Array<{
    reaction: ReactionDeclaration;
    write: PlannedWrite;
    cause: TransitionCause;
  }> = [];
  const ordered = [...input.planned].sort((a, b) =>
    byReactionOrder(a.reaction, b.reaction)
  );
  for (const { reaction, writes } of ordered) {
    const cause = nextCause(reaction.id, input.source);
    const skipAll = (code: ReactionSkipCode, detail: string) => {
      for (const write of writes) {
        skipped.push({
          reaction,
          write,
          code,
          reason: reactionReason(code, write.say.name),
          detail,
          cause,
        });
      }
    };
    if (!reaction.enabled) {
      skipAll("paused", "rule disabled");
      continue;
    }
    if (sourceCause && !(input.causedBy?.chains === true)) {
      skipAll(
        "not_chained",
        `caused by ${input.causedBy?.id ?? sourceCause.reactionId ?? "unknown"}, which does not chain`
      );
      continue;
    }
    if (cause.depth > MAX_REACTION_DEPTH) {
      skipAll(
        "chain_depth",
        `depth ${cause.depth} > ${MAX_REACTION_DEPTH}, chain ${cause.chainId}`
      );
      continue;
    }
    for (const write of writes) live.push({ reaction, write, cause });
  }

  // Conflicts: two rules writing one target with different values.
  const byTarget = new Map<string, typeof live>();
  for (const l of live) {
    const k = targetKey(l.write);
    byTarget.set(k, [...(byTarget.get(k) ?? []), l]);
  }
  for (const group of byTarget.values()) {
    const values = new Set(group.map((g) => g.write.to));
    if (values.size > 1) {
      const titles = [...new Set(group.map((g) => g.reaction.title))];
      for (const g of group) {
        skipped.push({
          ...g,
          code: "conflict",
          reason: reactionReason("conflict", g.write.say.name, {
            others: titles,
          }),
          detail: `${group.map((x) => `${x.reaction.id}=${x.write.to}`).join(", ")}`,
        });
      }
      continue;
    }
    const [first, ...rest] = group;
    for (const g of rest) {
      skipped.push({
        ...g,
        code: "same_write",
        reason: reactionReason("same_write", g.write.say.name, {
          others: [first!.reaction.title],
        }),
        detail: `${first!.reaction.id} writes ${g.write.to}`,
      });
    }
    const terminal =
      first!.write.toCategory === "done" || first!.write.toCategory === "lost";
    decided.push({
      ...first!,
      mode:
        terminal && first!.reaction.terminal !== "apply" ? "propose" : "apply",
    });
  }
  return { decided, skipped };
}

// ── A receipt born decided ────────────────────────────────────────────────

/** The proposal row a receipt is read from (`proposals`). */
export interface BornReceiptRow {
  id: string;
  status: string;
  proposalType: string;
  targetType: string;
  targetId: string;
  sessionId: string | null;
  workspaceId: string | null;
  subjectUserId: string | null;
  createdBy: string | null;
  agentUserId: string | null;
  createdAt: Date | string | null;
}

/**
 * A receipt born `auto_approved`, as the move it stands for: `null` →
 * `auto_approved`, by the system (the policy decided). Its insert owes no
 * transition (a birth is not a move, `proposal-transition.ts`), so there is
 * no transition id: the receipt's own id stands for it (the cause's
 * `transitionId` and the log's source name the receipt). `null` once it no
 * longer stands `auto_approved` (its write failed, it was reverted). Pure.
 */
export function bornReceiptTransition(
  row: BornReceiptRow
): ProposalTransitionPayload | null {
  if (row.status !== "auto_approved") return null;
  const at = (
    row.createdAt ? new Date(row.createdAt) : new Date()
  ).toISOString();
  return {
    transitionId: row.id,
    subjectType: "proposal",
    subjectId: row.id,
    property: "status",
    from: null,
    to: "auto_approved",
    fromCategory: null,
    category: PROPOSAL_STATUS_DECLARATION.auto_approved.category,
    actorKind: "system",
    actorClass: "system",
    appId: null,
    userId: row.subjectUserId ?? row.createdBy ?? "system",
    agentUserId: row.agentUserId ?? null,
    sessionId: row.sessionId ?? null,
    reason: null,
    staleExpected: false,
    proposalId: row.id,
    workspaceId: row.workspaceId ?? null,
    occurredAt: at,
    recordedAt: at,
    backdated: false,
    hold: null,
    proposalType: row.proposalType,
    targetType: row.targetType,
    targetId: row.targetId,
    section: null,
  };
}
