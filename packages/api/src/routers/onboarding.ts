import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  and,
  count,
  desc,
  entities,
  eq,
  getDb,
  inArray,
  isNull,
  drizzleSql,
  ONBOARDING_SCAFFOLD_SYSTEM_DATA_KEY,
  onboardingJourneys,
  or,
  profiles,
  projectMembers,
  projects,
  readTemplateState,
  users,
  workspaces,
  listableEntityWhere,
} from "@synap/database";
import type {
  OnboardingJourney,
  OnboardingJourneyEvidenceRecord,
  OnboardingJourneyProgressRecord,
  WorkspaceSettings,
} from "@synap/database";
import { podAdminProcedure, podProcedure, router } from "../trpc.js";
import { startFirstSession } from "../services/focus-sessions/first-session.js";
import { proposeSetup, undoSetup } from "../services/onboarding/setup.js";
import { normalizeToolName } from "@synap-core/types/tools";
import {
  isInterviewBrief,
  readSpaceBrief,
} from "@synap-core/types/space-brief";
import {
  recordToolDemand,
  type RecordToolDemandResult,
} from "../services/tool-demand/record-tool-demand.js";
import {
  completedStartPrefix,
  deriveStartSteps,
  nextStartStep,
  START_STEP_IDS,
  type StartStepId,
  type StartValues,
} from "@synap-core/types/onboarding/start";
import {
  countNonSystemSpaces,
  deepMerge,
  gatherStartFacts,
  isStartDue,
  listBundledStarts,
  readCloudAnswers,
} from "../services/onboarding-start.js";
import { isPodAdmin } from "../utils/workspace-role.js";
import { accessScopeWhere, projectLensWhere } from "../utils/project-scope.js";
import {
  ownerPrivateVisibleWhere,
  userVisibleWhere,
} from "../utils/user-visible-where.js";

const lensSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pod") }),
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().uuid(),
  }),
  z.object({
    kind: z.literal("project_workspace"),
    projectId: z.string().uuid(),
    workspaceId: z.string().uuid(),
  }),
]);

type OnboardingLens = z.infer<typeof lensSchema>;
type Readiness = "absent" | "sparse" | "ready";
type JourneyStatus =
  "offered" | "active" | "paused" | "completed" | "dismissed";

const templateVersionSchema = z.string().trim().min(1).max(100).optional();
const progressPatchSchema = z.object({
  currentActionId: z.string().min(1).max(200).optional(),
  completedActionIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});
const evidenceSchema = z.object({
  meaningfulEntityIds: z.array(z.string().uuid()).max(500).default([]),
  completedCriteria: z.array(z.string().min(1).max(500)).max(100).default([]),
  firstValueAt: z.string().datetime({ offset: true }).optional(),
});
const journeyIdentitySchema = z.object({
  lens: lensSchema,
  templateVersion: templateVersionSchema,
});

interface WorkspaceContext {
  settings: WorkspaceSettings;
  packageVersion: string | undefined;
}

export function resolveTemplateVersion(
  requestedVersion: string | undefined,
  workspaceContext: WorkspaceContext | null
): string {
  const canonicalVersion = workspaceContext?.packageVersion ?? "1";
  if (requestedVersion && requestedVersion !== canonicalVersion) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Onboarding template version does not match this context",
    });
  }
  return canonicalVersion;
}

function lensKey(lens: OnboardingLens): string {
  switch (lens.kind) {
    case "pod":
      return "pod";
    case "workspace":
      return `workspace:${lens.workspaceId}`;
    case "project":
      return `project:${lens.projectId}`;
    case "project_workspace":
      return `project:${lens.projectId}:workspace:${lens.workspaceId}`;
  }
}

function lensReferences(lens: OnboardingLens): {
  workspaceId: string | null;
  projectId: string | null;
} {
  return {
    workspaceId:
      lens.kind === "workspace" || lens.kind === "project_workspace"
        ? lens.workspaceId
        : null,
    projectId:
      lens.kind === "project" || lens.kind === "project_workspace"
        ? lens.projectId
        : null,
  };
}

export function resolveReadiness(
  meaningfulEntityCount: number,
  sparseThreshold = 3
): Readiness {
  if (
    !Number.isSafeInteger(meaningfulEntityCount) ||
    meaningfulEntityCount < 0
  ) {
    throw new RangeError(
      "meaningfulEntityCount must be a non-negative integer"
    );
  }
  if (!Number.isSafeInteger(sparseThreshold) || sparseThreshold < 1) {
    throw new RangeError("sparseThreshold must be a positive integer");
  }
  if (meaningfulEntityCount === 0) return "absent";
  if (meaningfulEntityCount < sparseThreshold) return "sparse";
  return "ready";
}

export interface ActionDescriptor {
  id: string;
  kind:
    | "start_guided_setup"
    | "resume_guided_setup"
    | "open_primary_surface"
    | "import_data"
    | "capture"
    | "connect_source"
    | "browse_marketplace"
    | "link_website"
    | "start_empty";
  label: string;
  description?: string;
  placement: "primary" | "secondary" | "overflow";
}

