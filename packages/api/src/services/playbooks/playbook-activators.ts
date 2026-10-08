/**
 * PLAYBOOK ACTIVATORS → governed rules.
 *
 * A playbook DECLARES when it starts (`activators[]`, stored inside
 * `subject_profile` — schemas/playbook-process.ts). A declaration runs nothing:
 * this module compiles each one into a RULE through the ONE rule door
 * (`createRuleGoverned` / `updateRuleGoverned` — the door `skills.createRule`,
 * the template-rule applier and the capture "Always propose this" chip use), so
 * an activator is governed exactly like every other installed rule: an agent
 * caller files a proposal, a human/installer caller creates directly, and an
 * agent-authored rule's automation lands `draft` (the rule door's own floor).
 * No new runtime engine: the compiled automation is an ordinary
 * `entity.create|update` → `playbook_run` rule the matcher already fires.
 *
 * Each compiled rule's automation is linked in `playbook_automations` with
 * role `"activator"`, so "what starts this process" is one join away.
 *
 * ── IDEMPOTENCE (re-install, reconcile, every boot) ─────────────────────────
 * Every rule carries the template-rule stamp `metadata.rule.seed =
 * {template: "playbook-activator:<playbookId>", key, hash}` — the SAME three-way
 * marker `template-rules.ts` converges with, decided by the SAME pure
 * `decideTemplateRule`:
 *   found, untouched, unchanged    → nothing
 *   found, untouched, decl moved   → update (restamped)
 *   found, owner-edited            → kept (the owner wins), reported
 *   not found, an earlier offer    → not re-offered (a pending OR declined
 *     (pending/rejected proposal     `rule/create` proposal carrying this seed —
 *     with this seed)                kept on the proposal itself)
 *   not found                      → create
 * A rule whose key is no longer declared is RETIRED through the same door
 * (`updateRuleGoverned({ draft: true })` — its automation is archived, the rule
 * stays visible and cannot fire) and its activator link is removed. A STORED
 * activator list that fails to parse retires nothing: corrupt is not empty.
 *
 * ── ONLY A LIVE PLAYBOOK DECLARES ───────────────────────────────────────────
 * A playbook that is not `active` (draft, paused, archived) declares no live
 * activator: its rules are retired by this same pass. So a draft copy (browser
 * Duplicate, an agent's draft) starts nothing, and archiving retires what the
 * playbook started — the router re-runs this pass on archive and on every
 * status change, as it already does for the cron schedule.
 *
 * ── THE OWNER WINS (memory) ─────────────────────────────────────────────────
 * Per playbook, `playbooks.metadata.activatorRules = { template, rules: { key →
 * { ruleId, retired? } } }` remembers which rule each declared key produced and
 * whether THIS module retired it. That is what tells the owner's choice apart
 * from ours on every later pass (boot included):
 *   found, draft, retired by us    → re-activated when declared again
 *   found, draft, NOT retired by us→ kept: the owner paused it
 *   not found, had a ruleId        → kept: the owner deleted it, never recreated
 * The memory is ignored when its `template` is another playbook's (a copied
 * metadata bag), so a duplicate never inherits its source's choices. A row with
 * no memory (written before it existed) is judged conservatively: a draft is
 * the owner's pause.
 *
 * ── CONCURRENCY ─────────────────────────────────────────────────────────────
 * Passes over ONE playbook are serialized in-process (boot reconcile racing a
 * playbooks.update, two re-installs). Across processes nothing locks, so a race
 * can still create a key twice: every pass therefore RETIRES duplicate rows of
 * one key, keeping one — the extra rule cannot keep firing.
 *
 * Non-fatal per activator: each outcome is returned. The top-level reads and
 * the link sync CAN throw; callers go through `convergePlaybookActivatorsSafely`.
 */

import { createLogger } from "@synap-core/core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { playbookActivatorSentence } from "@synap-core/types/automations";
import {
  db,
  skills,
  playbooks,
  playbookAutomations,
  proposals,
  and,
  eq,
  inArray,
  notInArray,
  drizzleSql,
} from "@synap/database";
import type { PlaybookActivator } from "@synap/playbooks";
import {
  activatorKey,
  readPlaybookProcess,
} from "../../schemas/playbook-process.js";
import {
  RULE_CATEGORY,
  readRuleMetadata,
  type RuleMetadata,
  type RuleSeed,
} from "../rules/index.js";
import { createRuleGoverned } from "../rules/create.js";
import { updateRuleGoverned } from "../rules/update.js";
import { readRuleAutomationIds } from "../rules/lineage.js";
import {
  decideTemplateRule,
  templateRuleHash,
  type TemplateRuleDecl,
} from "../rules/template-rules.js";

