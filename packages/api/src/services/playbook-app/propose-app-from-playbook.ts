/**
 * A playbook's UI, proposed as ONE reviewable bundle (generative UI plan
 * a73b34f0 §5, wave 4b): "build me an app for my lead pipeline" → the agent
 * names the playbook, the pod builds the UI from FACTS and files it as one
 * composite proposal a person approves once. Nothing is created unless that
 * proposal is approved; every part goes through its own door when it is.
 *
 * The facts, read here and never guessed:
 *   - the playbook (the get door's user floor: a playbook the caller cannot see
 *     is "not found"), its space and the kind it works (`subjectProfile`);
 *   - the kind's declared lifecycle (`resolveProfileLifecycle`, the ONE
 *     resolution the pipeline board and `flow.of` use);
 *   - which states the playbook's stages own (`stages[].subjectStatus`).
 *
 * The parts (`buildPlaybookAppOperations`, pure):
 *   - `create_view` pipeline: the kind's lifecycle as columns (config holds
 *     only `profileSlug`; the board reads the states at render time);
 *   - `create_view` bento: widgets over the same kind, every key from the
 *     built-in catalog, checked by the arrange gate before anything is filed;
 *   - `create_cell`: the playbook board (`playbook-board-cell.ts`), checked by
 *     the cell door's mount and sandbox checks before anything is filed;
 *   - `bind_renderer`: that cell on the playbook's own page (`detail`), in its
 *     space. Never a kind's default renderer: the board is the PLAYBOOK's
 *     page, one deal's page stays the deal's.
 *
 * Idempotent: a part that already exists is not proposed again (it is named
 * in `alreadyExists`), a page that already shows something is never replaced,
 * and while this caller's proposal for the same playbook and space is pending
 * the same proposal is returned (`deduped`), never a second one.
 *
 * Refused, with the exact next step, when a fact is missing: a playbook that
 * works no kind, a kind with no declared lifecycle, a pod-wide playbook with
 * no space named.
 */