export function buildContextActions(input: {
  lens: OnboardingLens;
  readiness: Readiness;
  hasOnboardingRecipe: boolean;
  hasPrimarySurface: boolean;
  primarySurfaceKind?: "app" | "url" | "other";
  journeyStatus?: JourneyStatus;
}): ActionDescriptor[] {
  const actions: ActionDescriptor[] = [];
  const resumable =
    input.journeyStatus === "active" || input.journeyStatus === "paused";
  const primarySurfaceCopy =
    input.primarySurfaceKind === "url"
      ? {
          label: "Open linked website",
          description:
            "Open the ordinary website configured for this workspace.",
        }
      : input.primarySurfaceKind === "app"
        ? {
            label: "Open workspace app",
            description: "Use the app prepared for this workspace.",
          }
        : {
            label: "Open workspace start",
            description: "Use the experience prepared for this workspace.",
          };

  if (resumable) {
    actions.push({
      id: "resume-guided-setup",
      kind: "resume_guided_setup",
      label: "Continue setup",
      placement: "primary",
    });
  } else if (input.hasPrimarySurface && input.readiness !== "ready") {
    actions.push({
      id: "open-primary-surface",
      kind: "open_primary_surface",
      ...primarySurfaceCopy,
      placement: "primary",
    });
  } else if (input.readiness !== "ready") {
    actions.push({
      id: "start-guided-setup",
      kind: "start_guided_setup",
      label:
        input.lens.kind === "pod" ? "Set up with Synap" : "Set up this context",
      description: input.hasOnboardingRecipe
        ? "Follow the setup prepared for this context."
        : undefined,
      placement: "primary",
    });
  }

  if (
    input.hasPrimarySurface &&
    !actions.some((action) => action.kind === "open_primary_surface")
  ) {
    actions.push({
      id: "open-primary-surface",
      kind: "open_primary_surface",
      label: primarySurfaceCopy.label,
      description: primarySurfaceCopy.description,
      placement: actions.length === 0 ? "primary" : "secondary",
    });
  }

  if (input.readiness !== "ready") {
    actions.push({
      id: "import-data",
      kind: "import_data",
      label: "Import data",
      placement: "secondary",
    });
    actions.push({
      id: "capture",
      kind: "capture",
      label: "Capture something",
      placement: "overflow",
    });
    actions.push({
      id: "browse-marketplace",
      kind: "browse_marketplace",
      label: "Browse templates and apps",
      placement: "overflow",
    });
    if (
      !input.hasPrimarySurface &&
      (input.lens.kind === "workspace" ||
        input.lens.kind === "project_workspace")
    ) {
      actions.push({
        id: "link-website",
        kind: "link_website",
        label: "Use a website as workspace start",
        description:
          "Replace what opens first with an existing web tool. Synap home remains available.",
        placement: "overflow",
      });
    }
    actions.push({
      id: "start-empty",
      kind: "start_empty",
      label: "Start empty",
      placement: "overflow",
    });
  }

  return actions;
}

function serializeJourney(row: OnboardingJourney | undefined) {
  if (!row) return null;
  const lens: OnboardingLens | null =
    row.lensKind === "pod"
      ? { kind: "pod" }
      : row.lensKind === "workspace" && row.workspaceId
        ? { kind: "workspace", workspaceId: row.workspaceId }
        : row.lensKind === "project" && row.projectId
          ? { kind: "project", projectId: row.projectId }
          : row.workspaceId && row.projectId
            ? {
                kind: "project_workspace",
                workspaceId: row.workspaceId,
                projectId: row.projectId,
              }
            : null;

  if (!lens) {
    throw new Error(`Invalid persisted onboarding lens: ${row.id}`);
  }

  return {
    id: row.id,
    userId: row.userId,
    lens,
    lensKey: row.lensKey,
    templateVersion: row.templateVersion,
    status: row.status,
    progress: row.progress,
    evidence: row.evidence,
    offeredAt: row.offeredAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertLensAccess(
  userId: string,
  lens: OnboardingLens
): Promise<WorkspaceContext | null> {
  const db = await getDb();
  let workspaceContext: WorkspaceContext | null = null;

  if (lens.kind === "workspace" || lens.kind === "project_workspace") {
    const workspace = await db.query.workspaces.findFirst({
      where: and(
        eq(workspaces.id, lens.workspaceId),
        isNull(workspaces.archivedAt),
        userVisibleWhere(workspaces.id, userId)
      ),
      columns: { settings: true },
    });
    if (!workspace) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Workspace not found or inaccessible",
      });
    }
    workspaceContext = {
      settings: workspace.settings,
      packageVersion:
        readTemplateState(workspace.settings)?.version ?? undefined,
    };
  }

  if (lens.kind === "project" || lens.kind === "project_workspace") {
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, lens.projectId),
        or(
          ownerPrivateVisibleWhere(
            projects.workspaceId,
            projects.userId,
            userId
          ),
          inArray(
            projects.id,
            db
              .select({ id: projectMembers.projectId })
              .from(projectMembers)
              .where(eq(projectMembers.userId, userId))
          )
        )!
      ),
      columns: { id: true, settings: true },
    });
    if (!project) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Project not found or inaccessible",
      });
    }
    // A PROJECT-ONLY lens has no workspace to read the brief/layout from, so the
    // project's OWN settings carry them — build the SAME context shape as the
    // workspace branch above. A `project_workspace` lens keeps the WORKSPACE's
    // settings, which its branch already resolved.
    if (lens.kind === "project") {
      const settings = (project.settings ?? {}) as WorkspaceSettings;
      workspaceContext = {
        settings,
        packageVersion: settings.packageVersion,
      };
    }
  }

  return workspaceContext;
}

