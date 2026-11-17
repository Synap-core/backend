/**
 * REACTIONS → RULES (plan 7d71ddcc W3, decision D1): every rule the
 * reactions reactor applies — the built-in ones and the ones a relation
 * declares — gets ONE row in the pod's rule list, through the ONE rule door
 * (`createRuleGoverned` / `updateRuleGoverned`), exactly as a playbook's
 * activators do (`playbook-activators.ts`). That row is what makes the rule
 * visible, owned and PAUSABLE: draft = paused, read back by the reactor
 * through {@link reactionEnabledStates} (`registerReactionStateSource`).
 *
 * The row carries NO automation: the reactor runs the rule, never the
 * matcher, so a compiled automation would fire it twice. It is a prose rule
 * (its intent is the rule in words) marked `metadata.rule.reaction = {id}`.
 *
 * ── IDEMPOTENCE AND THE OWNER (the activator convergence, unchanged) ───────
 * Each row carries the seed stamp `{template: "reaction-rule", key: <the
 * reaction id>, hash}` and is decided by THE three-way (`decideTemplateRule`):
 *   found, untouched, unchanged    → nothing
 *   found, untouched, decl moved   → update (restamped)
 *   found, owner-edited            → kept (the owner wins)
 *   found, draft, retired by us    → re-activated when declared again
 *   found, draft, NOT retired by us→ kept: the owner paused it
 *   not found, had a ruleId        → kept: the owner deleted it (not recreated)
 *   not found                      → create
 * A rule whose reaction is no longer declared (a relation's declaration
 * removed) is RETIRED: it becomes a draft, remembered as retired by us. The
 * memory — which row each reaction produced and whether WE retired it — lives
 * on the singleton `pod_settings.settings.reactionRules` (the no-new-table
 * pattern of `catalogSyncStamps`), since a pod default belongs to no playbook.
 *
 * WHO OWNS IT: a built-in rule is the pod owner's; a declared one is its
 * relation's author's (else the pod owner's). Scope: the pod, or the space
 * the relation is declared in.
 */
import { createLogger } from "@synap-core/core";
import { db, drizzleSql, eq, podSettings } from "@synap/database";
import {
  listReactions,
  registerReactionSource,
  type ReactionDeclaration,
} from "@synap/jobs/utils/reactions.js";
import { relationReactionSource } from "./relation-reactions.js";
import type { RuleScope, RuleSeed } from "../rules/index.js";
import { createRuleGoverned } from "../rules/create.js";
import {
  updateRuleGoverned,
  type UpdateRuleGovernedResult,
} from "../rules/update.js";
import {
  decideTemplateRule,
  templateRuleHash,
} from "../rules/template-rules.js";
import { resolvePodOwnerUserId } from "../capabilities/pod-owner.js";
import {
  readReactionRuleRows,
  type ReactionRuleRow,
} from "./reaction-rule-rows.js";
import {
  reactionDoWords,
  reactionViaWords,
  reactionWhenWords,
} from "./list-reaction-rules.js";

const logger = createLogger({ module: "reaction-rules-compile" });

/** The seed namespace every reaction's rule row carries. */
export const REACTION_RULE_TEMPLATE = "reaction-rule" as const;

/** The `pod_settings.settings` key of the compile pass's memory. */
export const REACTION_RULE_MEMORY_KEY = "reactionRules" as const;

interface ReactionRuleMemory {
  rules: Record<string, { ruleId: string; retired?: true }>;
}

export type ReactionRuleOutcomeStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "kept"
  | "conflict"
  | "reactivated"
  | "retired"
  | "owner_choice"
  | "offered"
  | "denied"
  | "failed";

export interface ReactionRuleOutcome {
  reactionId: string;
  status: ReactionRuleOutcomeStatus;
  ruleId?: string;
  reason?: string;
}

/**
 * The rule a reaction compiles to, in words. PURE: a function of the
 * declaration alone, so its hash (and idempotence) is stable across passes.
 */
export function reactionRuleIntent(r: ReactionDeclaration): string {
  return `${r.title}. ${reactionWhenWords(r)}; then ${reactionViaWords(r)} ${reactionDoWords(r)}.`;
}

/** Where a reaction's rule applies: its relation's space, else the pod. */
export function reactionRuleScope(r: ReactionDeclaration): RuleScope {
  const ws = r.declaredOn?.workspaceId;
  return ws ? { kind: "workspace", workspaceId: ws } : { kind: "pod" };
}

async function readMemory(): Promise<{
  rowId: string | null;
  settings: Record<string, unknown>;
  memory: ReactionRuleMemory;
}> {
  const [row] = await db
    .select({ id: podSettings.id, settings: podSettings.settings })
    .from(podSettings)
    .limit(1);
  const settings = (row?.settings as Record<string, unknown> | null) ?? {};
  const raw = settings[REACTION_RULE_MEMORY_KEY] as
    { rules?: unknown } | undefined;
  const rules: ReactionRuleMemory["rules"] = {};
  if (raw?.rules && typeof raw.rules === "object") {
    for (const [k, v] of Object.entries(raw.rules as Record<string, unknown>)) {
      const r = v as { ruleId?: unknown; retired?: unknown } | null;
      if (typeof r?.ruleId === "string") {
        rules[k] = {
          ruleId: r.ruleId,
          ...(r.retired === true ? { retired: true as const } : {}),
        };
      }
    }
  }
  return { rowId: row?.id ?? null, settings, memory: { rules } };
}

