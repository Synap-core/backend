/**
 * Retire-into — the SAFE MOVE off a retired template (TEMPLATE-LIFECYCLE
 * Contract A, pod).
 *
 * A space whose template the catalog retired (`lifecycle: "retired"`, from
 * `template-health.ts`, the one authority) can move its data into the space of
 * the template that replaced it. Three steps, all through EXISTING doors:
 *
 *   1. install the replacement if the pod has no space for it
 *      (`workspaces.installFromCatalog`, `workspaceCatalogRouter` — catalog-resolved, never a
 *      caller-supplied definition; one space per domain is checked first, so a
 *      space that already holds the domain is USED, never twinned);
 *   2. move the entities whose kind has a home there (`entities.moveToWorkspace`);
 *   3. archive the source ONLY when nothing is left in it (`workspaces.archive`).
 *      Otherwise it stays, and the result says what remains and why.
 *
 * Nothing is ever deleted.
 *
 * Governance: the whole move is ONE `workspace/update` request
 * (`operation: "retire_into"`, ADMIN floor ⇒ an agent always proposes). On
 * approval the executor (`routers/proposals/executors/workspace.ts`) re-plans
 * against the data as it is THEN and runs the steps as the approver. A human
 * caller runs them directly.
 *
 * A kind "has a home" in the target when the target's template declares it,
 * the installed target already holds a profile of that slug, or the entity's
 * profile is pod-wide (not owned by one workspace).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  readTemplateState,
  getWorkspaceMembership,
  workspaces,
} from "@synap/database";
import { entities, profiles } from "@synap/database/schema";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import {
  resolveTemplateCatalog,
  templateHealthFor,
  type TemplateLifecycle,
} from "./template-health.js";
import { resolveWorkspaceTemplate } from "./capabilities/resolve-workspace-template.js";
import { checkOneSpacePerDomain } from "./workspace-creation-service.js";
import type { Context } from "../context.js";

/** Why a retire-into cannot be planned. */
export type RetireIntoRefusalCode =
  /** The space's template is not retired (or the space has no template). */
  | "NOT_RETIRED"
  /** Retired, but the catalog names no replacement to move into. */
  | "NO_REPLACEMENT"
  /** The replacement's template could not be read (catalog unreachable). */
  | "TEMPLATE_UNREADABLE";

export interface RetireIntoRefusal {
  status: "refused";
  code: RetireIntoRefusalCode;
  lifecycle: TemplateLifecycle | null;
  message: string;
}

export interface RetireIntoKindCount {
  kind: string;
  count: number;
}

/** A kind left in the source, and why. */
export type RetireIntoKindStay = RetireIntoKindCount & { reason: string };

export interface RetireIntoPlan {
  source: {
    workspaceId: string;
    workspaceName: string;
    packageSlug: string;
  };
  replacedBy: string;
  retiredReason: string | null;
  target: {
    slug: string;
    /** The space the data moves into, when the pod already has one. */
    workspaceId: string | null;
    workspaceName: string | null;
    /** `use_installed`: it exists. `install`: approval installs it first. */
    action: "use_installed" | "install";
    /** `action === "install"`, as a flag (the CLI reads this one). */
    willInstall: boolean;
  };
  /** What moves, by kind (most first). */
  moves: RetireIntoKindCount[];
  moveCount: number;
  /** What stays in the source, by kind, with the reason. */
  stays: RetireIntoKindStay[];
  stayCount: number;
  /** True when nothing would stay: the source is archived after the move. */
  archiveSource: boolean;
  /** One plain sentence for the reviewer. */
  summary: string;
}

export interface RetireIntoResult {
  targetWorkspaceId: string;
  installed: boolean;
  moved: number;
  /** Per-entity moves that became proposals (should be 0 for a human). */
  proposedMoves: number;
  failed: Array<{ entityId: string; error: string }>;
  /** What is still in the source after the move, by kind, with the reason. */
  remaining: RetireIntoKindStay[];
  remainingCount: number;
  archived: boolean;
  /** Why the source was kept, when it was. */
  keptBecause: string | null;
}