function meaningfulEntityWhere(userId: string, lens: OnboardingLens) {
  const workspaceLens =
    lens.kind === "workspace" || lens.kind === "project_workspace"
      ? lens.workspaceId
      : undefined;
  const projectLens =
    lens.kind === "project" || lens.kind === "project_workspace"
      ? projectLensWhere(entities.id, lens.projectId)
      : undefined;

  return and(
    isNull(entities.deletedAt),
    // A tool request records a wish, not first value — and onboarding's own
    // tools step writes them, so counting them would let setup satisfy the
    // data rule with its own side effect.
    drizzleSql`${entities.type} <> 'tool_request'`,
    drizzleSql`COALESCE(
      ${entities.systemData}->>${ONBOARDING_SCAFFOLD_SYSTEM_DATA_KEY},
      'false'
    ) <> 'true'`,
    accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId,
      workspaceLens,
      facetLens: true,
    }),
    // THE listing rule: demo (sample-project) and probe rows are not first
    // value — unless the lens is that project (the demo toggle).
    listableEntityWhere({
      projectLens:
        lens.kind === "project" || lens.kind === "project_workspace"
          ? lens.projectId
          : undefined,
    }),
    projectLens
  )!;
}

async function findJourney(
  userId: string,
  lens: OnboardingLens,
  templateVersion: string
) {
  const db = await getDb();
  return db.query.onboardingJourneys.findFirst({
    where: and(
      eq(onboardingJourneys.userId, userId),
      eq(onboardingJourneys.lensKey, lensKey(lens)),
      eq(onboardingJourneys.templateVersion, templateVersion)
    ),
    orderBy: desc(onboardingJourneys.updatedAt),
  });
}

function hasCompletionEvidence(
  evidence: OnboardingJourneyEvidenceRecord
): boolean {
  return (
    evidence.meaningfulEntityIds.length > 0 ||
    evidence.completedCriteria.length > 0 ||
    evidence.firstValueAt !== undefined
  );
}

export function mergeJourneyProgress(
  previous: OnboardingJourneyProgressRecord | undefined,
  patch: Partial<OnboardingJourneyProgressRecord> | undefined
): OnboardingJourneyProgressRecord {
  const base = previous ?? { completedActionIds: [], values: {} };
  return {
    ...(base.currentActionId ? { currentActionId: base.currentActionId } : {}),
    completedActionIds: patch?.completedActionIds ?? base.completedActionIds,
    values: { ...base.values, ...(patch?.values ?? {}) },
    ...(patch?.currentActionId
      ? { currentActionId: patch.currentActionId }
      : {}),
  };
}