import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  db,
  eq,
  isNull,
  or,
  drizzleSql,
  views,
  widgetDefinitions,
  ProfileResolutionService,
  ProposalStatus,
} from "@synap/database";
import {
  normalizeProposalSource,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import { validateViewConfig } from "@synap-core/types";
import { humanizeToken } from "@synap-core/types/vocabulary";
import {
  playbookBoardCellSource,
  PLAYBOOK_BOARD_READ_OP,
} from "./playbook-board-cell.js";

// ── Facts ───────────────────────────────────────────────────────────────────

/** The playbook row as the get door returns it (the fields read here). */
export interface PlaybookRowForApp {
  id: string;
  name: string;
  workspaceId: string | null;
  status?: string | null;
  subjectProfile?: unknown;
  stages?: unknown;
}

export interface PlaybookAppFacts {
  playbook: { id: string; name: string };
  /** The space the app's parts live in (the playbook's own). */
  workspaceId: string;
  kind: {
    slug: string;
    /** Its display name, else the slug humanized. */
    label: string;
    /** Its plural, when the profile stores one. */
    plural: string | null;
    /** The property that holds its lifecycle (what a move writes). */
    property: string;
    /** Declared states, in declared order. */
    states: Array<{ key: string; label: string; category: string }>;
  };
  /** The states this playbook's stages own, in stage order. */
  owned: Array<{ state: string; stageKey: string; stageName: string }>;
}

/** Why the facts cannot make an app, and what to call first. */
export interface PlaybookAppRefusal {
  status: "refused";
  reasonCode:
    | "PLAYBOOK_WORKS_NO_KIND"
    | "KIND_HAS_NO_LIFECYCLE"
    | "PLAYBOOK_HAS_NO_SPACE"
    | "SPACE_MISMATCH";
  message: string;
  nextStep: string;
}

function readSubjectSlug(subjectProfile: unknown): string | null {
  const slug = (subjectProfile as { profileSlug?: unknown } | null)
    ?.profileSlug;
  return typeof slug === "string" && slug.trim() ? slug.trim() : null;
}

/** The states the playbook's stages own (`subjectStatus`), in stage order. */
export function ownedStatesOf(stages: unknown): PlaybookAppFacts["owned"] {
  if (!Array.isArray(stages)) return [];
  return stages.flatMap((raw) => {
    const s = raw as { key?: unknown; name?: unknown; subjectStatus?: unknown };
    if (typeof s?.key !== "string" || typeof s.subjectStatus !== "string")
      return [];
    return [
      {
        state: s.subjectStatus,
        stageKey: s.key,
        stageName: typeof s.name === "string" ? s.name : s.key,
      },
    ];
  });
}

/**
 * Read the facts an app is built from, or the refusal naming what is missing.
 * `workspaceId` is the caller's: required for a pod-wide playbook (which space
 * the views go in), refused when it names another space than the playbook's.
 */
export async function readPlaybookAppFacts(input: {
  playbook: PlaybookRowForApp;
  workspaceId?: string | null;
  userId: string;
}): Promise<PlaybookAppFacts | PlaybookAppRefusal> {
  const { playbook, userId } = input;
  const slug = readSubjectSlug(playbook.subjectProfile);
  if (!slug) {
    return {
      status: "refused",
      reasonCode: "PLAYBOOK_WORKS_NO_KIND",
      message: `The playbook "${playbook.name}" works no kind (its subjectProfile is empty), so there is no flow to draw.`,
      nextStep: `Bind it to the kind it works: synap_update_playbook { playbookId: "${playbook.id}", subjectProfile: { profileSlug: "<kind>" } }, then call this again.`,
    };
  }
  const asked = input.workspaceId ?? null;
  if (playbook.workspaceId && asked && asked !== playbook.workspaceId) {
    return {
      status: "refused",
      reasonCode: "SPACE_MISMATCH",
      message: `The playbook "${playbook.name}" lives in another space than ${asked}; its UI lives in its own space.`,
      nextStep: `Call again with workspaceId "${playbook.workspaceId}", or without workspaceId.`,
    };
  }
  const workspaceId = playbook.workspaceId ?? asked;
  if (!playbook.workspaceId && asked) {
    // A pod-wide playbook's UI goes in a space the CALLER may write; never
    // one it only named.
    const { canWrite, userPrincipal } = await import("../../access/door.js");
    if (!(await canWrite(userPrincipal(userId), { workspace: asked }))) {
      return {
        status: "refused",
        reasonCode: "SPACE_MISMATCH",
        message: `You cannot add views to the space ${asked}.`,
        nextStep:
          "Call again with workspaceId: a space you are a member of (synap_orient lists them).",
      };
    }
  }
  if (!workspaceId) {
    return {
      status: "refused",
      reasonCode: "PLAYBOOK_HAS_NO_SPACE",
      message: `The playbook "${playbook.name}" is pod-wide, and views live in a space.`,
      nextStep:
        "Call again with workspaceId: the space the views and the board go in (synap_orient lists your spaces).",
    };
  }

  const resolver = new ProfileResolutionService(db);
  const profile = await resolver.resolveProfile(slug, userId, workspaceId);
  const { resolveProfileLifecycle } =
    await import("../lifecycle/board-lens.js");
  let lifecycle: Awaited<ReturnType<typeof resolveProfileLifecycle>>;
  try {
    lifecycle = await resolveProfileLifecycle(slug, workspaceId);
  } catch (err) {
    if (
      err instanceof TRPCError &&
      (err.code === "PRECONDITION_FAILED" || err.code === "NOT_FOUND")
    ) {
      return {
        status: "refused",
        reasonCode: "KIND_HAS_NO_LIFECYCLE",
        message: `"${slug}" declares no lifecycle, so its work has no states to draw: no pipeline, no board.`,
        nextStep: `Declare it first: synap_declare_lifecycle { profileId: "${profile?.id ?? `<the ${slug} profile id, from synap_list_profiles>`}", property, options: [{ key, category }] }, then call this again.`,
      };
    }
    throw err;
  }
  const options = lifecycle.lifecycle.options as Array<{
    key: string;
    label?: string | null;
    category?: string | null;
  }>;
  return {
    playbook: { id: playbook.id, name: playbook.name },
    workspaceId,
    kind: {
      slug,
      label: profile?.displayName?.trim() || humanizeToken(slug),
      plural:
        (profile as { plural?: string | null } | null)?.plural?.trim() || null,
      property: lifecycle.lifecycle.propertySlug,
      states: options.map((o) => ({
        key: o.key,
        label: o.label?.trim() || humanizeToken(o.key),
        category: o.category ?? "open",
      })),
    },
    owned: ownedStatesOf(playbook.stages),
  };
}

// ── What already exists ─────────────────────────────────────────────────────

export interface ExistingPlaybookApp {
  /** The kind's pipeline in this space, when there is one. */
  pipelineViewId: string | null;
  /** The playbook's dashboard (by its name) in this space. */
  bentoViewId: string | null;
  /** The board cell (by its key), when it is defined here or pod-wide. */
  cellKey: string | null;
  /** What the playbook's page shows now, when something is bound. */
  bound: { source: string; cellKey: string | null } | null;
}

/** The names the parts are created under — stable, so a re-run finds them. */
export function playbookAppNames(facts: PlaybookAppFacts): {
  pipeline: string;
  bento: string;
  cell: string;
} {
  return {
    pipeline: `${facts.kind.plural ?? facts.kind.label} pipeline`,
    bento: `${facts.playbook.name} dashboard`,
    cell: `${facts.playbook.name} board`,
  };
}

export async function readExistingPlaybookApp(
  facts: PlaybookAppFacts,
  userId: string
): Promise<ExistingPlaybookApp> {
  const names = playbookAppNames(facts);
  const { cellTypeKeyFor } = await import("../cells/define-cell.js");
  const cellKey = cellTypeKeyFor(names.cell);
  const [pipeline] = await db
    .select({ id: views.id })
    .from(views)
    .where(
      and(
        eq(views.workspaceId, facts.workspaceId),
        eq(views.type, "pipeline"),
        drizzleSql`${views.config} ->> 'profileSlug' = ${facts.kind.slug}`
      )
    )
    .limit(1);
  const [bento] = await db
    .select({ id: views.id })
    .from(views)
    .where(
      and(
        eq(views.workspaceId, facts.workspaceId),
        eq(views.type, "bento"),
        drizzleSql`lower(${views.name}) = lower(${names.bento})`
      )
    )
    .limit(1);
  const [cell] = await db
    .select({ id: widgetDefinitions.id })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, cellKey),
        eq(widgetDefinitions.isActive, true),
        or(
          eq(widgetDefinitions.workspaceId, facts.workspaceId),
          isNull(widgetDefinitions.workspaceId)
        )
      )
    )
    .limit(1);
  const { readBoundRenderer } =
    await import("../renderers/renderer-target-checks.js");
  const bound = await readBoundRenderer({
    target: { kind: "playbook", id: facts.playbook.id },
    slot: "detail",
    userId,
    workspaceId: facts.workspaceId,
  });
  const boundCellKey = bound
    ? bound.ref.kind === "cell"
      ? typeof bound.ref.props?.typeKey === "string"
        ? bound.ref.props.typeKey
        : bound.ref.cellKey
      : null
    : null;
  return {
    pipelineViewId: pipeline?.id ?? null,
    bentoViewId: bento?.id ?? null,
    cellKey: cell ? cellKey : null,
    bound: bound ? { source: bound.source, cellKey: boundCellKey } : null,
  };
}