export type RetireIntoOutcome =
  | { status: "plan"; plan: RetireIntoPlan }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl?: string;
      plan: RetireIntoPlan;
    }
  | ({ status: "applied"; plan: RetireIntoPlan } & RetireIntoResult);

interface PlannedMove {
  plan: RetireIntoPlan;
  movableIds: string[];
}

function refuse(
  code: RetireIntoRefusalCode,
  lifecycle: TemplateLifecycle | null,
  message: string
): RetireIntoRefusal {
  return { status: "refused", code, lifecycle, message };
}

function countByKind(kinds: string[]): RetireIntoKindCount[] {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * The space that holds `slug`'s domain, when the pod has one: the identity
 * holder (an ACTIVE space whose `settings.packageSlug` is the slug — pod-wide
 * unique, 0308), else the domain twin one-space-per-domain would refuse a
 * second install for. Either way the data moves THERE, never into a new twin.
 */
async function findTargetSpace(
  slug: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  const [holder] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.archivedAt),
        drizzleSql`${workspaces.settings}->>'packageSlug' = ${slug}`
      )
    )
    .limit(1);
  if (holder) return holder;
  const verdict = await checkOneSpacePerDomain({
    userId,
    packageSlug: slug,
    idempotencyKey: slug,
  });
  if (verdict.action === "refuse") {
    return {
      id: verdict.reply.workspaceId,
      name: verdict.reply.workspaceName,
    };
  }
  return null;
}

/**
 * Plan the move for `workspaceId` as `userId` sees it. Read-only. Refuses
 * (never guesses) when the template is not provably retired-with-replacement
 * or the replacement's template cannot be read.
 */
export async function planRetireInto(input: {
  workspaceId: string;
  userId: string;
}): Promise<PlannedMove | RetireIntoRefusal> {
  const [ws] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      settings: workspaces.settings,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  const membership = ws
    ? await getWorkspaceMembership(db, ws.id, input.userId)
    : null;
  if (!ws || ws.archivedAt != null || !membership) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Space not found" });
  }

  const state = readTemplateState(ws.settings);
  const packageSlug = state?.slug ?? null;
  if (!packageSlug) {
    return refuse(
      "NOT_RETIRED",
      null,
      `"${ws.name}" was not installed from a template, so there is nothing to retire.`
    );
  }
  const health = templateHealthFor(
    packageSlug,
    state?.version ?? null,
    await resolveTemplateCatalog([packageSlug]),
    ws.settings
  );
  if (health.lifecycle !== "retired") {
    return refuse(
      "NOT_RETIRED",
      health.lifecycle,
      health.lifecycle === "unknown"
        ? `The catalog could not be fully read, so it is not known whether "${packageSlug}" was retired. Try again later.`
        : `The "${packageSlug}" template is not retired.`
    );
  }
  const replacedBy = health.replacedBy;
  if (!replacedBy) {
    return refuse(
      "NO_REPLACEMENT",
      "retired",
      `The "${packageSlug}" template was retired without a replacement, so there is no space to move its data into.`
    );
  }

  const resolved = await resolveWorkspaceTemplate(replacedBy);
  if (!resolved) {
    return refuse(
      "TEMPLATE_UNREADABLE",
      "retired",
      `The "${replacedBy}" template could not be read from the catalog right now. Try again later.`
    );
  }

  const target = await findTargetSpace(replacedBy, input.userId);

  // The kinds with a home in the target.
  const homeKinds = new Set<string>();
  for (const p of resolved.packageDefinition.profiles ?? []) {
    const slug = (p as { slug?: unknown }).slug;
    if (typeof slug === "string") homeKinds.add(slug);
  }
  if (target) {
    const targetProfiles = await db
      .select({ slug: profiles.slug })
      .from(profiles)
      .where(eq(profiles.workspaceId, target.id));
    for (const p of targetProfiles) homeKinds.add(p.slug);
  }

  const rows = await db
    .select({
      id: entities.id,
      kind: entities.type,
      profileWorkspaceId: profiles.workspaceId,
      profileId: entities.profileId,
    })
    .from(entities)
    .leftJoin(profiles, eq(profiles.id, entities.profileId))
    .where(and(eq(entities.workspaceId, ws.id), isNull(entities.deletedAt)));

  const movableIds: string[] = [];
  const movedKinds: string[] = [];
  const stayedKinds: string[] = [];
  for (const r of rows) {
    const podWide = r.profileId != null && r.profileWorkspaceId == null;
    if (homeKinds.has(r.kind) || podWide) {
      movableIds.push(r.id);
      movedKinds.push(r.kind);
    } else {
      stayedKinds.push(r.kind);
    }
  }

  const targetName = target?.name ?? replacedBy;
  const stays = countByKind(stayedKinds).map((k) => ({
    ...k,
    reason: `"${targetName}" has no place for ${resolveObjectNoun(k.kind).toLowerCase()} items.`,
  }));
  const archiveSource = stayedKinds.length === 0;
  const summary = [
    target
      ? `Move ${movableIds.length} item${movableIds.length === 1 ? "" : "s"} from "${ws.name}" into "${target.name}".`
      : `Install "${replacedBy}", then move ${movableIds.length} item${movableIds.length === 1 ? "" : "s"} from "${ws.name}" into it.`,
    archiveSource
      ? `"${ws.name}" is then empty and gets archived (not deleted).`
      : `${stayedKinds.length} item${stayedKinds.length === 1 ? "" : "s"} stay in "${ws.name}", which is kept.`,
  ].join(" ");

  return {
    movableIds,
    plan: {
      source: { workspaceId: ws.id, workspaceName: ws.name, packageSlug },
      replacedBy,
      retiredReason: health.retiredReason,
      target: {
        slug: replacedBy,
        workspaceId: target?.id ?? null,
        workspaceName: target?.name ?? null,
        action: target ? "use_installed" : "install",
        willInstall: !target,
      },
      moves: countByKind(movedKinds),
      moveCount: movableIds.length,
      stays,
      stayCount: stayedKinds.length,
      archiveSource,
      summary,
    },
  };
}