export function assertJourneyTransition(
  previous: JourneyStatus | undefined,
  next: JourneyStatus
): void {
  const allowedByStatus: Record<JourneyStatus, readonly JourneyStatus[]> = {
    offered: ["active", "dismissed"],
    active: ["active", "paused", "completed", "dismissed"],
    paused: ["active", "paused", "completed", "dismissed"],
    dismissed: ["active", "dismissed"],
    completed: ["completed"],
  };
  const allowed =
    previous === undefined
      ? next === "active" || next === "dismissed"
      : allowedByStatus[previous].includes(next);

  if (!allowed) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Onboarding journey cannot move from ${previous ?? "new"} to ${next}`,
    });
  }
}

/**
 * Which completion rule a journey satisfies, or null when none does.
 *
 * Every lens completes when it holds meaningful data. The POD lens also
 * completes when setup steps were done — the pod journey is a restartable
 * utility (tools, connections), and a new user who finished it may legitimately
 * have no entities yet.
 */
export function resolveCompletionCriterion(input: {
  lensKind: OnboardingLens["kind"];
  meaningfulEntityCount: number;
  completedActionIds: readonly string[];
}): "meaningful-data-present" | "pod-setup-steps-completed" | null {
  if (input.meaningfulEntityCount > 0) return "meaningful-data-present";
  if (input.lensKind === "pod" && input.completedActionIds.length > 0) {
    return "pod-setup-steps-completed";
  }
  return null;
}

export interface RecordedTool {
  name: string;
  key: string | null;
  state: "connect" | "install" | "wanted";
  status:
    | "created"
    | "existing"
    | "proposed"
    | "selected"
    | "invalid-name"
    | "refused";
  toolRequestId: string | null;
  proposalId?: string;
  reviewUrl?: string;
}

/**
 * How `recordTools` may write the pod journey, or null for no journey write.
 *
 * From onboarding the user is IN the journey: a new or offered journey
 * becomes active and the current step is the tools step. From settings the
 * journey is not the user's context: a live journey (active, paused,
 * completed, dismissed) keeps its status and current step and only stores the
 * selection. With no journey or an offered one, no write happens at all:
 * creating or activating a row would reopen onboarding on the next launch, and
 * `offered → offered` is not a legal transition.
 */
export function planToolsJourneyWrite(
  origin: "onboarding" | "settings",
  existing: JourneyStatus | undefined
): { status: JourneyStatus; setCurrentAction: boolean } | null {
  if (origin === "onboarding") {
    return {
      status: !existing || existing === "offered" ? "active" : existing,
      setCurrentAction: true,
    };
  }
  if (!existing || existing === "offered") return null;
  return { status: existing, setCurrentAction: false };
}

/** The `recordTools` row for a tool whose demand went through `recordToolDemand`. */
export function toRecordedTool(
  name: string,
  state: RecordedTool["state"],
  result: RecordToolDemandResult
): RecordedTool {
  const status: RecordedTool["status"] =
    result.status === "already-recorded" || result.status === "updated"
      ? "existing"
      : result.status;
  return {
    name,
    key: result.normalizedKey,
    state,
    status,
    toolRequestId: result.entityId,
    ...(result.proposalId ? { proposalId: result.proposalId } : {}),
    ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
  };
}

/**
 * Progress for a restart: completed steps and the current step are cleared,
 * values (e.g. the tools already chosen) are kept so the utility pre-fills.
 */
export function restartJourneyProgress(
  previous: OnboardingJourneyProgressRecord | undefined
): OnboardingJourneyProgressRecord {
  return { completedActionIds: [], values: { ...(previous?.values ?? {}) } };
}

export function shouldCountMeaningfulEntity(input: {
  createdByKind: "human" | "ai_agent" | "system" | null;
  systemData: unknown;
}): boolean {
  if (
    typeof input.systemData !== "object" ||
    input.systemData === null ||
    Array.isArray(input.systemData)
  ) {
    return true;
  }
  return (
    (input.systemData as Record<string, unknown>)[
      ONBOARDING_SCAFFOLD_SYSTEM_DATA_KEY
    ] !== true
  );
}

async function saveJourney(input: {
  userId: string;
  lens: OnboardingLens;
  templateVersion?: string;
  status: JourneyStatus;
  /**
   * A function reads the row's progress UNDER the transition lock, so a merge
   * that depends on the stored value never races another device's write.
   */
  progress?:
    | Partial<OnboardingJourneyProgressRecord>
    | ((
        existing: OnboardingJourneyProgressRecord | undefined
      ) => Partial<OnboardingJourneyProgressRecord>);
  evidence?: OnboardingJourneyEvidenceRecord;
  /** Start over from ANY status (only with status "active"). */
  restart?: boolean;
}) {
  const db = await getDb();
  const workspaceContext = await assertLensAccess(input.userId, input.lens);
  const templateVersion = resolveTemplateVersion(
    input.templateVersion,
    workspaceContext
  );
  const refs = lensReferences(input.lens);
  const journeyKey = [input.userId, lensKey(input.lens), templateVersion].join(
    ":"
  );

  return db.transaction(async (tx) => {
    // Serialize transitions even before the journey row exists. A row lock alone
    // cannot protect two concurrent first writes racing through the UPSERT.
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext(${journeyKey}))`
    );
    const [existing] = await tx
      .select()
      .from(onboardingJourneys)
      .where(
        and(
          eq(onboardingJourneys.userId, input.userId),
          eq(onboardingJourneys.lensKey, lensKey(input.lens)),
          eq(onboardingJourneys.templateVersion, templateVersion)
        )
      )
      .limit(1)
      .for("update");

    const restarting = input.restart === true && input.status === "active";
    if (!restarting) assertJourneyTransition(existing?.status, input.status);
    const now = new Date();
    const progress = mergeJourneyProgress(
      restarting
        ? restartJourneyProgress(existing?.progress)
        : existing?.progress,
      typeof input.progress === "function"
        ? input.progress(restarting ? undefined : existing?.progress)
        : input.progress
    );
    const priorEvidence = existing?.evidence ?? {
      meaningfulEntityIds: [],
      completedCriteria: [],
    };
    // Restart history survives every later evidence write (e.g. completion).
    const restartHistory = {
      ...(priorEvidence.restarts !== undefined
        ? { restarts: priorEvidence.restarts }
        : {}),
      ...(priorEvidence.restartedAt !== undefined
        ? { restartedAt: priorEvidence.restartedAt }
        : {}),
    };
    const evidence: OnboardingJourneyEvidenceRecord = restarting
      ? {
          ...priorEvidence,
          restarts: (priorEvidence.restarts ?? 0) + 1,
          restartedAt: now.toISOString(),
        }
      : input.evidence
        ? { ...restartHistory, ...input.evidence }
        : priorEvidence;

    if (input.status === "completed" && !hasCompletionEvidence(evidence)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Completion requires first-value evidence",
      });
    }

    const [saved] = await tx
      .insert(onboardingJourneys)
      .values({
        userId: input.userId,
        lensKind: input.lens.kind,
        lensKey: lensKey(input.lens),
        ...refs,
        templateVersion,
        status: input.status,
        progress,
        evidence,
        startedAt:
          input.status === "active" ? (existing?.startedAt ?? now) : undefined,
        pausedAt: input.status === "paused" ? now : null,
        completedAt: input.status === "completed" ? now : null,
        dismissedAt: input.status === "dismissed" ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          onboardingJourneys.userId,
          onboardingJourneys.lensKey,
          onboardingJourneys.templateVersion,
        ],
        set: {
          status: input.status,
          progress,
          evidence,
          startedAt:
            input.status === "active"
              ? (existing?.startedAt ?? now)
              : existing?.startedAt,
          pausedAt: input.status === "paused" ? now : null,
          completedAt: input.status === "completed" ? now : null,
          dismissedAt: input.status === "dismissed" ? now : null,
          updatedAt: now,
        },
      })
      .returning();

    return serializeJourney(saved);
  });
}