const logger = createLogger({ module: "playbook-activators" });

/** The `playbook_automations.role` an activator's automation is linked with. */
export const ACTIVATOR_ROLE = "activator" as const;

/** The seed namespace of one playbook's activator rules. */
export function activatorSeedTemplate(playbookId: string): string {
  return `playbook-activator:${playbookId}`;
}

export type ActivatorOutcomeStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "kept"
  | "conflict"
  | "reactivated"
  | "offered"
  | "retired"
  /** The owner paused or deleted this rule; it is left as they left it. */
  | "owner_choice"
  | "denied"
  | "failed";

export interface ActivatorOutcome {
  key: string;
  status: ActivatorOutcomeStatus;
  ruleId?: string;
  proposalId?: string;
  reason?: string;
}

export interface ApplyPlaybookActivatorsResult {
  playbookId: string;
  /** `invalid` = the stored list did not parse; nothing was retired. */
  status: "applied" | "invalid" | "no_playbook" | "no_status_property";
  outcomes: ActivatorOutcome[];
}

/**
 * The rule declaration an activator compiles to. PURE — the intent prose and
 * the sentence are a function of the activator and the playbook, so the hash
 * (and therefore idempotence) is stable across passes.
 */
export function activatorRuleDecl(input: {
  activator: PlaybookActivator;
  playbookId: string;
  playbookName: string;
  profileSlug: string;
  statusProperty: string | null;
}): TemplateRuleDecl | { key: string; error: string } {
  const { activator: a, playbookId, profileSlug } = input;
  const key = activatorKey(a);
  const kind = resolveObjectNoun(profileSlug).toLowerCase();
  const verb = a.mode === "propose" ? "propose running" : "run";
  if (a.on === "enters_status") {
    if (!input.statusProperty || !a.status) {
      return {
        key,
        error:
          "an enters_status activator needs subjectProfile.statusProperty — the property whose value the subject enters",
      };
    }
    return {
      key,
      intent: `When a ${kind} enters "${a.status}", ${verb} "${input.playbookName}" on it.`,
      sentence: playbookActivatorSentence({
        playbookId,
        profileSlug,
        on: "enters_status",
        statusProperty: input.statusProperty,
        status: a.status,
        mode: a.mode,
      }),
    };
  }
  return {
    key,
    intent: `When a ${kind} is created, ${verb} "${input.playbookName}" on it.`,
    sentence: playbookActivatorSentence({
      playbookId,
      profileSlug,
      on: "created",
      mode: a.mode,
    }),
  };
}

/** One playbook's memory of the rules its activators produced (see header). */
interface ActivatorMemory {
  template: string;
  rules: Record<string, { ruleId: string; retired?: true }>;
}

/** The `playbooks.metadata` key that holds {@link ActivatorMemory}. */
export const ACTIVATOR_MEMORY_KEY = "activatorRules" as const;

function readActivatorMemory(
  metadata: unknown,
  template: string
): ActivatorMemory {
  const raw = (metadata as Record<string, unknown> | null)?.[
    ACTIVATOR_MEMORY_KEY
  ] as { template?: unknown; rules?: unknown } | undefined;
  const rules: ActivatorMemory["rules"] = {};
  if (
    raw?.template === template &&
    raw.rules &&
    typeof raw.rules === "object"
  ) {
    for (const [k, v] of Object.entries(raw.rules as Record<string, unknown>)) {
      const r = v as { ruleId?: unknown; retired?: unknown } | null;
      if (typeof r?.ruleId === "string")
        rules[k] = {
          ruleId: r.ruleId,
          ...(r.retired === true ? { retired: true as const } : {}),
        };
    }
  }
  return { template, rules };
}

/** Passes over one playbook, serialized in-process (see CONCURRENCY). */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Converge ONE playbook's activator rules to its declared `activators[]`.
 * Attribution: `userId` (+ `agentUserId` for an agent caller) — the caller of
 * the playbook write, exactly as the template-rule applier attributes.
 */