async function writeMemory(
  rowId: string | null,
  memory: ReactionRuleMemory
): Promise<void> {
  if (rowId) {
    // Merged in SQL: the singleton row holds other settings, written by
    // other doors; only this key is ours.
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || jsonb_build_object(${REACTION_RULE_MEMORY_KEY}::text, ${JSON.stringify(memory)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, rowId));
  } else {
    await db
      .insert(podSettings)
      .values({ settings: { [REACTION_RULE_MEMORY_KEY]: memory } });
  }
}

function fromUpdate(
  reactionId: string,
  ruleId: string,
  r: UpdateRuleGovernedResult,
  ok: ReactionRuleOutcomeStatus
): ReactionRuleOutcome {
  switch (r.status) {
    case "updated":
      return { reactionId, status: ok, ruleId };
    case "proposed":
      return { reactionId, status: "offered", ruleId };
    case "not_found":
      return { reactionId, status: "failed", ruleId, reason: "not found" };
    case "denied":
      return { reactionId, status: "denied", ruleId, reason: r.reason };
  }
}

/** Passes are serialized in-process (boot racing a relation's edit). */
let inFlight: Promise<unknown> = Promise.resolve();

/**
 * Converge the rule list to the reactions declared NOW (built-in + every
 * relation's). Non-fatal per reaction: each outcome is returned. Returns
 * `no_owner` on a pod with no owner yet (nothing to attribute a rule to).
 */
export async function convergeReactionRules(): Promise<{
  status: "applied" | "no_owner";
  outcomes: ReactionRuleOutcome[];
}> {
  const run = inFlight.catch(() => undefined).then(() => convergeOnce());
  inFlight = run;
  return run;
}

