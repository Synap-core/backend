/**
 * STAGE WORKERS — enable, pause, list (work model L4).
 *
 * A worker is DECLARED by a playbook on a lifecycle (`activators[]`, catalog)
 * and ENABLED for a scope. An enablement is ONE governed rule (no new table,
 * no new noun), compiled by `activatorRuleDecl`:
 *
 *   space    — the rule installing an active playbook compiles
 *              (`playbook-activator:<pbId>`, key = the activator key). Shown as
 *              "Runs for the whole space". Never created here: the activator
 *              convergence owns it; a person pauses / resumes it.
 *   project  — `workers.enable` for a project (a track enables for its own
 *              project, and its sessions are filed in the track):
 *              `playbook-worker:<pbId>`, key `<activatorKey>@project:<id>`.
 *
 * Every write goes through the ONE rule door (`createRuleGoverned` /
 * `updateRuleGoverned`): a person's call executes, an agent's files a
 * proposal. Each is followed by the activator pass, which keeps the
 * `playbook_automations` activator links in step with what is live.
 *
 * OVERLAP is refused at enable, at resume and at the approval of an agent's
 * enable or resume (`assertNoWorkerOverlap`), naming the holder: the same activator already
 * LIVE for the whole space, or for the same project (two tracks of one project
 * enabling one worker = overlap — a track's filter is its project). Two
 * different projects never overlap. Two concurrent enables that both pass
 * the check are settled AFTER the write: the later row (larger id) steps back
 * to a draft and its caller is refused — no lock is held across the rule
 * door, which commits on its own connections.
 *
 * `listEnabledWorkers` is the ONE reader: the track page's Workers section,
 * `lifecycle.board`'s `hasWorker`, the relay track page.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  playbooks,
  automations,
  skills,
  countWorkerPendingApprovalsBulk,
  userVisibleWhere,
} from "@synap/database";
import type { PlaybookActivator } from "@synap/playbooks";
import {
  DEFAULT_WORKER_MAX_PENDING_APPROVALS,
  effectiveWorkerSize,
  type WorkerScopeKind,
  type WorkerSize,
} from "@synap-core/types/workers";
import {
  activatorKey,
  readPlaybookProcess,
} from "../../schemas/playbook-process.js";
import { createRuleGoverned } from "../rules/create.js";
import { updateRuleGoverned } from "../rules/update.js";
import { readRuleHealthBulk } from "../rules/lineage.js";
import {
  templateRuleHash,
  type TemplateRuleDecl,
} from "../rules/template-rules.js";
import {
  RULE_CATEGORY,
  readRuleMetadata,
  type RuleMetadata,
} from "../rules/index.js";
import {
  activatorRuleDecl,
  activatorSeedTemplate,
  applyPlaybookActivators,
  parseWorkerEnablementKey,
  readSubjectProfile,
  rulesOfSeedTemplate,
  rulesOfSeedTemplates,
  workerEnablementKey,
  workerSeedTemplate,
} from "./playbook-activators.js";

/** Refused enable: this worker already runs over (part of) the same things. */
export const WORKER_SCOPE_OVERLAP = "WORKER_SCOPE_OVERLAP" as const;

export class WorkerScopeOverlapError extends Error {
  readonly reasonCode = WORKER_SCOPE_OVERLAP;
  constructor(
    message: string,
    readonly holder: {
      ruleId: string;
      scope: WorkerScopeKind;
      projectId: string | null;
      trackId: string | null;
    }
  ) {
    super(message);
    this.name = "WorkerScopeOverlapError";
  }
}