export async function applyPlaybookActivators(input: {
  playbookId: string;
  userId: string;
  agentUserId?: string | null;
}): Promise<ApplyPlaybookActivatorsResult> {
  const prev = inFlight.get(input.playbookId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => applyOnce(input));
  inFlight.set(input.playbookId, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(input.playbookId) === run)
      inFlight.delete(input.playbookId);
  }
}

async function applyOnce(input: {
  playbookId: string;
  userId: string;
  agentUserId?: string | null;
}): Promise<ApplyPlaybookActivatorsResult> {
  const [pb] = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      status: playbooks.status,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
      metadata: playbooks.metadata,
    })
    .from(playbooks)
    .where(eq(playbooks.id, input.playbookId))
    .limit(1);
  if (!pb) {
    return {
      playbookId: input.playbookId,
      status: "no_playbook",
      outcomes: [],
    };
  }
  const process = readPlaybookProcess(pb.subjectProfile);
  if (process.activatorsInvalid) {
    logger.error(
      { playbookId: pb.id },
      "stored activators did not parse — no activator rule was created or retired"
    );
    return { playbookId: pb.id, status: "invalid", outcomes: [] };
  }
  // ONLY A LIVE PLAYBOOK DECLARES (header).
  const declared = pb.status === "active" ? process.activators : [];

  const template = activatorSeedTemplate(pb.id);
  const memory = readActivatorMemory(pb.metadata, template);
  const memoryBefore = JSON.stringify(memory.rules);
  const agent = input.agentUserId ? { agentUserId: input.agentUserId } : {};
  const scope = pb.workspaceId
    ? { kind: "workspace" as const, workspaceId: pb.workspaceId }
    : { kind: "pod" as const };

  // Every rule this playbook's activators ever produced (by seed namespace).
  const rows = await db
    .select({ id: skills.id, metadata: skills.metadata })
    .from(skills)
    .where(
      and(
        eq(skills.category, RULE_CATEGORY),
        drizzleSql`${skills.metadata}->'rule'->'seed'->>'template' = ${template}`
      )
    );
  const grouped = new Map<string, Array<{ id: string; meta: RuleMetadata }>>();
  for (const row of rows) {
    const meta = readRuleMetadata(row.metadata as Record<string, unknown>);
    if (!meta?.seed) continue;
    const list = grouped.get(meta.seed.key) ?? [];
    list.push({ id: row.id, meta });
    grouped.set(meta.seed.key, list);
  }
  // One row per key: the remembered one, else a live one, else the first.
  // Every OTHER live row of that key is a duplicate a race created — retired.
  const byKey = new Map<string, { id: string; meta: RuleMetadata }>();
  const duplicates: Array<{ key: string; id: string; meta: RuleMetadata }> = [];
  for (const [key, list] of grouped) {
    const primary =
      list.find((r) => r.id === memory.rules[key]?.ruleId) ??
      list.find((r) => !r.meta.draft) ??
      list[0]!;
    byKey.set(key, primary);
    for (const r of list) {
      if (r !== primary && !r.meta.draft) duplicates.push({ key, ...r });
    }
  }

  const outcomes: ActivatorOutcome[] = [];
  const declaredKeys = new Set<string>();
  /** Rules that should be LIVE after this pass — their automations get linked. */
  const liveRuleIds = new Set<string>();

  for (const activator of declared) {
    const built = process.profileSlug
      ? activatorRuleDecl({
          activator,
          playbookId: pb.id,
          playbookName: pb.name,
          profileSlug: process.profileSlug,
          statusProperty: process.statusProperty,
        })
      : {
          key: activatorKey(activator),
          error: "activators need subjectProfile.profileSlug",
        };
    declaredKeys.add(built.key);
    if ("error" in built) {
      outcomes.push({ key: built.key, status: "denied", reason: built.error });
      continue;
    }
    const decl = built;
    const seed: RuleSeed = {
      template,
      key: decl.key,
      hash: templateRuleHash(decl),
    };
    const remembered = memory.rules[decl.key];
    try {
      const found = byKey.get(decl.key) ?? null;
      if (found) {
        if (found.meta.draft) {
          if (!(remembered?.ruleId === found.id && remembered.retired)) {
            // A draft this module did not retire: the owner paused it.
            memory.rules[decl.key] = { ruleId: found.id };
            outcomes.push({
              key: decl.key,
              status: "owner_choice",
              ruleId: found.id,
              reason: "paused by its owner — left paused",
            });
            continue;
          }
          // Retired by this module, declared again → re-activate (recompiles).
          const r = await updateRuleGoverned({
            userId: input.userId,
            ...agent,
            ruleId: found.id,
            workspaceId: pb.workspaceId,
            intent: decl.intent,
            scope: found.meta.scope,
            sentence: decl.sentence,
            draft: false,
            seed,
            auditSource: "playbook-activator",
          });
          outcomes.push(updateOutcome(decl.key, found.id, r, "reactivated"));
          if (r.status === "updated") {
            liveRuleIds.add(found.id);
            memory.rules[decl.key] = { ruleId: found.id };
          }
          continue;
        }
        memory.rules[decl.key] = { ruleId: found.id };
        const d = decideTemplateRule({
          decl,
          stored: found.meta,
          ref: null,
          refRowExists: false,
        });
        if (d.action === "update") {
          const r = await updateRuleGoverned({
            userId: input.userId,
            ...agent,
            ruleId: found.id,
            workspaceId: pb.workspaceId,
            intent: decl.intent,
            scope: found.meta.scope,
            sentence: decl.sentence,
            seed,
            auditSource: "playbook-activator",
          });
          outcomes.push(updateOutcome(decl.key, found.id, r, "updated"));
        } else {
          outcomes.push({
            key: decl.key,
            status:
              d.action === "none" ? toOutcomeStatus(d.status) : "unchanged",
            ruleId: found.id,
          });
        }
        liveRuleIds.add(found.id);
        continue;
      }

      if (remembered) {
        // This key produced a rule that is gone: its owner deleted it.
        outcomes.push({
          key: decl.key,
          status: "owner_choice",
          ruleId: remembered.ruleId,
          reason: "deleted by its owner — not recreated",
        });
        continue;
      }

      const offer = await priorOffer(template, decl.key);
      if (offer) {
        outcomes.push({
          key: decl.key,
          status: "offered",
          proposalId: offer.id,
          reason:
            offer.status === "pending"
              ? "already waiting for review"
              : "declined earlier — not re-offered",
        });
        continue;
      }

      const r = await createRuleGoverned({
        userId: input.userId,
        ...agent,
        workspaceId: pb.workspaceId,
        intent: decl.intent,
        scope,
        sentence: decl.sentence,
        seed,
        auditSource: "playbook-activator",
      });
      if (r.status === "created") {
        outcomes.push({ key: decl.key, status: "created", ruleId: r.ruleId });
        liveRuleIds.add(r.ruleId);
        memory.rules[decl.key] = { ruleId: r.ruleId };
      } else if (r.status === "proposed") {
        outcomes.push({
          key: decl.key,
          status: "offered",
          proposalId: r.proposalId,
        });
      } else {
        outcomes.push({ key: decl.key, status: "denied", reason: r.reason });
      }
    } catch (err) {
      outcomes.push({
        key: decl.key,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Retire what is no longer declared (and duplicate rows of one key) ─────
  const toRetire = [
    ...[...byKey]
      .filter(([key, found]) => !declaredKeys.has(key) && !found.meta.draft)
      .map(([key, found]) => ({ key, ...found, duplicate: false })),
    ...duplicates.map((d) => ({ ...d, duplicate: true })),
  ];
  for (const found of toRetire) {
    const key = found.key;
    try {
      const r = await updateRuleGoverned({
        userId: input.userId,
        ...agent,
        ruleId: found.id,
        workspaceId: pb.workspaceId,
        intent: found.meta.intent,
        scope: found.meta.scope,
        draft: true,
        auditSource: "playbook-activator",
      });
      outcomes.push(updateOutcome(key, found.id, r, "retired"));
      if (r.status === "updated" && !found.duplicate) {
        memory.rules[key] = { ruleId: found.id, retired: true };
      }
    } catch (err) {
      outcomes.push({
        key,
        status: "failed",
        ruleId: found.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // A key neither declared nor backed by a rule is forgotten (re-declaring it
  // later creates afresh); an undeclared key whose rule the OWNER paused keeps
  // no claim either.
  for (const key of Object.keys(memory.rules)) {
    if (declaredKeys.has(key)) continue;
    const row = byKey.get(key);
    if (!row || memory.rules[key]!.retired !== true) delete memory.rules[key];
  }

  await syncActivatorLinks(pb.id, [...liveRuleIds]);
  if (JSON.stringify(memory.rules) !== memoryBefore) {
    await db
      .update(playbooks)
      .set({
        metadata: drizzleSql`jsonb_set(COALESCE(${playbooks.metadata}, '{}'::jsonb), ${`{${ACTIVATOR_MEMORY_KEY}}`}::text[], ${JSON.stringify(memory)}::jsonb, true)`,
      })
      .where(eq(playbooks.id, pb.id));
  }

  const bad = outcomes.filter(
    (o) => o.status === "failed" || o.status === "denied"
  );
  if (bad.length > 0) {
    logger.warn(
      { playbookId: pb.id, outcomes: bad },
      "some activators did not compile into a rule"
    );
  }
  return { playbookId: pb.id, status: "applied", outcomes };
}

/**
 * The ONE non-fatal wrapper every caller uses (playbooks create / update /
 * archive, the installed-playbook reconcile): the playbook write already
 * committed, so a pass that throws is logged and retried by the next write or
 * boot — never allowed to fail the write that declared the activators.
 */
export async function convergePlaybookActivatorsSafely(input: {
  playbookId: string;
  userId: string;
  agentUserId?: string | null;
}): Promise<void> {
  try {
    await applyPlaybookActivators(input);
  } catch (err) {
    logger.error(
      { err, playbookId: input.playbookId },
      "playbook activators did not converge — the next write or boot reconcile retries"
    );
  }
}

function toOutcomeStatus(s: string): ActivatorOutcomeStatus {
  return s === "unchanged" || s === "kept" || s === "conflict"
    ? s
    : "unchanged";
}

function updateOutcome(
  key: string,
  ruleId: string,
  r: Awaited<ReturnType<typeof updateRuleGoverned>>,
  ok: ActivatorOutcomeStatus
): ActivatorOutcome {
  if (r.status === "updated") return { key, status: ok, ruleId };
  if (r.status === "proposed")
    return { key, status: "offered", ruleId, proposalId: r.proposalId };
  return {
    key,
    status: "denied",
    ruleId,
    reason: "reason" in r ? r.reason : r.status,
  };
}

/** A pending or declined `rule/create` proposal already carrying this seed. */
async function priorOffer(
  template: string,
  key: string
): Promise<{ id: string; status: string } | null> {
  const [row] = await db
    .select({ id: proposals.id, status: proposals.status })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "rule"),
        inArray(proposals.status, ["pending", "rejected"]),
        drizzleSql`coalesce(${proposals.data}->'seed', ${proposals.data}->'data'->'seed') @> ${JSON.stringify({ template, key })}::jsonb`
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * The automations of the LIVE activator rules are linked with role
 * `activator`; every other `activator` link of this playbook is removed (a
 * retired rule's archived automation, a rule since deleted by its owner). A
 * rule's automations are read through the ONE lineage reader
 * (`readRuleAutomationIds`, the `skill --activates--> automation` edge).
 */
async function syncActivatorLinks(
  playbookId: string,
  liveRuleIds: string[]
): Promise<void> {
  const live: string[] = [];
  for (const id of liveRuleIds) {
    for (const a of await readRuleAutomationIds(id)) {
      if (!live.includes(a)) live.push(a);
    }
  }
  for (const automationId of live) {
    await db
      .insert(playbookAutomations)
      .values({ playbookId, automationId, role: ACTIVATOR_ROLE })
      .onConflictDoUpdate({
        target: [
          playbookAutomations.playbookId,
          playbookAutomations.automationId,
        ],
        set: { role: ACTIVATOR_ROLE, updatedAt: new Date() },
      });
  }
  await db
    .delete(playbookAutomations)
    .where(
      and(
        eq(playbookAutomations.playbookId, playbookId),
        eq(playbookAutomations.role, ACTIVATOR_ROLE),
        ...(live.length > 0
          ? [notInArray(playbookAutomations.automationId, live)]
          : [])
      )
    );
}