// ── The bundle (pure) ───────────────────────────────────────────────────────

/** The refs of the bundle's parts — stable, so a review and an undo name them. */
export const PLAYBOOK_APP_REFS = {
  pipeline: "pipeline",
  bento: "dashboard",
  cell: "board",
  binding: "board-on-playbook",
} as const;

export type PlaybookAppPart = keyof typeof PLAYBOOK_APP_REFS;

/** The bento's blocks: widgets over the kind, read from its lifecycle property. */
export function playbookAppBentoBlocks(
  facts: PlaybookAppFacts
): Array<Record<string, unknown>> {
  const kind = facts.kind;
  const noun = kind.plural ?? kind.label;
  return [
    {
      id: "count",
      kind: "widget",
      widgetType: "stat-card",
      config: { profileSlug: kind.slug, aggregation: "count", label: noun },
      pos: { x: 0, y: 0, w: 3, h: 3 },
    },
    {
      id: "by-state",
      kind: "widget",
      widgetType: "composition-bar",
      config: {
        profileSlug: kind.slug,
        groupBy: kind.property,
        title: `${noun} by state`,
      },
      pos: { x: 3, y: 0, w: 9, h: 3 },
    },
    {
      id: "funnel",
      kind: "widget",
      widgetType: "chart-funnel",
      config: {
        profileSlug: kind.slug,
        stageField: kind.property,
        label: `${noun} funnel`,
      },
      pos: { x: 0, y: 3, w: 6, h: 5 },
    },
    {
      id: "recent",
      kind: "widget",
      widgetType: "entity-list",
      config: { profileSlug: kind.slug, title: `Latest ${noun}`, limit: 10 },
      pos: { x: 6, y: 3, w: 6, h: 5 },
    },
  ];
}

