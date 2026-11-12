/**
 * THE FLOW READ — `flow.of(kind or role, space)` (One model plan, slice S1):
 * the one read an app or an agent fetches to draw a kind's or role's work.
 *
 *   states   the declared lifecycle (key, label, category, tone, humanOnly,
 *            order), each with the stage(s) that OWN it and its things;
 *   flows    the active playbooks working the profile in that space, each
 *            stage with the status it owns (`stageForSubjectStatus`, the
 *            runtime's own stage ↔ status rule), its gate, the flow's
 *            executor and enabled workers, and its open runs, marked when
 *            they run a frozen copy older than the live flow;
 *   cards    the things by state with who works them (`readBoard`, the
 *            board door's own body: same lens, grouping, windows, stuck rule,
 *            unclassified column, `workedBy`) and each card's next step
 *            (`nextPathStep`, the rung `deriveThingNextMove` reads) with the
 *            stage that owns it;
 *   space    the space's primary output, when its template declares one
 *            (`settings.intent.primary`; tolerated absent).
 *
 * Edge cases (plan §7): two flows owning different states show one owner per
 * state; two owning ONE state show both (`owners`, never the first match
 * silently, C4); a state no stage owns has `owners: []`; a role reads people
 * and companies in one board (each card names its own kind); a stage naming
 * a status the lifecycle does not declare is listed on its flow.
 *
 * Each card carries its `blocker`: the SAME value `statusOf` returns for the
 * thing (`deriveThingBlocker`), read for every card of the board in ONE batch
 * (`readThingBlockers`); `{status: "unavailable"}` when that read failed,
 * never "not blocked".
 * Doors: tRPC `flow.of`, Hub `GET /flow`, MCP `synap_get_flow`. A key bounded by
 * a grant passes `readProfileUnderGrant` (the `GET /lifecycle` narrowing);
 * its rows are bounded by the access seams; what no seam bounds (workers) or
 * what its grant does not read (flows, without `playbook.read`) is listed in
 * `withheld`, never answered as empty.
 */
import { z } from "zod";
import {
  and,
  db,
  drizzleSql,
  eq,
  getRequestGrant,
  inArray,
  isNull,
  liveRunStatusWhere,
  or,
  playbookRuns,
  playbooks,
  workspaces,
} from "@synap/database";
import {
  resolveStageCategory,
  resolveStageGate,
  stageForSubjectStatus,
} from "@synap/playbooks";
import {
  isTerminalLifecycleCategory,
  UNCLASSIFIED_STATUS,
} from "@synap-core/types/lifecycle";
import { AccessContext } from "../../access/context.js";
import { scopedDb } from "../../access/scoped-db.js";
import {
  grantHoldsAction,
  isFencedGrant,
} from "../../access/grant-door-fence.js";
import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import {
  listEnabledWorkers,
  type EnabledWorker,
} from "../playbooks/workers.js";
import { nextPathStep } from "../status/next-move.js";
import { readThingBlockers } from "../status/thing-blockers.js";
import { boardLensInput, readBoard, type BoardReader } from "./board.js";
import { resolveBoardLens } from "./board-lens.js";
import { readProfileUnderGrant } from "./fenced-profile-read.js";

export const flowOfInput = z.object({
  ...boardLensInput,
  /** done/lost states count what entered them within the last N days. */
  window: z
    .object({ days: z.number().int().min(1).max(366) })
    .default({ days: 30 }),
  /** Cards per state (capped list; the count is always exact). */
  firstN: z.number().int().min(0).max(50).default(10),
  /** Also carry each card's properties (what an app draws a card from). */
  properties: z.boolean().optional(),
});

export type FlowOfInput = z.output<typeof flowOfInput>;

export type {
  FlowCard,
  FlowCardBlocker,
  FlowNextStep,
  FlowOf,
  FlowOfFlow,
  FlowStage,
  FlowStageRef,
  FlowState,
  FlowWorker,
} from "./flow-schema.js";
import type {
  FlowCard,
  FlowCardBlocker,
  FlowNextStep,
  FlowOf,
  FlowOfFlow,
  FlowStage,
  FlowStageRef,
  FlowState,
} from "./flow-schema.js";

type FlowReader = BoardReader;

function stageRefOf(
  pb: { id: string; name: string; executor: string },
  stage: Record<string, unknown>
): FlowStageRef {
  return {
    playbookId: pb.id,
    playbookName: pb.name,
    stageKey: String(stage.key),
    stageName: typeof stage.name === "string" ? stage.name : String(stage.key),
    category: resolveStageCategory(stage),
    gate: resolveStageGate(stage)?.kind ?? null,
    executor: pb.executor,
  };
}

/**
 * The space's declared outputs, read leniently (`settings.intent`). Also read
 * by the pillar health read (`services/projects/pillar-health.ts`), which
 * lists a declared output's kind in a pillar's indicator even when the
 * project has none of it yet.
 */
