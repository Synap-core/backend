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
import { effectiveWorkerSize } from "@synap-core/types/workers";
import { playbookActivatorSentence } from "@synap-core/types/automations";
import {
  db,
  skills,
  playbooks,
  profiles,
  workspaces,
  ProfileResolutionService,
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

/**
 * The seed namespace of one playbook's PROJECT enablements (`workers.enable`).
 * A namespace of its own, so the space pass's retire-what-is-undeclared sweep
 * of `playbook-activator:<id>` can never touch them.
 */
export function workerSeedTemplate(playbookId: string): string {
  return `playbook-worker:${playbookId}`;
}

/** A project enablement's seed key: `<activatorKey>@project:<id>[@track:<id>]`. */
export function workerEnablementKey(input: {
  activatorKey: string;
  projectId: string;
  trackId?: string | null;
}): string {
  return `${input.activatorKey}@project:${input.projectId}${
    input.trackId ? `@track:${input.trackId}` : ""
  }`;
}

export function parseWorkerEnablementKey(key: string): {
  activatorKey: string;
  projectId: string;
  trackId: string | null;
} | null {
  const m = /^(.*)@project:([^@]+)(?:@track:([^@]+))?$/.exec(key);
  if (!m) return null;
  return { activatorKey: m[1]!, projectId: m[2]!, trackId: m[3] ?? null };
}

/** Every rule of one seed namespace, with its parsed metadata. */
export async function rulesOfSeedTemplate(
  template: string
): Promise<Array<{ id: string; meta: RuleMetadata }>> {
  return (await rulesOfSeedTemplates([template])).get(template) ?? [];
}

/**
 * {@link rulesOfSeedTemplate} for MANY namespaces in one read (the worker
 * list reads two per playbook — backend F13). Every asked template is in the
 * result, `[]` when it has no rule.
 */
export async function rulesOfSeedTemplates(
  templates: readonly string[]
): Promise<Map<string, Array<{ id: string; meta: RuleMetadata }>>> {
  const out = new Map<string, Array<{ id: string; meta: RuleMetadata }>>(
    templates.map((t) => [t, []])
  );
  if (templates.length === 0) return out;
  const rows = await db
    .select({ id: skills.id, metadata: skills.metadata })
    .from(skills)
    .where(
      and(
        eq(skills.category, RULE_CATEGORY),
        inArray(
          drizzleSql<string>`${skills.metadata}->'rule'->'seed'->>'template'`,
          [...out.keys()]
        )
      )
    );
  for (const row of rows) {
    const meta = readRuleMetadata(row.metadata as Record<string, unknown>);
    // Re-checked on the parsed stamp: a row whose JSON matched but whose
    // stamp does not parse to an asked namespace is not ours to converge.
    const template = meta?.seed?.template;
    if (meta && template && out.has(template)) {
      out.get(template)!.push({ id: row.id, meta });
    }
  }
  return out;
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
 *
 * STAGE WORKERS (work model L4). EVERY compiled node carries a worker spec
 * (`PlaybookRunWorkerSpec`: size, status, threshold, backlog limit), so every
 * enablement — the space-wide one each install keeps included — runs behind
 * the worker floors: the approvals backlog, the stale-transition check and the
 * irreversible-send ceiling (D4). Until compile version 2
 * (`ACTIVATOR_COMPILE_VERSION`) a plain space-wide `created` /
 * `enters_status` activator compiled with NO spec; the version bump makes
 * each such untouched rule re-converge once. A per_moment worker's node runs
 * (`mode` omitted) and carries the declared mode as `writes`: "propose"
 * makes every agent write inside the batch a proposal. `manual` compiles NO
 * rule (it is a button over the enablement's filter).
 */
export function activatorRuleDecl(input: {
  activator: PlaybookActivator;
  playbookId: string;
  playbookName: string;
  profileSlug: string;
  statusProperty: string | null;
  /**
   * The subject profile as the pod knows it: a kind or a role, and the
   * property its declared lifecycle lives on (null = none declared). Decides
   * which event an `enters_status` follows — see `playbookActivatorSentence`.
   */
  subject: SubjectLifecycle;
  /** A PROJECT enablement (`workers.enable`): filing + the project's set. */
  scope?: { projectId: string; trackId?: string | null };
}):
  | TemplateRuleDecl
  | { key: string; error: string }
  | { key: string; manual: true } {
  const { activator: a, playbookId, profileSlug, subject } = input;
  const key = activatorKey(a);
  if (a.on === "manual") return { key, manual: true };
  const kind = resolveObjectNoun(profileSlug).toLowerCase();
  const size = effectiveWorkerSize(a);
  const perMoment = size === "per_moment";
  const verb = a.mode === "propose" && !perMoment ? "propose running" : "run";
  const worker = {
    key,
    size,
    profileSlug,
    ...(a.status ? { status: a.status } : {}),
    ...(a.on === "count" && a.min !== undefined ? { minCount: a.min } : {}),
    ...(a.maxPendingApprovals !== undefined
      ? { maxPendingApprovals: a.maxPendingApprovals }
      : {}),
    ...(perMoment ? { writes: a.mode } : {}),
  };
  const common = {
    playbookId,
    profileSlug,
    // A batch RUNS; whether its writes propose rides on `worker.writes`.
    mode: perMoment ? ("run" as const) : a.mode,
    worker,
    ...(input.scope ? { projectId: input.scope.projectId } : {}),
    ...(input.scope?.trackId ? { trackId: input.scope.trackId } : {}),
  };
  const where = input.scope ? " in this project" : "";
  const batch = perMoment ? "on them" : "on it";
  const tail =
    perMoment && a.mode === "propose" ? ", proposing every change" : "";

  if (a.on === "schedule") {
    return {
      key,
      intent: `On schedule (${a.cron}), ${verb} "${input.playbookName}" ${batch}: every ${kind}${a.status ? ` in "${a.status}"` : ""}${where}${tail}.`,
      sentence: playbookActivatorSentence({
        ...common,
        on: "schedule",
        cron: a.cron ?? "",
      }),
    };
  }
  if (a.on === "enters_status" || a.on === "count") {
    // The declared lifecycle IS the status a process follows (work model L1):
    // a playbook that names none follows it.
    const statusProperty = input.statusProperty ?? subject.lifecycleProperty;
    if (!statusProperty || !a.status) {
      return {
        key,
        error: `an ${a.on} activator needs subjectProfile.statusProperty — the property whose value the subject enters`,
      };
    }
    const declared = subject.lifecycleProperty === statusProperty;
    if (!declared && subject.profileKind === "role") {
      // A role's status lives on its facet; only the moveStatus door's
      // transition event reports it, and only for a DECLARED lifecycle. No
      // other event fires, so any compile would be a rule that never fires.
      return {
        key,
        error: `the role "${profileSlug}" has no declared lifecycle on "${statusProperty}" — declare it (lifecycle: { property: "${statusProperty}", options }) so its moves emit a transition this activator can follow`,
      };
    }
    return {
      key,
      intent:
        a.on === "count"
          ? `When ${a.min} or more ${kind}s are in "${a.status}"${where}, ${verb} "${input.playbookName}" ${batch}${tail}.`
          : `When a ${kind} enters "${a.status}"${where}, ${verb} "${input.playbookName}" ${batch}${tail}.`,
      sentence: playbookActivatorSentence({
        ...common,
        on: a.on,
        statusProperty,
        status: a.status,
        lifecycle: declared ? "declared" : "undeclared",
      }),
    };
  }
  // A ROLE is not created, it is ATTACHED (Kind + Facets): "a lead is
  // created" means a lead role landed on a person — the facet-attach event,
  // which fires whether the role came with a new entity or onto an existing
  // one. The entity-create event names the KIND and would never match.
  const role = subject.profileKind === "role";
  return {
    key,
    intent: role
      ? `When something becomes a ${kind}${where}, ${verb} "${input.playbookName}" ${batch}${tail}.`
      : `When a ${kind} is created${where}, ${verb} "${input.playbookName}" ${batch}${tail}.`,
    sentence: playbookActivatorSentence({
      ...common,
      on: "created",
      ...(role ? { profileKind: "role" as const } : {}),
    }),
  };
}

/** What an activator needs to know about its subject profile. */
export interface SubjectLifecycle {
  profileKind: "kind" | "role";
  /** The property the profile's lifecycle is declared on; null = none. */
  lifecycleProperty: string | null;
}

/**
 * Read the subject profile's kind/role and declared lifecycle — the profile
 * the playbook's workspace sees under that slug. A slug the pod does not know
 * reads as a kind with no lifecycle: the property-change compile, exactly what
 * this module did before lifecycles existed.
 *
 * The ONE reader of "is this process's subject a kind or a role" — the stage
 * door (`focus-sessions/stage-subject-status.ts`) asks it too, so an activator
 * and the stage write can never disagree about where the status lives.
 */
export async function readSubjectProfile(
  profileSlug: string,
  workspaceId: string | null
): Promise<SubjectLifecycle> {
  const rows = await db
    .select({
      id: profiles.id,
      profileKind: profiles.profileKind,
      workspaceId: profiles.workspaceId,
    })
    .from(profiles)
    .where(eq(profiles.slug, profileSlug));
  // The space's own profile wins over the pod-wide one of the same slug.
  const row =
    rows.find((r) => workspaceId && r.workspaceId === workspaceId) ??
    rows.find((r) => r.workspaceId === null) ??
    rows[0];
  if (!row) return { profileKind: "kind", lifecycleProperty: null };
  const lifecycle = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycle(row.id, workspaceId);
  return {
    profileKind: row.profileKind === "role" ? "role" : "kind",
    lifecycleProperty: lifecycle?.propertySlug ?? null,
  };
}

/**
 * The activator COMPILER's version (backend-rules "version the coverage"). A
 * seed hash says "this rule is the compile of its declaration", but only as
 * the compiler of its day saw it: when the compiler starts writing something
 * new, an installed rule's stamp is still that older compile's. Each playbook
 * remembers the version its last converged pass compiled at
 * (`ActivatorMemory.compileVersion`); the boot pass converges every playbook
 * still behind, ONCE — through the same three-way as any pass, so an owner's
 * edit is kept, a pause left paused, a deletion not undone.
 *
 *   1 — before D4: a plain space-wide created / enters_status activator
 *       compiled with no worker spec (absent memory reads as 1);
 *   2 — every activator carries the worker spec (D4).
 *
 * Bump it whenever `activatorRuleDecl` starts writing a different decl for an
 * unchanged declaration.
 */
export const ACTIVATOR_COMPILE_VERSION = 2;

/** One playbook's memory of the rules its activators produced (see header). */
interface ActivatorMemory {
  template: string;
  rules: Record<string, { ruleId: string; retired?: true }>;
  /** The compile version of the last pass that converged (absent = 1). */
  compileVersion?: number;
}

/** The `playbooks.metadata` key that holds {@link ActivatorMemory}. */
export const ACTIVATOR_MEMORY_KEY = "activatorRules" as const;

function readActivatorMemory(
  metadata: unknown,
  template: string
): ActivatorMemory {
  const raw = (metadata as Record<string, unknown> | null)?.[
    ACTIVATOR_MEMORY_KEY
  ] as
    | { template?: unknown; rules?: unknown; compileVersion?: unknown }
    | undefined;
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
  return {
    template,
    rules,
    ...(raw?.template === template &&
    typeof raw.compileVersion === "number" &&
    Number.isInteger(raw.compileVersion)
      ? { compileVersion: raw.compileVersion }
      : {}),
  };
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
  const memoryBefore = JSON.stringify(memory);
  const agent = input.agentUserId ? { agentUserId: input.agentUserId } : {};
  const scope = pb.workspaceId
    ? { kind: "workspace" as const, workspaceId: pb.workspaceId }
    : { kind: "pod" as const };

  // Every rule this playbook's activators ever produced (by seed namespace).
  const grouped = new Map<string, Array<{ id: string; meta: RuleMetadata }>>();
  for (const row of await rulesOfSeedTemplate(template)) {
    const list = grouped.get(row.meta.seed!.key) ?? [];
    list.push(row);
    grouped.set(row.meta.seed!.key, list);
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

  // Every activator needs it: `enters_status` for where the status lives,
  // `created` because a ROLE is never created — it is attached.
  const subject =
    process.profileSlug && declared.length > 0
      ? await readSubjectProfile(process.profileSlug, pb.workspaceId)
      : { profileKind: "kind" as const, lifecycleProperty: null };
  for (const activator of declared) {
    const built = process.profileSlug
      ? activatorRuleDecl({
          activator,
          playbookId: pb.id,
          playbookName: pb.name,
          profileSlug: process.profileSlug,
          statusProperty: process.statusProperty,
          subject,
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
    if ("manual" in built) {
      // A button, not a trigger: nothing to compile (header).
      outcomes.push({
        key: built.key,
        status: "unchanged",
        reason: "manual — runs from its button, compiles no rule",
      });
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
  // ── PROJECT enablements (`workers.enable`, their own namespace) ──────────
  // Each follows its declared activator: recompiled when the declaration
  // moves, retired (by us, remembered) when it is no longer declared or the
  // playbook is not live, re-activated when declared again. One a PERSON
  // disabled (a draft we did not retire) stays off. Never created here —
  // enabling is the person's act, through `workers.enable`.
  const workerRows = await rulesOfSeedTemplate(workerSeedTemplate(pb.id));
  for (const row of workerRows) {
    const key = row.meta.seed!.key;
    try {
      const parsed = parseWorkerEnablementKey(key);
      const activator = parsed
        ? declared.find((a) => activatorKey(a) === parsed.activatorKey)
        : undefined;
      const built =
        parsed && activator && process.profileSlug
          ? activatorRuleDecl({
              activator,
              playbookId: pb.id,
              playbookName: pb.name,
              profileSlug: process.profileSlug,
              statusProperty: process.statusProperty,
              subject,
              scope: { projectId: parsed.projectId, trackId: parsed.trackId },
            })
          : null;
      const remembered = memory.rules[key];
      if (!built || "error" in built || "manual" in built) {
        if (!row.meta.draft) {
          const r = await updateRuleGoverned({
            userId: input.userId,
            ...agent,
            ruleId: row.id,
            workspaceId: pb.workspaceId,
            intent: row.meta.intent,
            scope: row.meta.scope,
            draft: true,
            auditSource: "playbook-activator",
          });
          outcomes.push(updateOutcome(key, row.id, r, "retired"));
          if (r.status === "updated")
            memory.rules[key] = { ruleId: row.id, retired: true };
        }
        continue;
      }
      const seed: RuleSeed = {
        template: workerSeedTemplate(pb.id),
        key,
        hash: templateRuleHash(built),
      };
      if (row.meta.draft) {
        if (!(remembered?.ruleId === row.id && remembered.retired)) {
          outcomes.push({
            key,
            status: "owner_choice",
            ruleId: row.id,
            reason: "disabled by a person — left off",
          });
          continue;
        }
        const r = await updateRuleGoverned({
          userId: input.userId,
          ...agent,
          ruleId: row.id,
          workspaceId: pb.workspaceId,
          intent: built.intent,
          scope: row.meta.scope,
          sentence: built.sentence,
          draft: false,
          seed,
          auditSource: "playbook-activator",
        });
        outcomes.push(updateOutcome(key, row.id, r, "reactivated"));
        if (r.status === "updated") {
          liveRuleIds.add(row.id);
          delete memory.rules[key];
        }
        continue;
      }
      const d = decideTemplateRule({
        decl: built,
        stored: row.meta,
        ref: null,
        refRowExists: false,
      });
      if (d.action === "update") {
        const r = await updateRuleGoverned({
          userId: input.userId,
          ...agent,
          ruleId: row.id,
          workspaceId: pb.workspaceId,
          intent: built.intent,
          scope: row.meta.scope,
          sentence: built.sentence,
          seed,
          auditSource: "playbook-activator",
        });
        outcomes.push(updateOutcome(key, row.id, r, "updated"));
      } else {
        outcomes.push({
          key,
          status: d.action === "none" ? toOutcomeStatus(d.status) : "unchanged",
          ruleId: row.id,
        });
      }
      liveRuleIds.add(row.id);
    } catch (err) {
      outcomes.push({
        key,
        status: "failed",
        ruleId: row.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A key neither declared nor backed by a rule is forgotten (re-declaring it
  // later creates afresh); an undeclared key whose rule the OWNER paused keeps
  // no claim either.
  for (const key of Object.keys(memory.rules)) {
    if (declaredKeys.has(key)) continue;
    if (parseWorkerEnablementKey(key)) {
      // A project enablement's memory lives while its rule does.
      if (!workerRows.some((r) => r.id === memory.rules[key]!.ruleId))
        delete memory.rules[key];
      continue;
    }
    const row = byKey.get(key);
    if (!row || memory.rules[key]!.retired !== true) delete memory.rules[key];
  }

  await syncActivatorLinks(pb.id, [...liveRuleIds]);
  // The compile version is a marker: stamped only by a pass where every
  // declared activator converged. A failed or refused one is retried at the
  // next boot (an unchanged decl writes nothing, so a retry costs a read).
  if (!outcomes.some((o) => o.status === "failed" || o.status === "denied")) {
    memory.compileVersion = ACTIVATOR_COMPILE_VERSION;
  }
  if (JSON.stringify(memory) !== memoryBefore) {
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

/**
 * BOOT: converge every live playbook that declares activators and is either
 *   - compiled at an older `ACTIVATOR_COMPILE_VERSION` (its memory says so,
 *     or has none) — the once-per-version re-convergence (D4), or
 *   - declares an `enters_status` activator — the recompile of rules whose
 *     subject profile has since declared (or retired) its lifecycle.
 *
 * Not a conversion op: the recompile IS the activator convergence above —
 * the governed rule door, the three-way seed stamp (an owner-edited rule is
 * KEPT, never rewritten), the owner's pause and delete respected. A raw SQL
 * rewrite of `trigger_config` would bypass all three. Template-installed
 * playbooks already reach this pass on every boot (the installed-playbook
 * reconcile); this covers pod-local ones (`synap_create_playbook`), which
 * otherwise converge only on their next write. Idempotent: an unchanged decl
 * writes nothing, and a converged playbook stamps the version so the next
 * boot skips it. Attributed like the template reconcile: the space owner, or
 * the playbook's creator for a pod-wide one.
 */
export async function convergeActivatorsAtBoot(): Promise<{
  playbooks: number;
  failed: number;
}> {
  const rows = await db
    .select({
      id: playbooks.id,
      createdBy: playbooks.createdBy,
      ownerId: workspaces.ownerId,
    })
    .from(playbooks)
    .leftJoin(workspaces, eq(workspaces.id, playbooks.workspaceId))
    .where(
      and(
        eq(playbooks.status, "active"),
        drizzleSql`jsonb_array_length(coalesce(${playbooks.subjectProfile}->'activators', '[]'::jsonb)) > 0`,
        drizzleSql`(
          ${playbooks.subjectProfile}->'activators' @> '[{"on":"enters_status"}]'::jsonb
          OR coalesce((${playbooks.metadata}->${ACTIVATOR_MEMORY_KEY}->>'compileVersion')::int, 1) < ${ACTIVATOR_COMPILE_VERSION}
        )`
      )
    );
  let failed = 0;
  for (const row of rows) {
    const userId = row.ownerId ?? row.createdBy;
    try {
      await applyPlaybookActivators({ playbookId: row.id, userId });
    } catch (err) {
      failed++;
      logger.error(
        { err, playbookId: row.id },
        "activators did not converge at boot — the next write or boot retries"
      );
    }
  }
  return { playbooks: rows.length, failed };
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
