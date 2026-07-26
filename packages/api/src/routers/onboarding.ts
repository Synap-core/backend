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
  workspaces,
} from "@synap/database";
import type {
  OnboardingJourney,
  OnboardingJourneyEvidenceRecord,
  OnboardingJourneyProgressRecord,
  WorkspaceSettings,
} from "@synap/database";
import { podProcedure, router } from "../trpc.js";
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
      packageVersion: workspace.settings.packageVersion,
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
      columns: { id: true },
    });
    if (!project) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Project not found or inaccessible",
      });
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
  progress?: Partial<OnboardingJourneyProgressRecord>;
  evidence?: OnboardingJourneyEvidenceRecord;
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

    assertJourneyTransition(existing?.status, input.status);
    const now = new Date();
    const progress = mergeJourneyProgress(existing?.progress, input.progress);
    const evidence = input.evidence ??
      existing?.evidence ?? {
        meaningfulEntityIds: [],
        completedCriteria: [],
      };

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
      const onboardingRecipe = workspaceContext?.settings.onboarding;
      const collectionSlugs = new Set(
        onboardingRecipe?.collect.map((item) => item.profileSlug) ?? []
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
        hasOnboardingRecipe: onboardingRecipe !== undefined,
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
      await assertLensAccess(ctx.userId, input.lens);
      const db = await getDb();
      const [countRow] = await db
        .select({ value: count() })
        .from(entities)
        .where(meaningfulEntityWhere(ctx.userId, input.lens));
      if (Number(countRow?.value ?? 0) === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Completion requires meaningful data in this context",
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
            new Set([
              ...(input.evidence?.completedCriteria ?? []),
              "meaningful-data-present",
            ])
          ),
          firstValueAt: new Date().toISOString(),
        },
      });
    }),
});