/**
 * STATUS-NEUTRAL values write: merge `values` into `progress.values` one level
 * deep (a key replaces its old value; other keys stay) and NEVER touch the
 * journey's status, current step, completed steps, evidence or timestamps.
 * Every other door moves the status (start → active, pause → paused, …), so a
 * fact learned off-journey — the first-run answer, "day one seen" — could not
 * be recorded on an absent / offered / dismissed / completed journey, and
 * lived on one device only.
 *
 * No row yet ⇒ one is created in the table's default status, `offered` — the
 * state of a journey nobody has started; it does not start one.
 */
async function recordJourneyValues(input: {
  userId: string;
  lens: OnboardingLens;
  templateVersion?: string;
  values: Record<string, unknown>;
}) {
  const db = await getDb();
  const workspaceContext = await assertLensAccess(input.userId, input.lens);
  const templateVersion = resolveTemplateVersion(
    input.templateVersion,
    workspaceContext
  );
  const refs = lensReferences(input.lens);
  const journeyKey = [input.userId, lensKey(input.lens), templateVersion].join(
    ":"
  );

  return db.transaction(async (tx) => {
    // The same serialization as `saveJourney`: a values write never races a
    // status move into a lost update.
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtext(${journeyKey}))`
    );
    const [existing] = await tx
      .select()
      .from(onboardingJourneys)
      .where(
        and(
          eq(onboardingJourneys.userId, input.userId),
          eq(onboardingJourneys.lensKey, lensKey(input.lens)),
          eq(onboardingJourneys.templateVersion, templateVersion)
        )
      )
      .limit(1)
      .for("update");
    const now = new Date();

    if (existing) {
      const progress: OnboardingJourneyProgressRecord = {
        ...existing.progress,
        values: { ...(existing.progress?.values ?? {}), ...input.values },
      };
      const [saved] = await tx
        .update(onboardingJourneys)
        .set({ progress, updatedAt: now })
        .where(eq(onboardingJourneys.id, existing.id))
        .returning();
      return serializeJourney(saved);
    }

    const [saved] = await tx
      .insert(onboardingJourneys)
      .values({
        userId: input.userId,
        lensKind: input.lens.kind,
        lensKey: lensKey(input.lens),
        ...refs,
        templateVersion,
        status: "offered",
        progress: { completedActionIds: [], values: { ...input.values } },
        updatedAt: now,
      })
      .returning();
    return serializeJourney(saved);
  });
}

// ── Start journey (plan v1 §2.2): the pod's reads and the ONE write door ───

const POD_LENS = { kind: "pod" } as const;
const POD_TEMPLATE_VERSION = "1";

/** Step name → the `values.start` key it fills, and the patch it accepts. */
const startPatchSchemas = {
  intent: z.object({
    slug: z.string().min(1).max(200),
    source: z.enum(["cloud", "here"]),
  }),
  views: z.object({
    profile: z.string().min(1).max(200),
    view: z.string().min(1).max(200),
    type: z.string().min(1).max(100),
  }),
  path: z.object({ kind: z.enum(["quick", "cobuild"]) }),
  setup: z.object({ proposalId: z.string().uuid() }),
  agent: z.object({ agentUserId: z.string().min(1).max(200) }),
  "first-work": z.object({ sessionId: z.string().uuid() }),
} as const;
type RecordableStep = keyof typeof startPatchSchemas;
const START_VALUE_KEY: Record<RecordableStep, string> = {
  intent: "intent",
  views: "view",
  path: "path",
  setup: "setup",
  agent: "agent",
  "first-work": "firstSession",
};

const startValuesOf = (
  progress: OnboardingJourneyProgressRecord | undefined
): StartValues | null =>
  (progress?.values?.start as StartValues | undefined) ?? null;

async function viewerEmail(userId: string): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
  }
  return row.email;
}

const startNames = new Set<string>(
  START_STEP_IDS.map((id) => id.slice("start:".length))
);

export const onboardingRouter = router({
  resolveContext: podProcedure
    .input(journeyIdentitySchema)
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const workspaceContext = await assertLensAccess(ctx.userId, input.lens);
      const templateVersion = resolveTemplateVersion(
        input.templateVersion,
        workspaceContext
      );
      const entityWhere = meaningfulEntityWhere(ctx.userId, input.lens);
      const [countRow, profileRows, journey] = await Promise.all([
        db.select({ value: count() }).from(entities).where(entityWhere),
        db
          .selectDistinct({ slug: profiles.slug })
          .from(entities)
          .innerJoin(profiles, eq(profiles.id, entities.profileId))
          .where(entityWhere),
        findJourney(ctx.userId, input.lens, templateVersion),
      ]);

      const meaningfulEntityCount = Number(countRow[0]?.value ?? 0);
      // The space brief, through its ONE reader. Onboarding is the brief's
      // INTERVIEW mode — a steady-state brief (purpose only) has no recipe.
      const onboardingRecipe = readSpaceBrief(workspaceContext?.settings);
      const collectionSlugs = new Set(
        onboardingRecipe?.collect?.map((item) => item.profileSlug) ?? []
      );
      const completedCollectionCount = new Set(
        profileRows
          .map((row) => row.slug)
          .filter((slug) => collectionSlugs.has(slug))
      ).size;
      const readiness = resolveReadiness(meaningfulEntityCount);
      const hasPrimarySurface =
        workspaceContext?.settings.layout?.primarySurface != null;
      const primarySurfaceKind = (() => {
        const surface = workspaceContext?.settings.layout?.primarySurface;
        if (!surface) return undefined;
        if (surface.kind === "app" || surface.kind === "url") {
          return surface.kind;
        }
        return "other" as const;
      })();
      const signals = {
        meaningfulEntityCount,
        configuredCollectionCount: collectionSlugs.size,
        completedCollectionCount,
        hasOnboardingRecipe: isInterviewBrief(onboardingRecipe),
        hasPrimarySurface,
        primarySurfaceKind: primarySurfaceKind ?? null,
      };

      return {
        lens: input.lens,
        readiness,
        signals,
        actions: buildContextActions({
          lens: input.lens,
          readiness,
          hasOnboardingRecipe: signals.hasOnboardingRecipe,
          hasPrimarySurface,
          primarySurfaceKind,
          journeyStatus: journey?.status,
        }),
        journey: serializeJourney(journey),
        templateVersion,
      };
    }),

  getJourney: podProcedure
    .input(journeyIdentitySchema)
    .query(async ({ ctx, input }) => {
      const workspaceContext = await assertLensAccess(ctx.userId, input.lens);
      const templateVersion = resolveTemplateVersion(
        input.templateVersion,
        workspaceContext
      );
      return serializeJourney(
        await findJourney(ctx.userId, input.lens, templateVersion)
      );
    }),

  startJourney: podProcedure
    .input(
      journeyIdentitySchema.extend({
        progress: progressPatchSchema.optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      saveJourney({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        status: "active",
        progress: input.progress,
      })
    ),

  pauseJourney: podProcedure
    .input(
      journeyIdentitySchema.extend({
        progress: progressPatchSchema.optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      saveJourney({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        status: "paused",
        progress: input.progress,
      })
    ),

  /**
   * Start the caller's OWN journey over, from ANY status (completed, dismissed,
   * paused, active, offered, or none yet) → active. Completed steps are
   * cleared — UNLESS `completedActionIds` is supplied, which is how ONE step is
   * re-run while the steps before it stay done — the current step becomes
   * `firstActionId` (absent when not given), `completedAt` is cleared, and
   * chosen values (e.g. the tools list) are kept.
   * History is kept: `startedAt` stays, `evidence.restarts` counts up and
   * `evidence.restartedAt` is stamped.
   */
  restartJourney: podProcedure
    .input(
      journeyIdentitySchema.extend({
        firstActionId: z.string().min(1).max(200).optional(),
        // Optional and additive. Omit it and the restart clears the prefix
        // exactly as before; supply it and the prefix is preserved, which is
        // what makes a single step re-runnable after the journey completed.
        // Same shape as progressPatchSchema.completedActionIds.
        completedActionIds: z
          .array(z.string().min(1).max(200))
          .max(200)
          .optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      saveJourney({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        status: "active",
        restart: true,
        ...(input.firstActionId || input.completedActionIds
          ? {
              progress: {
                ...(input.firstActionId
                  ? { currentActionId: input.firstActionId }
                  : {}),
                ...(input.completedActionIds
                  ? { completedActionIds: input.completedActionIds }
                  : {}),
              },
            }
          : {}),
      })
    ),

  dismissJourney: podProcedure
    .input(journeyIdentitySchema)
    .mutation(({ ctx, input }) =>
      saveJourney({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        status: "dismissed",
      })
    ),

  completeJourney: podProcedure
    .input(
      journeyIdentitySchema.extend({
        progress: progressPatchSchema.optional(),
        evidence: evidenceSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workspaceContext = await assertLensAccess(ctx.userId, input.lens);
      const db = await getDb();
      const [countRow, existing] = await Promise.all([
        db
          .select({ value: count() })
          .from(entities)
          .where(meaningfulEntityWhere(ctx.userId, input.lens)),
        findJourney(
          ctx.userId,
          input.lens,
          resolveTemplateVersion(input.templateVersion, workspaceContext)
        ),
      ]);
      const criterion = resolveCompletionCriterion({
        lensKind: input.lens.kind,
        meaningfulEntityCount: Number(countRow[0]?.value ?? 0),
        completedActionIds: [
          ...(existing?.progress.completedActionIds ?? []),
          ...(input.progress?.completedActionIds ?? []),
        ],
      });
      if (!criterion) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.lens.kind === "pod"
              ? "Completion requires a finished setup step or meaningful data"
              : "Completion requires meaningful data in this context",
        });
      }

      return saveJourney({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        status: "completed",
        progress: input.progress,
        evidence: {
          meaningfulEntityIds: [],
          completedCriteria: Array.from(
            new Set([...(input.evidence?.completedCriteria ?? []), criterion])
          ),
          firstValueAt: new Date().toISOString(),
        },
      });
    }),

  /**
   * The tools list: record demand for every tool marked `wanted` (one deduped
   * `tool_request` per tool, through the governed entity door) and store the
   * user's FULL current selection on the pod journey (`progress.values.tools`)
   * as `planToolsJourneyWrite` decides. From onboarding, a new or merely
   * offered journey becomes active. From settings, the journey's lifecycle and
   * current step are never touched, so recording a tool never reopens onboarding.
   */
  /**
   * The setup proposal (start step S4): the chosen start arrives as ONE
   * `workspace/create` proposal from the person's own agent, carrying what
   * approving creates (`data.contents`: spaces, kinds, views, what waits on a
   * connection). A pending setup is handed back, never filed twice.
   * `services/onboarding/setup.ts`.
   */
  proposeSetup: podAdminProcedure
    .input(
      z.object({
        slug: z.string().trim().min(1).max(200),
        /** The view the space opens on (start step S2). */
        view: z
          .object({
            profile: z.string().trim().min(1).max(200),
            view: z.string().trim().min(1).max(200),
          })
          .optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      proposeSetup({ userId: ctx.userId, slug: input.slug, view: input.view })
    ),

  /**
   * Undo setup: archive the spaces the approved setup created (restorable
   * from Spaces; the kinds stay), then send the journey back to its first
   * step (`values.start` keeps only what the pod read for the person: the
   * cloud answers and experiment arms).
   */
  undoSetup: podAdminProcedure.mutation(async ({ ctx }) => {
    const { workspacesRouter } = await import("./workspaces.js");
    const workspacesCaller = workspacesRouter.createCaller(
      ctx as Parameters<typeof workspacesRouter.createCaller>[0]
    );
    const result = await undoSetup({
      userId: ctx.userId,
      archive: async (workspaceId) => {
        const done = await workspacesCaller.archive({
          workspaceId,
          reasoning: "Undo setup",
        });
        return {
          status: done.status,
          ...("proposalId" in done && done.proposalId
            ? { proposalId: done.proposalId }
            : {}),
        };
      },
    });
    const journey = await findJourney(ctx.userId, { kind: "pod" }, "1");
    const start = journey?.progress?.values?.start;
    if (start && typeof start === "object") {
      const { cloud, experiments } = start as Record<string, unknown>;
      await recordJourneyValues({
        userId: ctx.userId,
        lens: { kind: "pod" },
        values: {
          start: {
            v: 1,
            ...(cloud !== undefined ? { cloud } : {}),
            ...(experiments !== undefined ? { experiments } : {}),
          },
        },
      });
    }
    return result;
  }),

  /**
   * Record values on the journey WITHOUT moving it (`recordJourneyValues`):
   * `progress.values` merged one level deep; status, step and evidence
   * untouched; an absent journey is created `offered`. For facts learned off
   * the journey — the first-run answer, "day one seen" — that must reach
   * every device.
   */
  recordValues: podProcedure
    .input(
      journeyIdentitySchema.extend({
        values: z
          .record(z.string().min(1).max(200), z.unknown())
          .refine((v) => Object.keys(v).length > 0, "values is empty"),
      })
    )
    .mutation(({ ctx, input }) =>
      recordJourneyValues({
        userId: ctx.userId,
        lens: input.lens,
        templateVersion: input.templateVersion,
        values: input.values,
      })
    ),

  /**
   * The first session with a goal (start step S6, plan v1 §2.6): one focus
   * session in the setup's space, with the person's connected agent on it and
   * every agent write in it proposed. Everything it needs is read from the
   * pod (`services/focus-sessions/first-session.ts`); an open first session is
   * handed back, never created twice.
   */
  startFirstSession: podAdminProcedure.mutation(({ ctx }) =>
    startFirstSession({ userId: ctx.userId })
  ),

  recordTools: podProcedure
    .input(
      z.object({
        tools: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              providerKey: z.string().trim().min(1).max(100).optional(),
              /**
               * connect = a connector exists; install = the catalog has it;
               * wanted = Synap cannot connect it yet (the only state that
               * records demand).
               */
              state: z.enum(["connect", "install", "wanted"]),
            })
          )
          .min(1)
          .max(100),
        /** Where the list is shown: inside onboarding, or anywhere else. */
        origin: z.enum(["onboarding", "settings"]).default("onboarding"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const lens: OnboardingLens = { kind: "pod" };
      const existing = await findJourney(ctx.userId, lens, "1");
      const plan = planToolsJourneyWrite(input.origin, existing?.status);

      const { entitiesRouter } = await import("./entities.js");
      const caller = entitiesRouter.createCaller(
        ctx as Parameters<typeof entitiesRouter.createCaller>[0]
      );
      const recorded: RecordedTool[] = [];
      for (const tool of input.tools) {
        if (tool.state !== "wanted") {
          recorded.push({
            name: tool.name,
            key: normalizeToolName(tool.name),
            state: tool.state,
            status: "selected",
            toolRequestId: null,
          });
          continue;
        }
        const result = await recordToolDemand({
          caller,
          userId: ctx.userId,
          toolName: tool.name,
          source: input.origin,
        });
        recorded.push(toRecordedTool(tool.name, tool.state, result));
      }

      const journey = plan
        ? await saveJourney({
            userId: ctx.userId,
            lens,
            status: plan.status,
            progress: {
              ...(plan.setCurrentAction ? { currentActionId: "tools" } : {}),
              values: {
                tools: input.tools.map((tool) => ({
                  name: tool.name,
                  key: normalizeToolName(tool.name),
                  ...(tool.providerKey
                    ? { providerKey: tool.providerKey }
                    : {}),
                  state: tool.state,
                })),
              },
            },
          })
        : serializeJourney(existing);

      return { recorded, journey };
    }),
  /**
   * Is onboarding due, and where is this person in it? A pure read: it fails
   * loudly (the client shows the failure) and never forces onboarding on a
   * guess. `cloud` is asked only while the intent step is open, and only of a
   * pod admin.
   */
  startState: podProcedure.query(async ({ ctx }) => {
    const admin = await isPodAdmin(ctx.userId);
    const journey = await findJourney(
      ctx.userId,
      POD_LENS,
      POD_TEMPLATE_VERSION
    );
    const values = startValuesOf(journey?.progress);
    const spaces = admin ? await countNonSystemSpaces() : 0;
    const due = isStartDue({
      isPodAdmin: admin,
      journeyStatus: journey?.status ?? null,
      hasStartValues: values !== null,
      nonSystemSpaceCount: spaces,
    });
    if (!admin) {
      return {
        due,
        journey: serializeJourney(journey),
        steps: [],
        next: null,
        counts: { done: 0, total: START_STEP_IDS.length },
        cloud: null,
        starts: undefined,
      };
    }
    const steps = deriveStartSteps(
      await gatherStartFacts({
        userId: ctx.userId,
        values,
        journeyStatus: journey?.status ?? null,
      })
    );
    const intentOpen = !steps[0]!.done;
    return {
      due,
      journey: serializeJourney(journey),
      steps,
      next: nextStartStep(steps),
      counts: {
        done: steps.filter((s) => s.done).length,
        total: steps.length,
      },
      cloud: intentOpen
        ? await readCloudAnswers(await viewerEmail(ctx.userId))
        : null,
      starts: intentOpen ? listBundledStarts() : undefined,
    };
  }),

  /** The starts, from the bundled templates package: works offline. */
  listStarts: podProcedure.query(() => listBundledStarts()),

  /**
   * The ONE write door of the start journey. Deep-merges `values.start[step]`
   * under the journey lock (no client read-modify-write across devices), sets
   * the resume step and the model's completed prefix (never a client list),
   * and moves offered / none / paused / dismissed to active.
   */
  recordStartStep: podProcedure
    .input(
      z.object({
        step: z.string().refine((s) => startNames.has(s), "unknown step"),
        patch: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!(await isPodAdmin(ctx.userId))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Pod admin access required",
        });
      }
      const step = input.step as RecordableStep;
      const schema = startPatchSchemas[step];
      if (!schema) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Step ${input.step} is derived, not recorded`,
        });
      }
      const patch: Record<string, unknown> = schema.parse(input.patch);
      const now = new Date().toISOString();
      const key = START_VALUE_KEY[step];

      if (step === "intent") {
        if (!listBundledStarts().some((s) => s.slug === patch.slug)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown start: ${String(patch.slug)}`,
          });
        }
        // A cloud choice copies what the CP said, read here, never what the
        // client claims it said.
        if (patch.source === "cloud") {
          const cloud = await readCloudAnswers(await viewerEmail(ctx.userId));
          if (cloud.status !== "ok") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `The cloud answer is not available (${cloud.status})`,
            });
          }
        }
      }

      const existing = await findJourney(
        ctx.userId,
        POD_LENS,
        POD_TEMPLATE_VERSION
      );
      const before = startValuesOf(existing?.progress);
      const factsOf = (values: StartValues | null, status: string | null) =>
        gatherStartFacts({ userId: ctx.userId, values, journeyStatus: status });

      // Transitions: a step may be recorded when every step before it is done
      // (the next step, or a step already passed, to change a choice).
      const next = nextStartStep(
        deriveStartSteps(await factsOf(before, existing?.status ?? null))
      );
      if (
        next !== null &&
        START_STEP_IDS.indexOf(`start:${step}` as StartStepId) >
          START_STEP_IDS.indexOf(next)
      ) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Step ${step} cannot be recorded before ${next}`,
        });
      }

      const cloudCopy =
        step === "intent" && patch.source === "cloud"
          ? await readCloudAnswers(await viewerEmail(ctx.userId))
          : null;

      const mergeStart = (stored: StartValues | null): StartValues => {
        let merged = deepMerge(
          (stored ?? { v: 1 }) as Record<string, unknown>,
          {
            v: 1,
            [key]: { ...patch, at: now },
          }
        );
        if (cloudCopy?.status === "ok") {
          merged = deepMerge(merged, {
            cloud: {
              ...cloudCopy.answers,
              experiments: cloudCopy.experiments,
              readAt: now,
            },
          });
        }
        return merged as unknown as StartValues;
      };
      // Facts are read before the lock (no query may run inside the journey
      // transaction); the merge and the derived prefix are computed under it.
      const afterFacts = await factsOf(mergeStart(before), "active");

      const journey = await saveJourney({
        userId: ctx.userId,
        lens: POD_LENS,
        status: "active",
        progress: (stored) => {
          const merged = mergeStart(startValuesOf(stored));
          const steps = deriveStartSteps({ ...afterFacts, values: merged });
          return {
            values: { start: merged },
            // Foreign ids (`relay:...`) stay; the start ids are the model's.
            completedActionIds: [
              ...(stored?.completedActionIds ?? []).filter(
                (id) => !id.startsWith("start:")
              ),
              ...completedStartPrefix(steps),
            ],
            currentActionId: nextStartStep(steps) ?? "start:done",
          };
        },
      });
      return journey;
    }),
});
