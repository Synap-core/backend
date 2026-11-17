/**
 * REACTIONS DECLARED ON A LINK (plan 7d71ddcc §2, wave 3) — what a relation
 * between two kinds says should happen when one end moves. Stored on the
 * pair, `profile_relations.metadata.reactions` (a status name is per kind, so
 * the move a declaration asks for is per pair): the home nothing read before.
 *
 * A CLOSED union, validated like `LifecycleOptionRequirement`: a declaration
 * names a kind of reaction and its few typed fields, never an expression.
 * Only `rollup` exists (decision D7: no cascade or gate in this change); a
 * future `cascade` or `gate` is one more arm, and an arm this reader does not
 * know is reported, never guessed.
 *
 * ROLL-UP (decision D5): the parent moves when every NON-lost child linked by
 * the relation is done, and at least one is. A lost child is ignored (the
 * parent does not wait on work that will not happen). Each child is judged by
 * THE classification of a dependency (`classifyDependencyBlocker`): its
 * lifecycle category when known, else its status word; anything unknown is
 * open, so a child nobody can read never completes a parent.
 *
 * Pure: types, a reader of stored JSON and the decision. The compiler that
 * turns a declaration into a rule, and the effect that moves the parent, live
 * in @synap/api (`services/reactions/`).
 */
import { classifyDependencyBlocker } from "../connections/dependency.js";
import type { LifecycleCategory } from "../lifecycle/option.js";

/** The `profile_relations.metadata` key that holds the declarations. */
export const RELATION_REACTIONS_KEY = "reactions" as const;

/** The kinds of reaction a link can declare (D7: roll-up only, for now). */
export const RELATION_REACTION_KINDS = ["rollup"] as const;
export type RelationReactionKind = (typeof RELATION_REACTION_KINDS)[number];

/**
 * A roll-up along the relation: when the parent's parts are all done (D5),
 * the parent moves.
 */
export interface RelationRollupDeclaration {
  kind: "rollup";
  /**
   * The parent's status to move to. Absent: its NEXT status, the first
   * declared option after the one it stands on that is not lost.
   */
  to?: string;
  /**
   * Which end is the parent. `target` (the default) reads "the source is
   * part of the target" (`part_of`: a scene is part of a film); `source`
   * reads "the source holds the target" (`parent_of`).
   */
  parent?: "target" | "source";
  /**
   * D3: the parent's move into done or lost is PROPOSED unless this says
   * `apply` — a roll-up the person trusts. Say why in `terminalWhy`.
   */
  terminal?: "propose" | "apply";
  terminalWhy?: string;
  /**
   * The parent's own move may roll up further (a scene → its film → the
   * film's series), up to the chain depth cap. Off by default.
   */
  chains?: boolean;
  /** The rule's title, when the person wants their own words. */
  title?: string;
}

/** One declaration (the union every future arm joins). */
export type RelationReactionDeclaration = RelationRollupDeclaration;

export interface RelationReactionsRead {
  declarations: RelationReactionDeclaration[];
  /** What could not be read, in words (an unknown kind, a bad field). */
  errors: string[];
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/**
 * Read the declarations off a stored `profile_relations.metadata` blob.
 * Stored JSON is DATA: an entry that does not parse is reported in `errors`
 * and skipped; nothing is guessed, and no two roll-ups are kept on one pair
 * (the first wins, the second is reported).
 */
export function readRelationReactions(
  metadata: unknown
): RelationReactionsRead {
  const out: RelationReactionsRead = { declarations: [], errors: [] };
  const raw =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[RELATION_REACTIONS_KEY]
      : undefined;
  if (raw === undefined || raw === null) return out;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const [at, entry] of list.entries()) {
    if (!entry || typeof entry !== "object") {
      out.errors.push(`Reaction ${at + 1} is not an object.`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.kind !== "rollup") {
      out.errors.push(
        `Reaction ${at + 1}: "${String(e.kind)}" is not a kind a link can declare (${RELATION_REACTION_KINDS.join(", ")}).`
      );
      continue;
    }
    if (out.declarations.some((d) => d.kind === "rollup")) {
      out.errors.push(`Reaction ${at + 1}: a link declares one roll-up.`);
      continue;
    }
    if (
      e.parent !== undefined &&
      e.parent !== "target" &&
      e.parent !== "source"
    ) {
      out.errors.push(
        `Reaction ${at + 1}: parent is "target" or "source", not "${String(e.parent)}".`
      );
      continue;
    }
    if (
      e.terminal !== undefined &&
      e.terminal !== "propose" &&
      e.terminal !== "apply"
    ) {
      out.errors.push(
        `Reaction ${at + 1}: terminal is "propose" or "apply", not "${String(e.terminal)}".`
      );
      continue;
    }
    const to = str(e.to);
    const title = str(e.title);
    const terminalWhy = str(e.terminalWhy);
    out.declarations.push({
      kind: "rollup",
      ...(to ? { to } : {}),
      ...(e.parent === "source" ? { parent: "source" as const } : {}),
      ...(e.terminal === "apply" ? { terminal: "apply" as const } : {}),
      ...(terminalWhy ? { terminalWhy } : {}),
      ...(e.chains === true ? { chains: true } : {}),
      ...(title ? { title } : {}),
    });
  }
  return out;
}

/** One child as the roll-up reads it. */
export interface RollupChild {
  status: string | null;
  category: LifecycleCategory | null;
}

/** Where a parent's parts stand (the "3 of 5 done" beside the rule). */
export interface RollupProgress {
  /** Parts that count: every child but the lost ones. */
  of: number;
  done: number;
  /** Lost parts: ignored by the roll-up (D5), said beside it. */
  lost: number;
  /** Parts still open (neither done nor lost). */
  open: number;
  /** Every non-lost part is done and at least one is: the parent moves. */
  ready: boolean;
}

/**
 * THE roll-up decision (D5), pure. A child with no status at all (its kind
 * declares no lifecycle) has nothing to roll up and is not counted; every
 * other child is judged by THE dependency classification: delivered = done,
 * dropped = lost (ignored), anything else = open.
 */
export function rollupProgress(
  children: readonly RollupChild[]
): RollupProgress {
  let done = 0;
  let lost = 0;
  let open = 0;
  for (const c of children) {
    if (c.status === null && c.category === null) continue;
    const outcome = classifyDependencyBlocker("entity", c.status, c.category);
    if (outcome === "delivered") done += 1;
    else open += 1; // NEGATIVE CONTROL: a lost part holds the parent
  }
  return { of: done + open, done, lost, open, ready: open === 0 && done > 0 };
}

/** "3 of 5 done", plus the lost ones when there are any. Pure. */
export function rollupProgressLabel(p: RollupProgress): string {
  const head = `${p.done} of ${p.of} done`;
  return p.lost > 0 ? `${head} · ${p.lost} dropped` : head;
}

/**
 * The status a roll-up moves the parent to: the declared one, else the NEXT
 * option after the one it stands on that is not lost. Null when there is
 * none (it stands on its last option, or on a done or lost one: a parent
 * that already ended is never rolled again). Pure.
 */
export function rollupTarget(input: {
  options: ReadonlyArray<{ key: string; category: LifecycleCategory }>;
  current: string | null;
  to?: string;
}): string | null {
  const here = input.options.find((o) => o.key === input.current);
  if (here && (here.category === "done" || here.category === "lost")) {
    return null;
  }
  if (input.to) {
    return input.options.some((o) => o.key === input.to) ? input.to : null;
  }
  const at = here ? input.options.indexOf(here) : -1;
  return (
    input.options.slice(at + 1).find((o) => o.category !== "lost")?.key ?? null
  );
}