async function convergeOnce(): Promise<{
  status: "applied" | "no_owner";
  outcomes: ReactionRuleOutcome[];
}> {
  const podOwner = await resolvePodOwnerUserId();
  if (!podOwner) return { status: "no_owner", outcomes: [] };
  // The boot pass may run before the slots are filled: the declarations it
  // compiles are joined here too (idempotent by id).
  registerReactionSource(relationReactionSource);
  const declared = await listReactions();
  const { rowId, memory } = await readMemory();
  const memoryBefore = JSON.stringify(memory);

  const grouped = new Map<string, ReactionRuleRow[]>();
  for (const row of await readReactionRuleRows()) {
    const id = row.meta.reaction!.id;
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  // One row per reaction: the remembered one, else a live one, else the
  // first. Every other LIVE row of it is a duplicate a race made: retired.
  const byId = new Map<string, ReactionRuleRow>();
  const duplicates: Array<ReactionRuleRow & { reactionId: string }> = [];
  for (const [id, list] of grouped) {
    const primary =
      list.find((r) => r.id === memory.rules[id]?.ruleId) ??
      list.find((r) => !r.meta.draft) ??
      list[0]!;
    byId.set(id, primary);
    for (const r of list) {
      if (r !== primary && !r.meta.draft) {
        duplicates.push({ ...r, reactionId: id });
      }
    }
  }

  const outcomes: ReactionRuleOutcome[] = [];
  const declaredIds = new Set<string>();
  for (const reaction of declared) {
    declaredIds.add(reaction.id);
    const decl = { key: reaction.id, intent: reactionRuleIntent(reaction) };
    const seed: RuleSeed = {
      template: REACTION_RULE_TEMPLATE,
      key: decl.key,
      hash: templateRuleHash(decl),
    };
    const remembered = memory.rules[reaction.id];
    const found = byId.get(reaction.id) ?? null;
    try {
      if (found) {
        if (found.meta.draft) {
          if (!(remembered?.ruleId === found.id && remembered.retired)) {
            // A draft we did not retire: its owner paused it.
            memory.rules[reaction.id] = { ruleId: found.id };
            outcomes.push({
              reactionId: reaction.id,
              status: "owner_choice",
              ruleId: found.id,
              reason: "paused by its owner — left paused",
            });
            continue;
          }
          // Retired by us, declared again → re-activated.
          const r = await updateRuleGoverned({
            userId: found.userId,
            ruleId: found.id,
            intent: decl.intent,
            scope: found.meta.scope,
            draft: false,
            seed,
            auditSource: REACTION_RULE_TEMPLATE,
          });
          outcomes.push(fromUpdate(reaction.id, found.id, r, "reactivated"));
          if (r.status === "updated") {
            memory.rules[reaction.id] = { ruleId: found.id };
          }
          continue;
        }
        memory.rules[reaction.id] = { ruleId: found.id };
        const d = decideTemplateRule({
          decl,
          stored: found.meta,
          ref: null,
          refRowExists: false,
        });
        if (d.action === "update") {
          const r = await updateRuleGoverned({
            userId: found.userId,
            ruleId: found.id,
            intent: decl.intent,
            scope: found.meta.scope,
            seed,
            auditSource: REACTION_RULE_TEMPLATE,
          });
          outcomes.push(fromUpdate(reaction.id, found.id, r, "updated"));
        } else {
          outcomes.push({
            reactionId: reaction.id,
            status:
              d.action === "none"
                ? d.status === "kept" || d.status === "conflict"
                  ? d.status
                  : "unchanged"
                : "unchanged",
            ruleId: found.id,
          });
        }
        continue;
      }
      if (remembered) {
        // It produced a row that is gone: its owner deleted it.
        outcomes.push({
          reactionId: reaction.id,
          status: "owner_choice",
          ruleId: remembered.ruleId,
          reason: "deleted by its owner — not recreated",
        });
        continue;
      }
      const r = await createRuleGoverned({
        userId: reaction.declaredOn?.userId ?? podOwner,
        intent: decl.intent,
        scope: reactionRuleScope(reaction),
        seed,
        reaction: { id: reaction.id },
        auditSource: REACTION_RULE_TEMPLATE,
      });
      if (r.status === "created") {
        memory.rules[reaction.id] = { ruleId: r.ruleId };
        outcomes.push({
          reactionId: reaction.id,
          status: "created",
          ruleId: r.ruleId,
        });
      } else if (r.status === "proposed") {
        outcomes.push({ reactionId: reaction.id, status: "offered" });
      } else {
        outcomes.push({
          reactionId: reaction.id,
          status: "denied",
          reason: r.reason,
        });
      }
    } catch (err) {
      outcomes.push({
        reactionId: reaction.id,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Retire what is no longer declared, and duplicate rows ───────────────
  const toRetire = [
    ...[...byId]
      .filter(([id, row]) => !declaredIds.has(id) && !row.meta.draft)
      .map(([id, row]) => ({ ...row, reactionId: id, duplicate: false })),
    ...duplicates.map((d) => ({ ...d, duplicate: true })),
  ];
  for (const row of toRetire) {
    try {
      const r = await updateRuleGoverned({
        userId: row.userId,
        ruleId: row.id,
        intent: row.meta.intent,
        scope: row.meta.scope,
        draft: true,
        auditSource: REACTION_RULE_TEMPLATE,
      });
      outcomes.push(fromUpdate(row.reactionId, row.id, r, "retired"));
      if (r.status === "updated" && !row.duplicate) {
        memory.rules[row.reactionId] = { ruleId: row.id, retired: true };
      }
    } catch (err) {
      outcomes.push({
        reactionId: row.reactionId,
        status: "failed",
        ruleId: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (JSON.stringify(memory) !== memoryBefore) {
    await writeMemory(rowId, memory);
  }
  return { status: "applied", outcomes };
}

/** The boot and the relation door: a failed pass is logged, never thrown. */
export async function convergeReactionRulesSafely(): Promise<void> {
  try {
    const r = await convergeReactionRules();
    const bad = r.outcomes.filter(
      (o) => o.status === "failed" || o.status === "denied"
    );
    if (bad.length > 0) {
      logger.warn({ outcomes: bad }, "some reaction rules did not converge");
    }
  } catch (err) {
    logger.warn({ err }, "reaction rules did not converge");
  }
}

/**
 * The person's pause, through THE governed rule door: `on: false` makes the
 * reaction's rule a draft, `on: true` makes it live again. A reaction with
 * no row yet is converged first (the row is the only place a pause lives).
 * Floored by the rule door's own visibility: a rule the caller cannot see
 * is `not_found`.
 */
export async function setReactionRuleOn(input: {
  userId: string;
  agentUserId?: string;
  reactionId: string;
  on: boolean;
}): Promise<
  | { status: "updated"; ruleId: string; on: boolean }
  | { status: "proposed"; proposalId: string }
  | { status: "not_found" }
  | { status: "denied"; reason: string }
> {
  const find = async () =>
    (await readReactionRuleRows()).filter(
      (r) => r.meta.reaction!.id === input.reactionId
    );
  let rows = await find();
  if (rows.length === 0) {
    await convergeReactionRules();
    rows = await find();
  }
  const { memory } = await readMemory();
  const row =
    rows.find((r) => r.id === memory.rules[input.reactionId]?.ruleId) ??
    rows.find((r) => !r.meta.draft) ??
    rows[0];
  if (!row) return { status: "not_found" };
  const r = await updateRuleGoverned({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    ruleId: row.id,
    intent: row.meta.intent,
    scope: row.meta.scope,
    draft: !input.on,
    auditSource: "rules.setReactionRule",
  });
  if (r.status === "updated") {
    return { status: "updated", ruleId: row.id, on: input.on };
  }
  return r;
}