/** The three doors the apply runs through — injectable so the orchestration is testable. */
export interface RetireIntoSteps {
  install(slug: string): Promise<string>;
  move(
    entityIds: string[],
    targetWorkspaceId: string
  ): Promise<{
    moved: string[];
    proposed: Array<{ entityId: string; proposalId: string }>;
    errors: Array<{ entityId: string; error: string }>;
  }>;
  archive(workspaceId: string): Promise<{ archived: boolean }>;
}

/** The move door caps a call at 500 entities. */
const MOVE_CHUNK = 500;

/** The real doors, run as `userId` (a human: the caller, or the approver). */
export function retireIntoStepsFor(userId: string): RetireIntoSteps {
  const humanCtx = (workspaceId: string | null) =>
    ({
      db,
      authenticated: true as const,
      userId,
      workspaceId,
    }) as unknown as Context;
  return {
    async install(slug) {
      // `installFromCatalog` lives on the catalog router (merged into the
      // `workspaces` namespace in root.ts), not on `workspacesRouter`.
      const { workspaceCatalogRouter } =
        await import("../routers/workspaces.js");
      const res = (await workspaceCatalogRouter
        .createCaller(humanCtx(null))
        .installFromCatalog({ slug })) as { workspaceId?: unknown };
      if (typeof res?.workspaceId !== "string") {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Installing "${slug}" did not return a space.`,
        });
      }
      return res.workspaceId;
    },
    async move(entityIds, targetWorkspaceId) {
      const { entitiesRouter } = await import("../routers/entities.js");
      return entitiesRouter.createCaller(humanCtx(null)).moveToWorkspace({
        entityIds,
        workspaceId: targetWorkspaceId,
        reason: "Moved off a retired template",
      });
    },
    async archive(workspaceId) {
      const { workspacesRouter } = await import("../routers/workspaces.js");
      const res = await workspacesRouter
        .createCaller(humanCtx(workspaceId))
        .archive({ workspaceId, reasoning: "Retired template, now empty" });
      return { archived: res.status === "archived" };
    },
  };
}

/** The kinds still in the source, read AFTER the move. */
async function remainingKinds(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ kind: entities.type })
    .from(entities)
    .where(
      and(eq(entities.workspaceId, workspaceId), isNull(entities.deletedAt))
    );
  return rows.map((r) => r.kind);
}

/**
 * Run the move NOW as `userId` (never an agent: the governed door below
 * decides that). Re-plans first, so an approval acts on the data as it is,
 * not as it was when the request was filed.
 */
export async function applyRetireInto(
  input: { workspaceId: string; userId: string },
  steps: RetireIntoSteps = retireIntoStepsFor(input.userId)
): Promise<{ plan: RetireIntoPlan; result: RetireIntoResult }> {
  const planned = await planRetireInto(input);
  if ("status" in planned) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: planned.message,
      cause: { code: planned.code },
    });
  }
  const { plan, movableIds } = planned;

  let targetWorkspaceId = plan.target.workspaceId;
  let installed = false;
  if (!targetWorkspaceId) {
    targetWorkspaceId = await steps.install(plan.replacedBy);
    installed = true;
  }

  let moved = 0;
  let proposedMoves = 0;
  const failed: RetireIntoResult["failed"] = [];
  for (let i = 0; i < movableIds.length; i += MOVE_CHUNK) {
    const r = await steps.move(
      movableIds.slice(i, i + MOVE_CHUNK),
      targetWorkspaceId
    );
    moved += r.moved.length;
    proposedMoves += r.proposed.length;
    failed.push(...r.errors);
  }

  // Archive ONLY an empty source — read after the move, never from the plan.
  const left = await remainingKinds(plan.source.workspaceId);
  const plannedStay = new Map(plan.stays.map((k) => [k.kind, k.reason]));
  const remaining = countByKind(left).map((k) => ({
    ...k,
    reason:
      plannedStay.get(k.kind) ??
      `${k.count === 1 ? "It" : "They"} could not be moved.`,
  }));
  let archived = false;
  if (left.length === 0) {
    archived = (await steps.archive(plan.source.workspaceId)).archived;
  }
  const keptBecause =
    left.length === 0
      ? archived
        ? null
        : "Archiving the space needs its owner or a pod admin."
      : remaining.map((k) => `${k.count} × ${k.kind}: ${k.reason}`).join(" ");

  return {
    plan,
    result: {
      targetWorkspaceId,
      installed,
      moved,
      proposedMoves,
      failed,
      remaining,
      remainingCount: left.length,
      archived,
      keptBecause,
    },
  };
}

/**
 * THE door (Hub REST `POST /workspaces/:id/retire-into`, MCP
 * `synap_retire_workspace`). `dryRun` returns the plan. Otherwise an agent
 * files ONE proposal carrying the plan (ADMIN floor on `workspace/update`);
 * a human runs it directly.
 */
export async function retireIntoGoverned(input: {
  workspaceId: string;
  userId: string;
  agentUserId?: string | null;
  dryRun?: boolean;
  reasoning?: string;
  /** Test seam: the doors a human-run apply goes through. */
  steps?: RetireIntoSteps;
}): Promise<RetireIntoOutcome | RetireIntoRefusal> {
  const planned = await planRetireInto(input);
  if ("status" in planned) return planned;
  const { plan } = planned;
  if (input.dryRun) return { status: "plan", plan };

  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    workspaceId: input.workspaceId,
    subjectType: "workspace",
    action: "update",
    reasoning:
      input.reasoning ??
      `The "${plan.source.packageSlug}" template was retired; move this space's data into "${plan.replacedBy}".`,
    data: {
      id: input.workspaceId,
      operation: "retire_into",
      // Review input. The executor RE-PLANS on approval; this is what the
      // reviewer saw, never what is replayed.
      summary: plan.summary,
      plan,
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm && perm.proposalId) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...("reviewUrl" in perm && typeof perm.reviewUrl === "string"
        ? { reviewUrl: perm.reviewUrl }
        : {}),
      plan,
    };
  }
  const applied = await applyRetireInto(
    { workspaceId: input.workspaceId, userId: input.userId },
    input.steps
  );
  return { status: "applied", plan: applied.plan, ...applied.result };
}