/** One enablement as every surface reads it. */
export interface EnabledWorker {
  /** The rule — what pause / resume act on. */
  ruleId: string;
  playbookId: string;
  playbookName: string;
  activatorKey: string;
  /** The declared activator; null when the playbook no longer declares it. */
  activator: PlaybookActivator | null;
  /** The kind or role it works on. */
  profileSlug: string | null;
  size: WorkerSize;
  mode: "run" | "propose";
  scope: WorkerScopeKind;
  projectId: string | null;
  trackId: string | null;
  /** `paused` = its rule is a draft: nothing fires. */
  state: "running" | "paused";
  /** The automation that fires it (null while paused). */
  automationId: string | null;
  /** Approvals waiting on a person, and the limit past which it stops. */
  pendingApprovals: number;
  maxPendingApprovals: number;
}

interface PlaybookRow {
  id: string;
  name: string;
  status: string;
  workspaceId: string | null;
  subjectProfile: unknown;
}

async function visiblePlaybooks(input: {
  userId: string;
  playbookId?: string;
  profileSlug?: string;
}): Promise<PlaybookRow[]> {
  return db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      status: playbooks.status,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
    })
    .from(playbooks)
    .where(
      and(
        userVisibleWhere(playbooks.workspaceId, input.userId),
        ...(input.playbookId ? [eq(playbooks.id, input.playbookId)] : []),
        ...(input.profileSlug
          ? [
              drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${input.profileSlug}`,
            ]
          : []),
        drizzleSql`jsonb_array_length(coalesce(${playbooks.subjectProfile}->'activators', '[]'::jsonb)) > 0`
      )
    );
}

/** A rule's enablement scope, read off its seed. */
function enablementOf(
  pbId: string,
  meta: RuleMetadata
): {
  activatorKey: string;
  scope: WorkerScopeKind;
  projectId: string | null;
  trackId: string | null;
} | null {
  const seed = meta.seed;
  if (!seed) return null;
  if (seed.template === activatorSeedTemplate(pbId)) {
    return {
      activatorKey: seed.key,
      scope: "space",
      projectId: null,
      trackId: null,
    };
  }
  if (seed.template === workerSeedTemplate(pbId)) {
    const p = parseWorkerEnablementKey(seed.key);
    return p
      ? {
          activatorKey: p.activatorKey,
          scope: "project",
          projectId: p.projectId,
          trackId: p.trackId,
        }
      : null;
  }
  return null;
}

/**
 * The ACTIVE automation of each rule (null when none), in two reads: the
 * rules' activates-edges (`readRuleHealthBulk`, the lineage store) and the
 * automations among them that are active.
 */
async function activeAutomationsOf(
  ruleIds: readonly string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(ruleIds.map((id) => [id, null]));
  if (ruleIds.length === 0) return out;
  const health = await readRuleHealthBulk([...out.keys()]);
  const all = [
    ...new Set([...health.values()].flatMap((h) => h.automationIds)),
  ];
  if (all.length === 0) return out;
  const active = new Set(
    (
      await db
        .select({ id: automations.id })
        .from(automations)
        .where(
          and(inArray(automations.id, all), eq(automations.status, "active"))
        )
    ).map((r) => r.id)
  );
  for (const [ruleId, h] of health) {
    out.set(ruleId, h.automationIds.find((id) => active.has(id)) ?? null);
  }
  return out;
}

/**
 * THE reader of enabled workers. Filters compose:
 *   profileSlug — workers whose playbook's subject is this kind or role;
 *   projectId   — workers that run over that project's things: space-wide
 *                 ones (they cover it) and ones enabled for that project;
 *   trackId     — its project's workers (a track's filter is its project).
 * `liveOnly` drops paused ones (what `hasWorker` asks).
 */
export async function listEnabledWorkers(input: {
  userId: string;
  profileSlug?: string;
  projectId?: string | null;
  trackId?: string | null;
  playbookId?: string;
  liveOnly?: boolean;
}): Promise<EnabledWorker[]> {
  let projectId = input.projectId ?? null;
  if (input.trackId) {
    const { getTrack } = await import("../tracks/tracks-service.js");
    const track = await getTrack(input.trackId, { userId: input.userId });
    if (!track) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Track not found" });
    }
    if (projectId && projectId !== track.projectId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "trackId belongs to another project than projectId.",
      });
    }
    projectId = track.projectId;
  }
  const pbs = await visiblePlaybooks({
    userId: input.userId,
    playbookId: input.playbookId,
    profileSlug: input.profileSlug,
  });
  // Three reads for the whole list, whatever its size (backend F13): every
  // seed namespace's rules, the live rules' active automations, and their
  // pending approvals.
  const rulesByTemplate = await rulesOfSeedTemplates(
    pbs.flatMap((pb) => [
      activatorSeedTemplate(pb.id),
      workerSeedTemplate(pb.id),
    ])
  );
  const found: Array<{
    pb: PlaybookRow;
    process: ReturnType<typeof readPlaybookProcess>;
    row: { id: string; meta: RuleMetadata };
    en: NonNullable<ReturnType<typeof enablementOf>>;
    paused: boolean;
  }> = [];
  for (const pb of pbs) {
    const process = readPlaybookProcess(pb.subjectProfile);
    const rows = [
      ...(rulesByTemplate.get(activatorSeedTemplate(pb.id)) ?? []),
      ...(rulesByTemplate.get(workerSeedTemplate(pb.id)) ?? []),
    ];
    for (const row of rows) {
      const en = enablementOf(pb.id, row.meta);
      if (!en) continue;
      if (projectId && en.scope === "project" && en.projectId !== projectId)
        continue;
      const paused = row.meta.draft === true;
      if (input.liveOnly && paused) continue;
      found.push({ pb, process, row, en, paused });
    }
  }
  const automationOf = await activeAutomationsOf(
    found.filter((f) => !f.paused).map((f) => f.row.id)
  );
  const pending = await countWorkerPendingApprovalsBulk(
    [...automationOf.values()].filter((id): id is string => !!id)
  );
  const out: EnabledWorker[] = [];
  for (const { pb, process, row, en, paused } of found) {
    const automationId = paused ? null : (automationOf.get(row.id) ?? null);
    if (input.liveOnly && !automationId) continue;
    const activator =
      process.activators.find((a) => activatorKey(a) === en.activatorKey) ??
      null;
    out.push({
      ruleId: row.id,
      playbookId: pb.id,
      playbookName: pb.name,
      activatorKey: en.activatorKey,
      activator,
      profileSlug: process.profileSlug,
      size: activator ? effectiveWorkerSize(activator) : "per_thing",
      mode: activator?.mode ?? "propose",
      scope: en.scope,
      projectId: en.projectId,
      trackId: en.trackId,
      state: paused ? "paused" : "running",
      automationId,
      pendingApprovals: automationId ? (pending.get(automationId) ?? 0) : 0,
      maxPendingApprovals:
        activator?.maxPendingApprovals ?? DEFAULT_WORKER_MAX_PENDING_APPROVALS,
    });
  }
  return out;
}

/**
 * The LIVE enablement this one would overlap, as the refusal to throw, or null
 * when it is free. `projectId` null = the whole space, which overlaps every
 * live project enablement of the activator; a project overlaps the space one
 * and the same project's (any track of it). Two different projects never do.
 *
 * Of several holders the one with the SMALLEST id is named: the post-write
 * settle in `enableWorker` keeps the smallest live id, so with three
 * concurrent enables (A < B < C) B must see A, not C, or A and B both stay.
 */
async function findOverlap(input: {
  playbookId: string;
  activatorKey: string;
  projectId: string | null;
  excludeRuleId?: string;
}): Promise<WorkerScopeOverlapError | null> {
  const live = (r: { id: string; meta: RuleMetadata }) =>
    !r.meta.draft && r.id !== input.excludeRuleId;
  const holders: Array<{
    ruleId: string;
    scope: WorkerScopeKind;
    projectId: string | null;
    trackId: string | null;
  }> = [];
  for (const r of await rulesOfSeedTemplate(
    activatorSeedTemplate(input.playbookId)
  )) {
    if (r.meta.seed!.key === input.activatorKey && live(r)) {
      holders.push({
        ruleId: r.id,
        scope: "space",
        projectId: null,
        trackId: null,
      });
    }
  }
  for (const r of await rulesOfSeedTemplate(
    workerSeedTemplate(input.playbookId)
  )) {
    const p = parseWorkerEnablementKey(r.meta.seed!.key);
    if (
      !p ||
      p.activatorKey !== input.activatorKey ||
      (input.projectId !== null && p.projectId !== input.projectId) ||
      !live(r)
    )
      continue;
    holders.push({
      ruleId: r.id,
      scope: "project",
      projectId: p.projectId,
      trackId: p.trackId,
    });
  }
  if (holders.length === 0) return null;
  const holder = holders.reduce((min, h) => (h.ruleId < min.ruleId ? h : min));
  return new WorkerScopeOverlapError(
    holder.scope === "space"
      ? "This worker already runs for the whole space — pause it there first, then enable it for this project."
      : input.projectId === null
        ? "This worker already runs for a project — pause it there first, then run it for the whole space."
        : holder.trackId
          ? "This worker already runs for this project, enabled by one of its tracks — a worker runs once per project."
          : "This worker already runs for this project.",
    holder
  );
}

/**
 * The overlap check for a rule door that knows only the rule — the approval
 * of an agent's enable or resume proposal (`rule/create`, `rule/update`
 * executors). `seed` is the one the replay stamps; with none, an existing
 * rule's (`ruleId`) is read. `ruleId` is also left out of the holders. A rule
 * that is not a worker's passes. Throws the overlap refusal; the caller maps
 * it.
 */
export async function assertNoWorkerOverlap(input: {
  seed?: { template: string; key: string } | null;
  ruleId?: string;
}): Promise<void> {
  let seed = input.seed ?? null;
  if (!seed && input.ruleId) {
    const [row] = await db
      .select({ metadata: skills.metadata })
      .from(skills)
      .where(
        and(eq(skills.id, input.ruleId), eq(skills.category, RULE_CATEGORY))
      )
      .limit(1);
    seed = row
      ? (readRuleMetadata(row.metadata as Record<string, unknown>)?.seed ??
        null)
      : null;
  }
  if (!seed) return;
  let target: {
    playbookId: string;
    activatorKey: string;
    projectId: string | null;
  } | null = null;
  const space = activatorSeedTemplate("");
  const project = workerSeedTemplate("");
  if (seed.template.startsWith(space)) {
    target = {
      playbookId: seed.template.slice(space.length),
      activatorKey: seed.key,
      projectId: null,
    };
  } else if (seed.template.startsWith(project)) {
    const p = parseWorkerEnablementKey(seed.key);
    if (p) {
      target = {
        playbookId: seed.template.slice(project.length),
        activatorKey: p.activatorKey,
        projectId: p.projectId,
      };
    }
  }
  if (!target) return;
  const overlap = await findOverlap({
    ...target,
    excludeRuleId: input.ruleId,
  });
  if (overlap) throw overlap;
}

export type EnableWorkerResult =
  | { status: "enabled"; ruleId: string; reactivated: boolean }
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string };

/**
 * Enable a declared worker for ONE project (or one track, which files its
 * sessions there and enables for the track's project). See the header for
 * overlap and governance.
 */
export async function enableWorker(input: {
  userId: string;
  agentUserId?: string | null;
  playbookId: string;
  activatorKey: string;
  projectId?: string | null;
  trackId?: string | null;
}): Promise<EnableWorkerResult> {
  const [pb] = await visiblePlaybooks({
    userId: input.userId,
    playbookId: input.playbookId,
  });
  if (!pb) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Playbook not found, or it declares no workers.",
    });
  }
  if (pb.status !== "active") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `"${pb.name}" is not active — only a live playbook's workers can run.`,
    });
  }
  const process = readPlaybookProcess(pb.subjectProfile);
  const activator = process.activators.find(
    (a) => activatorKey(a) === input.activatorKey
  );
  if (!activator || !process.profileSlug) {
    const declared = process.activators.map((a) => activatorKey(a));
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `"${pb.name}" declares no worker "${input.activatorKey}". Declared: ${declared.join(", ") || "none"}.`,
    });
  }
  if (activator.on === "manual") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A manual worker is a button, not a trigger — run the playbook over the project instead of enabling it.",
    });
  }

  // Filing: a track names its project; a bare project must be visible.
  let projectId = input.projectId ?? null;
  let trackId: string | null = null;
  if (input.trackId) {
    const { resolveTrackFiling } = await import("../tracks/tracks-service.js");
    const filed = await resolveTrackFiling({
      trackId: input.trackId,
      projectId,
      trackStage: null,
      actor: { userId: input.userId },
    });
    projectId = filed.projectId;
    trackId = filed.trackId;
  } else if (projectId) {
    const { loadVisibleProject } =
      await import("../projects/load-visible-project.js");
    const { getDb } = await import("@synap/database");
    const project = await loadVisibleProject(
      await getDb(),
      projectId,
      input.userId
    );
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
    }
  }
  if (!projectId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Name the project (or track) to enable this worker for. Its space-wide run comes with the playbook — pause or resume that one instead.",
    });
  }

  const key = workerEnablementKey({
    activatorKey: input.activatorKey,
    projectId,
    trackId,
  });
  const subject = await readSubjectProfile(process.profileSlug, pb.workspaceId);
  const decl = activatorRuleDecl({
    activator,
    playbookId: pb.id,
    playbookName: pb.name,
    profileSlug: process.profileSlug,
    statusProperty: process.statusProperty,
    subject,
    scope: { projectId, trackId },
  });
  if ("error" in decl) return { status: "denied", reason: decl.error };
  if ("manual" in decl) {
    return { status: "denied", reason: "A manual worker compiles no rule." };
  }
  // Narrowed once, for the closures below.
  const rule: TemplateRuleDecl = decl;
  const project: string = projectId;
  const seed = {
    template: workerSeedTemplate(pb.id),
    key,
    hash: templateRuleHash(rule),
  };
  const agent = input.agentUserId ? { agentUserId: input.agentUserId } : {};

  // Overlap: refused BEFORE anything is written, naming the holder.
  const before = await findOverlap({
    playbookId: pb.id,
    activatorKey: input.activatorKey,
    projectId: project,
  });
  if (before) throw before;

  const result = await writeEnablement();

  // Two concurrent enables can both pass the check. Close the race AFTER the
  // write, deterministically: of two live overlapping rows the one with the
  // larger id steps back (made a draft) and its caller gets the refusal, so
  // exactly one survives. No lock is held across the rule door, which commits
  // on its own connections.
  if (result.status === "enabled") {
    const after = await findOverlap({
      playbookId: pb.id,
      activatorKey: input.activatorKey,
      projectId: project,
      excludeRuleId: result.ruleId,
    });
    if (after && after.holder.ruleId < result.ruleId) {
      const back = await updateRuleGoverned({
        userId: input.userId,
        ruleId: result.ruleId,
        workspaceId: pb.workspaceId,
        intent: rule.intent,
        scope: pb.workspaceId
          ? {
              kind: "workspace",
              workspaceId: pb.workspaceId,
              projectId: project,
            }
          : { kind: "pod", projectId: project },
        draft: true,
        auditSource: "playbook-worker",
      });
      // A step-back that did not apply leaves this rule LIVE beside the
      // holder: never report "refused" over it.
      if (back.status !== "updated") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `This worker overlapped another enablement and could not step back (${back.status}) — it is still running. Pause one of the two.`,
        });
      }
      throw after;
    }
  }

  async function writeEnablement(): Promise<EnableWorkerResult> {
    const same = (await rulesOfSeedTemplate(workerSeedTemplate(pb!.id))).find(
      (r) => r.meta.seed!.key === key
    );
    if (same) {
      // The same enablement, disabled earlier: turn it back on.
      const r = await updateRuleGoverned({
        userId: input.userId,
        ...agent,
        ruleId: same.id,
        workspaceId: pb!.workspaceId,
        intent: rule.intent,
        scope: same.meta.scope,
        sentence: rule.sentence,
        draft: false,
        seed,
        auditSource: "playbook-worker",
      });
      if (r.status === "updated")
        return { status: "enabled", ruleId: same.id, reactivated: true };
      if (r.status === "proposed")
        return { status: "proposed", proposalId: r.proposalId };
      return {
        status: "denied",
        reason: "reason" in r ? String(r.reason) : r.status,
      };
    }
    const r = await createRuleGoverned({
      userId: input.userId,
      ...agent,
      workspaceId: pb!.workspaceId,
      intent: rule.intent,
      scope: pb!.workspaceId
        ? {
            kind: "workspace",
            workspaceId: pb!.workspaceId,
            projectId: project,
          }
        : { kind: "pod", projectId: project },
      sentence: rule.sentence,
      seed,
      auditSource: "playbook-worker",
    });
    if (r.status === "created")
      return { status: "enabled", ruleId: r.ruleId, reactivated: false };
    if (r.status === "proposed")
      return { status: "proposed", proposalId: r.proposalId };
    return { status: "denied", reason: r.reason };
  }

  // Keep the activator links in step with what is now live.
  if (result.status === "enabled") {
    await applyPlaybookActivators({ playbookId: pb.id, userId: input.userId });
  }
  return result;
}