export interface PlaybookAppPlan {
  operations: CompositeProposalOperation[];
  /** The parts this bundle proposes. */
  parts: PlaybookAppPart[];
  /** The parts already there, and what each is. Not proposed again. */
  alreadyExists: Array<{
    part: PlaybookAppPart;
    id?: string;
    cellKey?: string;
    note?: string;
  }>;
  /** A part not proposed because something else holds its place. */
  leftOut: Array<{ part: PlaybookAppPart; reason: string }>;
}

export function buildPlaybookAppOperations(
  facts: PlaybookAppFacts,
  existing: ExistingPlaybookApp
): PlaybookAppPlan {
  const names = playbookAppNames(facts);
  const operations: CompositeProposalOperation[] = [];
  const parts: PlaybookAppPart[] = [];
  const alreadyExists: PlaybookAppPlan["alreadyExists"] = [];
  const leftOut: PlaybookAppPlan["leftOut"] = [];
  const ws = facts.workspaceId;

  if (existing.pipelineViewId) {
    alreadyExists.push({ part: "pipeline", id: existing.pipelineViewId });
  } else {
    operations.push({
      op: "create_view",
      ref: PLAYBOOK_APP_REFS.pipeline,
      name: names.pipeline,
      viewType: "pipeline",
      workspaceId: ws,
      scopeProfileSlugs: [facts.kind.slug],
      config: { profileSlug: facts.kind.slug },
    });
    parts.push("pipeline");
  }

  if (existing.bentoViewId) {
    alreadyExists.push({ part: "bento", id: existing.bentoViewId });
  } else {
    operations.push({
      op: "create_view",
      ref: PLAYBOOK_APP_REFS.bento,
      name: names.bento,
      viewType: "bento",
      workspaceId: ws,
      scopeProfileSlugs: [facts.kind.slug],
      config: { blocks: playbookAppBentoBlocks(facts) },
    });
    parts.push("bento");
  }

  if (existing.cellKey) {
    alreadyExists.push({ part: "cell", cellKey: existing.cellKey });
  } else {
    operations.push({
      op: "create_cell",
      ref: PLAYBOOK_APP_REFS.cell,
      name: names.cell,
      description: `The work of "${facts.playbook.name}": one column per ${facts.kind.label} state in declared order, headed by the stage that owns it, read live from ${PLAYBOOK_BOARD_READ_OP}.`,
      rendererSource: playbookBoardCellSource({
        playbookId: facts.playbook.id,
        profileSlug: facts.kind.slug,
      }),
      workspaceId: ws,
      contentKind: "entity-detail",
    });
    parts.push("cell");
  }

  const ownKey = existing.cellKey;
  if (existing.bound) {
    if (existing.bound.cellKey && existing.bound.cellKey === ownKey) {
      alreadyExists.push({ part: "binding", cellKey: ownKey });
    } else {
      // Never replaced: the person chose what the page shows.
      leftOut.push({
        part: "binding",
        reason: `The playbook's page already shows ${existing.bound.cellKey ? `the cell "${existing.bound.cellKey}"` : "a renderer"} (${existing.bound.source}); it is not replaced. To show the board there, bind it by hand: synap_promote_cell_to_renderer { target: { kind: "playbook", id: "${facts.playbook.id}" }, slot: "detail", cellKey }.`,
      });
    }
  } else {
    operations.push({
      op: "bind_renderer",
      ref: PLAYBOOK_APP_REFS.binding,
      target: { kind: "playbook", id: facts.playbook.id },
      slot: "detail",
      scope: "workspace",
      workspaceId: ws,
      ...(ownKey ? { cellKey: ownKey } : { cellRef: PLAYBOOK_APP_REFS.cell }),
    });
    parts.push("binding");
  }

  return { operations, parts, alreadyExists, leftOut };
}

