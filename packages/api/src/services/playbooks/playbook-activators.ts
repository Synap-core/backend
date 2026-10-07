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
 *   found but RETIRED (draft)      → re-activated (draft: false), restamped
 *   not found, an earlier offer    → not re-offered (a pending OR declined
 *     (pending/rejected proposal     `rule/create` proposal carrying this seed —
 *     with this seed)                the memory template-rules keeps in the
 *                                    brief, kept here on the proposal itself)
 *   not found                      → create
 * A rule whose key is no longer declared is RETIRED through the same door
 * (`updateRuleGoverned({ draft: true })` — its automation is archived, the rule
 * stays visible and cannot fire) and its activator link is removed. A STORED
 * activator list that fails to parse retires nothing: corrupt is not empty.
 *
 * NON-FATAL by contract: every outcome is returned; nothing here throws past a
 * caller that is creating or updating the playbook itself.
 */

import { createLogger } from "@synap-core/core";
import { humanizeToken } from "@synap-core/types/vocabulary";
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
  const kind = humanizeToken(profileSlug).toLowerCase();
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
  const [pb] = await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
    })
    .from(playbooks)
    .where(eq(playbooks.id, input.playbookId))
    .limit(1);
  if (!pb) {
    return { playbookId: input.playbookId, status: "no_playbook", outcomes: [] };
  }
  const process = readPlaybookProcess(pb.subjectProfile);
  if (process.activatorsInvalid) {
    logger.error(
      { playbookId: pb.id },
      "stored activators did not parse — no activator rule was created or retired"
    );
    return { playbookId: pb.id, status: "invalid", outcomes: [] };
  }

  const template = activatorSeedTemplate(pb.id);
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
  const byKey = new Map<string, { id: string; meta: RuleMetadata }>();
  for (const row of rows) {
    const meta = readRuleMetadata(row.metadata as Record<string, unknown>);
    if (meta?.seed && !byKey.has(meta.seed.key))
      byKey.set(meta.seed.key, { id: row.id, meta });
  }

  const outcomes: ActivatorOutcome[] = [];
  const declaredKeys = new Set<string>();
  /** Rules that should be LIVE after this pass — their automations get linked. */
  const liveRuleIds = new Set<string>();

  for (const activator of process.activators) {
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
    try {
      const found = byKey.get(decl.key) ?? null;
      if (found) {
        const d = decideTemplateRule({
          decl,
          stored: found.meta,
          ref: null,
          refRowExists: false,
        });
        if (found.meta.draft) {
          // Retired earlier, declared again → re-activate (recompiles).
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
          if (r.status === "updated") liveRuleIds.add(found.id);
          continue;
        }
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
            status: d.action === "none" ? toOutcomeStatus(d.status) : "unchanged",
            ruleId: found.id,
          });
        }
        liveRuleIds.add(found.id);
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

  // ── Retire what is no longer declared ─────────────────────────────────────
  for (const [key, found] of byKey) {
    if (declaredKeys.has(key)) continue;
    if (found.meta.draft) continue; // already retired
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
    } catch (err) {
      outcomes.push({
        key,
        status: "failed",
        ruleId: found.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await syncActivatorLinks(pb.id, [...liveRuleIds]);

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
        target: [playbookAutomations.playbookId, playbookAutomations.automationId],
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