export type SetWorkerPausedResult =
  | { status: "updated"; state: "running" | "paused" }
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string };

/**
 * Pause or resume ONE enablement (space-wide or project). Pausing makes its
 * rule a draft (the automation is archived: nothing fires; sessions already
 * running finish). The activator convergence leaves a person's pause alone on
 * every later pass. Resuming recompiles through the rule door, and is refused
 * (the overlap error) when another enablement of the same worker is live over
 * the same things.
 */
export async function setWorkerPaused(input: {
  userId: string;
  agentUserId?: string | null;
  ruleId: string;
  paused: boolean;
}): Promise<SetWorkerPausedResult> {
  const workers = await listEnabledWorkers({ userId: input.userId });
  const w = workers.find((x) => x.ruleId === input.ruleId);
  if (!w) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Worker not found" });
  }
  const [pb] = await visiblePlaybooks({
    userId: input.userId,
    playbookId: w.playbookId,
  });
  const rows = await rulesOfSeedTemplate(
    w.scope === "space"
      ? activatorSeedTemplate(w.playbookId)
      : workerSeedTemplate(w.playbookId)
  );
  const row = rows.find((r) => r.id === input.ruleId)!;
  if (!input.paused) {
    const overlap = await findOverlap({
      playbookId: w.playbookId,
      activatorKey: w.activatorKey,
      projectId: w.scope === "space" ? null : w.projectId,
      excludeRuleId: w.ruleId,
    });
    if (overlap) throw overlap;
  }
  const r = await updateRuleGoverned({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    ruleId: input.ruleId,
    workspaceId: pb?.workspaceId ?? null,
    intent: row.meta.intent,
    scope: row.meta.scope,
    draft: input.paused,
    auditSource: "playbook-worker",
  });
  if (r.status === "updated") {
    await applyPlaybookActivators({
      playbookId: w.playbookId,
      userId: input.userId,
    });
    return { status: "updated", state: input.paused ? "paused" : "running" };
  }
  if (r.status === "proposed")
    return { status: "proposed", proposalId: r.proposalId };
  return {
    status: "denied",
    reason: "reason" in r ? String(r.reason) : r.status,
  };
}