export async function readSpaceOutputs(
  userId: string,
  workspaceId: string
): Promise<{ primaryOutput: string | null; produces: string[] }> {
  const visible = await getUserWorkspaceIds(userId);
  if (!visible.includes(workspaceId))
    return { primaryOutput: null, produces: [] };
  const [row] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const intent = (row?.settings as { intent?: unknown } | null)?.intent as
    { primary?: unknown; produces?: unknown } | null | undefined;
  const raw = intent?.primary;
  const primary = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const produces = Array.isArray(intent?.produces)
    ? intent.produces.filter((s): s is string => typeof s === "string")
    : [];
  return { primaryOutput: primary, produces };
}

export async function readFlowOf(
  input: FlowOfInput,
  ctx: FlowReader
): Promise<FlowOf> {
  const lens = await readProfileUnderGrant(
    input,
    () => resolveBoardLens(input, ctx),
    (l) => l.p.profileKind
  );
  const { lifecycle, projectId } = lens;
  const grant = getRequestGrant();
  const fenced = isFencedGrant(grant);
  const withheld: FlowOf["withheld"] = [];
  const readFlows = !fenced || grantHoldsAction(grant!, "playbook", "read");
  if (!readFlows) withheld.push("flows");
  if (fenced) withheld.push("workers");
  const lensWorkspaceId =
    input.workspaceId !== undefined
      ? input.workspaceId
      : (ctx.workspaceId ?? undefined);

  // The space's flows and the pod-wide ones; no lens = every flow the
  // caller sees; `null` = pod-wide only.
  const flowSpace =
    typeof lensWorkspaceId === "string"
      ? or(
          isNull(playbooks.workspaceId),
          eq(playbooks.workspaceId, lensWorkspaceId)
        )
      : lensWorkspaceId === null
        ? isNull(playbooks.workspaceId)
        : undefined;

  const [board, pbRows, workers, space] = await Promise.all([
    readBoard(
      {
        profileSlug: input.profileSlug,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.trackId ? { trackId: input.trackId } : {}),
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        window: input.window,
        firstN: input.firstN,
        limit: 25,
        workedBy: true,
        card: true,
      },
      ctx,
      lens
    ),
    readFlows
      ? db
          .select({
            id: playbooks.id,
            name: playbooks.name,
            workspaceId: playbooks.workspaceId,
            version: playbooks.version,
            executor: playbooks.executor,
            stages: playbooks.stages,
          })
          .from(playbooks)
          .where(
            and(
              scopedDb(AccessContext.from(ctx)).predicate(playbooks),
              eq(playbooks.status, "active"),
              drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${input.profileSlug}`,
              drizzleSql`coalesce(${playbooks.scope}, 'session') <> 'project'`,
              flowSpace
            )
          )
          .orderBy(playbooks.name)
      : Promise.resolve([]),
    fenced
      ? Promise.resolve([] as EnabledWorker[])
      : listEnabledWorkers({
          userId: ctx.userId,
          profileSlug: input.profileSlug,
          projectId: projectId ?? null,
        }),
    lensWorkspaceId ? readSpaceOutputs(ctx.userId, lensWorkspaceId) : null,
  ]);

  // Open runs per flow, and those on a frozen copy older than the live one.
  const runsBy = new Map<string, { open: number; onOlderVersion: number }>();
  if (pbRows.length > 0) {
    const runRows = await db
      .select({
        playbookId: playbookRuns.playbookId,
        version: drizzleSql<
          string | null
        >`${playbookRuns.definitionSnapshot}->>'version'`,
      })
      .from(playbookRuns)
      .where(
        and(
          scopedDb(AccessContext.from(ctx)).predicate(playbookRuns),
          inArray(
            playbookRuns.playbookId,
            pbRows.map((p) => p.id)
          ),
          liveRunStatusWhere(playbookRuns.status)
        )
      );
    const current = new Map(pbRows.map((p) => [p.id, p.version]));
    for (const r of runRows) {
      const agg = runsBy.get(r.playbookId) ?? { open: 0, onOlderVersion: 0 };
      agg.open += 1;
      const v = r.version === null ? NaN : Number(r.version);
      // A run with no snapshot version reads the live flow: not older.
      if (Number.isFinite(v) && v < (current.get(r.playbookId) ?? v))
        agg.onOlderVersion += 1;
      runsBy.set(r.playbookId, agg);
    }
  }

  const declared = new Set(lifecycle.options.map((o) => o.key));
  const ownersOf = new Map<string, FlowStageRef[]>(
    lifecycle.options.map((o) => [o.key, []])
  );
  const flows: FlowOfFlow[] = pbRows.map((pb) => {
    const stages = (Array.isArray(pb.stages) ? pb.stages : []).filter(
      (s): s is Record<string, unknown> =>
        !!s &&
        typeof s === "object" &&
        typeof (s as { key?: unknown }).key === "string"
    );
    const owns: string[] = [];
    // The runtime's own rule: the stage a status corresponds to.
    for (const o of lifecycle.options) {
      const stageKey = stageForSubjectStatus(stages, o.key);
      if (!stageKey) continue;
      const stage = stages.find((s) => s.key === stageKey)!;
      owns.push(o.key);
      ownersOf.get(o.key)!.push(stageRefOf(pb, stage));
    }
    const undeclared = new Set<string>();
    const shaped: FlowStage[] = stages.map((s) => {
      const subjectStatus =
        typeof s.subjectStatus === "string" && s.subjectStatus.trim()
          ? s.subjectStatus.trim()
          : null;
      if (subjectStatus && !declared.has(subjectStatus))
        undeclared.add(subjectStatus);
      return {
        key: String(s.key),
        name: typeof s.name === "string" ? s.name : String(s.key),
        category: resolveStageCategory(s),
        subjectStatus,
        gate: resolveStageGate(s)?.kind ?? null,
      };
    });
    return {
      id: pb.id,
      name: pb.name,
      workspaceId: pb.workspaceId,
      version: pb.version,
      executor: pb.executor,
      stages: shaped,
      owns,
      undeclaredStatuses: [...undeclared],
      runs: runsBy.get(pb.id) ?? { open: 0, onOlderVersion: 0 },
      workers: workers
        .filter((w) => w.playbookId === pb.id)
        .map((w) => ({
          ruleId: w.ruleId,
          activatorKey: w.activatorKey,
          mode: w.mode,
          scope: w.scope,
          projectId: w.projectId,
          state: w.state,
        })),
    };
  });

  // ONE blockers read for every card on the board (the states' and the
  // unclassified column's), floored on the reader like statusOf's. A failed
  // read marks each card `unavailable`; it never reads as "not blocked".
  const stray = board.columns.find((c) => c.key === UNCLASSIFIED_STATUS);
  const blockers: Awaited<ReturnType<typeof readThingBlockers>> | null =
    await readThingBlockers(
      { userId: ctx.userId },
      board.columns.flatMap((c) =>
        c.items.map((i) => ({
          id: i.id,
          // A role board's card: its step is the facet's (a lead's wait).
          facetId: i.facetId ?? null,
          status: i.status,
          lifecycle,
        }))
      )
    ).catch(() => null);
  const blockerOf = (id: string): FlowCardBlocker =>
    blockers?.get(id) ?? { status: "unavailable" };

  const optionByKey = new Map(lifecycle.options.map((o) => [o.key, o]));
  const cardOf = (
    item: (typeof board.columns)[number]["items"][number]
  ): FlowCard => {
    const option = item.status ? optionByKey.get(item.status) : undefined;
    let next: FlowNextStep | null = null;
    if (
      option &&
      !isTerminalLifecycleCategory(option.category) &&
      option.category !== "paused"
    ) {
      const step = nextPathStep(lifecycle, item.status);
      if (step && step !== "off_path") {
        next = {
          to: step.key,
          label: step.label,
          humanOnly: step.humanOnly === true,
          owners: ownersOf.get(step.key) ?? [],
        };
      }
    }
    return {
      id: item.id,
      facetId: item.facetId,
      name: item.name,
      profileSlug: item.card?.profileSlug ?? null,
      status: item.status,
      since: item.since,
      enteredAt: item.enteredAt,
      stuck: item.stuck,
      workedBy: item.workedBy ?? [],
      ...(input.properties ? { properties: item.card?.properties ?? {} } : {}),
      next,
      blocker: blockerOf(item.id),
    };
  };

  const states: FlowState[] = lifecycle.options.map((o, order) => {
    const col = board.columns.find((c) => c.key === o.key);
    return {
      key: o.key,
      label: o.label,
      category: o.category,
      tone: o.tone,
      humanOnly: o.humanOnly,
      order,
      owners: ownersOf.get(o.key) ?? [],
      count: col?.count ?? 0,
      stuck: col?.stuck ?? null,
      windowed: col?.windowed ?? isTerminalLifecycleCategory(o.category),
      cards: (col?.items ?? []).map(cardOf),
    };
  });
  return {
    profileSlug: input.profileSlug,
    profileKind: lifecycle.profileKind,
    property: lifecycle.property,
    workspaceId: lensWorkspaceId ?? null,
    states,
    unclassified: stray
      ? {
          count: stray.count,
          unset: stray.unset ?? 0,
          cards: stray.items.map(cardOf),
        }
      : null,
    flows,
    space,
    totals: {
      total: board.total,
      live: board.live,
      doneWindowed: board.doneWindowed,
      lostWindowed: board.lostWindowed,
    },
    window: board.window,
    hasWorker: fenced ? null : board.hasWorker,
    withheld,
  };
}