/** The key one caller's pending bundle for one playbook in one space is found by. */
export function playbookAppIdempotencyKey(facts: PlaybookAppFacts): string {
  return `playbook-app:${facts.playbook.id}:${facts.workspaceId}`;
}

/** The line a reviewer reads first. */
export function playbookAppSummary(
  facts: PlaybookAppFacts,
  parts: readonly PlaybookAppPart[]
): string {
  const noun = facts.kind.plural ?? facts.kind.label;
  const words: Record<PlaybookAppPart, string> = {
    pipeline: `the ${noun} pipeline (${facts.kind.states.length} states)`,
    bento: "a dashboard",
    cell: "a board drawn live from the flow",
    binding: "the board on the playbook's page",
  };
  return `UI for "${facts.playbook.name}": ${parts.map((p) => words[p]).join(", ")}`;
}

// ── Checks before anything is filed ─────────────────────────────────────────

/**
 * Every problem the bundle would meet at its doors, BEFORE it is filed: the
 * composite's own shape and refs, each view's config for its type, the bento's
 * widgets against this space's catalog, the cell's mount and sandbox checks.
 * Throws BAD_REQUEST naming each one; returns the cell's advice (never a
 * refusal) when it passes.
 */
export async function assertPlaybookAppFileable(
  operations: CompositeProposalOperation[],
  workspaceId: string
): Promise<string[]> {
  const problems: string[] = [];
  const { validatePlanOperations } =
    await import("../capture-agent/capture-plan.js");
  for (const p of validatePlanOperations(operations, { workspaceId })) {
    problems.push(`${p.op}${p.ref ? ` "${p.ref}"` : ""}: ${p.message}`);
  }
  const { bentoBlockArrangeErrors } = await import("../cells/renderables.js");
  const advice: string[] = [];
  for (const op of operations) {
    if (op.op === "create_view" && op.config) {
      const validation = validateViewConfig(op.viewType, op.config);
      if (!validation.valid) {
        problems.push(
          `create_view "${op.ref}": ${JSON.stringify(validation.errors)}`
        );
      }
      if (op.viewType === "bento") {
        for (const e of await bentoBlockArrangeErrors(op.config, workspaceId)) {
          problems.push(`create_view "${op.ref}": ${e}`);
        }
      }
    }
    if (op.op === "create_cell") {
      const { assertCellSourceMounts } =
        await import("../cells/define-cell.js");
      try {
        const found = await assertCellSourceMounts({
          name: op.name,
          rendererSource: op.rendererSource,
          workspaceId: op.workspaceId ?? null,
        });
        advice.push(...found.map((a) => a.message));
      } catch (err) {
        problems.push(
          `create_cell "${op.ref}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `The UI bundle cannot be filed:\n- ${problems.join("\n- ")}`,
    });
  }
  return advice;
}

// ── Filing ──────────────────────────────────────────────────────────────────

/** Key-order-independent JSON: a stored jsonb comes back with its keys reordered. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The doors the bundle's parts are applied through (`COMPOSITE_OP_GATE_PAIRS`). */
const PLAYBOOK_APP_GATE_PAIRS = [
  { subjectType: "view", action: "create" },
  { subjectType: "cell", action: "define" },
  { subjectType: "profile", action: "renderer.set" },
] as const;

export type ProposePlaybookAppResult =
  | PlaybookAppRefusal
  | {
      status: "exists";
      message: string;
      alreadyExists: PlaybookAppPlan["alreadyExists"];
      leftOut: PlaybookAppPlan["leftOut"];
    }
  | {
      status: "proposed";
      proposalId: string;
      reviewUrl: string;
      reviewPath: string;
      /** The same caller's pending proposal for this playbook, returned. */
      deduped: boolean;
      /** With `deduped`: the bundle built now differs from the pending one. */
      changedSincePending?: boolean;
      summary: string;
      parts: PlaybookAppPart[];
      alreadyExists: PlaybookAppPlan["alreadyExists"];
      leftOut: PlaybookAppPlan["leftOut"];
      advice?: string[];
    }
  | { status: "denied"; error: string };

/**
 * Build the bundle from the facts and file it as ONE pending composite
 * proposal — always pending: this verb proposes, it never applies, whoever
 * calls it. A person approves it on its review page.
 */
export async function proposePlaybookApp(input: {
  facts: PlaybookAppFacts;
  userId: string;
  agentUserId?: string | null;
  sessionId?: string | null;
  reasoning?: string | null;
}): Promise<ProposePlaybookAppResult> {
  const { facts, userId } = input;
  // The SAME governance door the parts' own doors run, as a dry run, BEFORE
  // anything is read about what exists: a caller who may not write these
  // parts in this space is refused and learns nothing more.
  const { previewPermissionDecision } =
    await import("../../utils/permission-check.js");
  for (const pair of PLAYBOOK_APP_GATE_PAIRS) {
    const preview = await previewPermissionDecision({
      userId,
      ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
      workspaceId: facts.workspaceId,
      ...pair,
      source: "api",
      data: {},
    });
    if (preview.decision === "deny") {
      return { status: "denied", error: preview.reason };
    }
  }
  const existing = await readExistingPlaybookApp(facts, userId);
  const plan = buildPlaybookAppOperations(facts, existing);
  if (plan.operations.length === 0) {
    return {
      status: "exists",
      message: `Every part of the UI for "${facts.playbook.name}" already exists; nothing was proposed.`,
      alreadyExists: plan.alreadyExists,
      leftOut: plan.leftOut,
    };
  }
  const advice = await assertPlaybookAppFileable(
    plan.operations,
    facts.workspaceId
  );
  const summary = playbookAppSummary(facts, plan.parts);
  const idempotencyKey = playbookAppIdempotencyKey(facts);
  const { openLink, openPath } = await import("../../utils/deep-links.js");

  const { findPriorCaptureGraphProposal } =
    await import("../../utils/pending-capture-dedup.js");
  const prior = await findPriorCaptureGraphProposal(db, {
    userId,
    idempotencyKey,
  });
  if (prior && prior.status === ProposalStatus.PENDING) {
    const priorOps = (prior.data as { operations?: unknown } | null)
      ?.operations;
    return {
      status: "proposed",
      proposalId: prior.id,
      reviewUrl: openLink(prior.id),
      reviewPath: openPath(prior.id),
      deduped: true,
      changedSincePending:
        canonicalJson(priorOps) !== canonicalJson(plan.operations),
      summary,
      parts: plan.parts,
      alreadyExists: plan.alreadyExists,
      leftOut: plan.leftOut,
    };
  }

  if (input.agentUserId) {
    const { refuseAtAgentPendingCap } =
      await import("../../utils/permission-check.js");
    const refusal = await refuseAtAgentPendingCap({
      attributionAgentUserId: input.agentUserId,
      userId,
      workspaceId: facts.workspaceId,
      subjectType: "cell",
      action: "define",
      correlationId: randomUUID(),
    });
    if (refusal) return { status: "denied", error: refusal.reason };
  }

  const { createEventBackedProposal } =
    await import("../../utils/event-backed-proposal.js");
  const source = normalizeProposalSource(input.agentUserId ? "agent" : "user");
  const { proposal } = await createEventBackedProposal({
    userId,
    workspaceId: facts.workspaceId,
    // The composite lane's row shape (`submitCaptureGraph`'s pending path):
    // the approve flow reads `data.operations`, never the target.
    targetType: "entity",
    targetId: randomUUID(),
    proposalType: "import.graph",
    action: "create",
    source: "api",
    summary,
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    data: {
      operations: plan.operations,
      source,
      graphSource: "playbook_app",
      playbookId: facts.playbook.id,
      idempotencyKey,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    },
  });
  const proposalId = (proposal as { id: string }).id;
  return {
    status: "proposed",
    proposalId,
    reviewUrl: openLink(proposalId),
    reviewPath: openPath(proposalId),
    deduped: false,
    summary,
    parts: plan.parts,
    alreadyExists: plan.alreadyExists,
    leftOut: plan.leftOut,
    ...(advice.length > 0 ? { advice } : {}),
  };
}
