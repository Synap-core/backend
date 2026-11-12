/**
 * WHERE A GOAL SITS — its parent goal and the pillars it advances (goals /
 * pillars / health contract, 2026-11-12, C4). One input shape for every door
 * that starts or updates a goal: tRPC `tracks.start` / `tracks.setDirection`,
 * Hub `POST /tracks` / `PATCH /tracks/:id/direction`, MCP `synap_start_track`
 * / `synap_update_track`, and the `track/create` / `track/update` replays.
 *
 *   parentGoalId  → `goal --serves--> parent`, a goal of the SAME project.
 *                   PRIMARY (`metadata.primary`) when the goal has no primary
 *                   parent yet, else a second, non-primary parent (a goal
 *                   rolls up fully to its primary parent only). Added; a
 *                   parent is never removed here.
 *   pillars       → `goal --advances--> space`: the WHOLE list (replace). A
 *                   space not listed loses its edge; `[]` clears every
 *                   pillar. Every space must be one the goal's project
 *                   `uses`. Exactly one is primary: the entry marked
 *                   `primary`, else the FIRST.
 *
 * The links are part of the goal write, like `replacesTrackId`: they ride the
 * goal's own gate payload (an agent's start or update is ONE proposal, the
 * person sees the parent and the pillars in it), and are written AFTER that
 * write is authorized, through THE dependency door's ungoverned write
 * (`writeDependencyLink`: endpoint floor, cycle, project-uses and one-primary
 * checks, the one store write, `link.create.completed`). Every edge is checked
 * by the door's own validator BEFORE governance and again before the goal's
 * columns are written ({@link checkGoalPlacement}), so a person is never asked
 * to approve what cannot apply, and a refused placement changes nothing.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, db, eq, links, projectTracks } from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  ADVANCES_LINK_TYPE,
  LINK_PRIMARY_KEY,
  SERVES_LINK_TYPE,
} from "@synap-core/types/connections";
import { AccessContext, scopedDb } from "../../access/index.js";
import { listWorkspacesUsedByProject } from "../../utils/project-workspace.js";
import { checkLinkEndpointVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import {
  deleteDependencyEdge,
  readGoalPrimary,
  validateDependencyEdge,
  writeDependencyLink,
  PILLAR_NOT_USED_ERROR,
  type LinkAttribution,
} from "../links/dependency-links.js";

/** A goal advances a handful of pillars, never the whole pod. */
export const GOAL_PILLARS_MAX = 12;

export const goalPlacementInputSchema = z
  .object({
    /** The goal this one serves (a sub-goal's parent). */
    parentGoalId: z.string().uuid().optional(),
    /** The spaces of its project this goal moves forward. */
    pillars: z
      .array(
        z
          .object({
            workspaceId: z.string().uuid(),
            primary: z.boolean().optional(),
          })
          .strict()
      )
      .max(GOAL_PILLARS_MAX)
      .optional(),
  })
  .strict();
export type GoalPlacementInput = z.infer<typeof goalPlacementInputSchema>;

/** The placement fields, by name — what a door or a proposal payload may carry. */
export const GOAL_PLACEMENT_KEYS = ["parentGoalId", "pillars"] as const;
type _AllPlacementKeys = [
  Exclude<keyof GoalPlacementInput, (typeof GOAL_PLACEMENT_KEYS)[number]>,
] extends [never]
  ? true
  : never;
const _allPlacementKeys: _AllPlacementKeys = true;
void _allPlacementKeys;

/** The placement fields present on `bag` (a door's args, a proposal's payload). */
export function pickGoalPlacementInput(
  bag: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!bag) return out;
  for (const k of GOAL_PLACEMENT_KEYS) {
    if (k in bag && bag[k] !== undefined) out[k] = bag[k];
  }
  return out;
}

export function hasGoalPlacementInput(bag: Record<string, unknown>): boolean {
  return Object.keys(pickGoalPlacementInput(bag)).length > 0;
}

/**
 * Parse a placement, refusing it in words an agent can act on: the schema,
 * at most one primary pillar, no space listed twice.
 */
export function parseGoalPlacementInput(raw: unknown): GoalPlacementInput {
  const parsed = goalPlacementInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid goal placement: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "placement"} ${i.message}`)
        .join("; ")}.`,
    });
  }
  const pillars = parsed.data.pillars ?? [];
  if (pillars.filter((p) => p.primary === true).length > 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A goal has at most one primary pillar: mark one entry primary, the others not.",
    });
  }
  if (new Set(pillars.map((p) => p.workspaceId)).size !== pillars.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Each pillar is listed once.",
    });
  }
  return parsed.data;
}

/**
 * The checks a placement gets BEFORE anything is written: before the goal's
 * gate (no proposal is filed for what could not apply) and again before an
 * approved update writes the goal's columns (a refused placement changes
 * nothing). The parent goal is visible, not the goal itself and of the same
 * project; every pillar is a space the project uses and the caller may reach.
 * For an existing goal each planned edge also passes THE door's own validator
 * (`validateDependencyEdge`: the endpoint floor, the write floor, the serves
 * cycle check). The one-primary rule cannot refuse: the parent is primary
 * only when the goal has none, and the pillar list decides its own primary
 * (the others are demoted first). The door re-checks at the write.
 */
export async function checkGoalPlacement(
  input: GoalPlacementInput,
  ctx: {
    projectId: string;
    userId: string;
    trackId?: string;
    /** `false` at a start: the goal's row is not written yet. */
    goalExists?: boolean;
  }
): Promise<void> {
  const existing = ctx.goalExists !== false ? ctx.trackId : undefined;
  const refuse = (refusal: { httpStatus: number; error: string }): never => {
    throw new TRPCError({
      code: refusal.httpStatus === 404 ? "NOT_FOUND" : "BAD_REQUEST",
      message: refusal.error,
    });
  };
  if (input.parentGoalId) {
    if (input.parentGoalId === ctx.trackId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "A goal cannot serve itself.",
      });
    }
    const parent = await scopedDb(
      AccessContext.from({ userId: ctx.userId })
    ).findFirst<ProjectTrack>(projectTracks, {
      where: eq(projectTracks.id, input.parentGoalId),
    });
    if (!parent) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message:
          "The parent goal was not found (synap_list_tracks lists the goals you can see).",
      });
    }
    if (parent.projectId !== ctx.projectId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: PARENT_OTHER_PROJECT_ERROR,
      });
    }
    if (existing) {
      const valid = await validateDependencyEdge(
        {
          fromType: "track",
          fromId: existing,
          toType: "track",
          toId: input.parentGoalId,
          linkType: SERVES_LINK_TYPE,
        },
        ctx.userId
      );
      if (!valid.ok) refuse(valid);
    }
  }
  if (input.pillars?.length) {
    const used = new Set(
      await listWorkspacesUsedByProject(ctx.userId, ctx.projectId)
    );
    if (input.pillars.some((p) => !used.has(p.workspaceId))) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: PILLAR_NOT_USED_ERROR,
      });
    }
    for (const p of input.pillars) {
      const refusal = existing
        ? await validateDependencyEdge(
            {
              fromType: "track",
              fromId: existing,
              toType: "workspace",
              toId: p.workspaceId,
              linkType: ADVANCES_LINK_TYPE,
            },
            ctx.userId
          )
        : await checkLinkEndpointVisible(
            "workspace",
            p.workspaceId,
            ctx.userId,
            null
          ).then((r) =>
            r
              ? { ok: false as const, httpStatus: r.status, error: r.error }
              : { ok: true as const }
          );
      if (!refusal.ok) refuse(refusal);
    }
  }
}

/** The refusal for a parent goal of another project. */
export const PARENT_OTHER_PROJECT_ERROR =
  "The parent goal must be a goal of the same project.";

/** Does goal `trackId` already have a PRIMARY `linkType` edge (THE reader)? */
async function hasPrimary(
  trackId: string,
  linkType: typeof SERVES_LINK_TYPE | typeof ADVANCES_LINK_TYPE
): Promise<boolean> {
  return (await readGoalPrimary(trackId, linkType)) !== null;
}

/**
 * Write a goal's placement through THE dependency door, the goal's own write
 * being ALREADY authorized (its gate passed, or its proposal was approved).
 * The pillar list replaces the goal's pillars; unlisted edges go first, then
 * non-primary ones, so a list that moves the primary demotes before it
 * promotes. THROWS (`BAD_REQUEST` / `NOT_FOUND`)
 * on the door's refusal — a start undoes the birth.
 */
export async function applyGoalPlacement(p: {
  trackId: string;
  input: GoalPlacementInput;
  userId: string;
  attribution?: LinkAttribution;
}): Promise<void> {
  const { trackId, input, userId, attribution } = p;
  const write = async (
    linkType: typeof SERVES_LINK_TYPE | typeof ADVANCES_LINK_TYPE,
    toType: "track" | "workspace",
    toId: string,
    primary: boolean | undefined
  ) => {
    const written = await writeDependencyLink({
      edge: { fromType: "track", fromId: trackId, toType, toId, linkType },
      userId,
      ...(primary !== undefined
        ? { metadata: { [LINK_PRIMARY_KEY]: primary } }
        : {}),
      ...(attribution ? { attribution } : {}),
    });
    if (!written.ok) {
      throw new TRPCError({
        code: written.httpStatus === 404 ? "NOT_FOUND" : "BAD_REQUEST",
        message: written.error,
      });
    }
  };

  if (input.parentGoalId) {
    const primary = !(await hasPrimary(trackId, SERVES_LINK_TYPE));
    await write(
      SERVES_LINK_TYPE,
      "track",
      input.parentGoalId,
      primary ? true : undefined
    );
  }

  if (input.pillars === undefined) return;
  // The WHOLE list, in the order that loses the least if a write fails
  // midway (the door writes on its own connection: no one transaction spans
  // these edges, a known race): (1) the listed non-primary edges, marked
  // `primary: false`, so a refusal there removes nothing; (2) the unlisted
  // edges are removed; (3) the one primary (the marked entry, else the
  // first), which by then meets no other primary.
  const pillars = input.pillars;
  const listed = new Set(pillars.map((x) => x.workspaceId));
  const named = pillars.findIndex((x) => x.primary === true);
  const primaryAt = named === -1 ? 0 : named;
  for (const [i, x] of pillars.entries()) {
    if (i === primaryAt) continue;
    await write(ADVANCES_LINK_TYPE, "workspace", x.workspaceId, false);
  }
  const existing = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.linkType, ADVANCES_LINK_TYPE),
        eq(links.fromType, "track"),
        eq(links.fromId, trackId),
        eq(links.toType, "workspace")
      )
    );
  for (const e of existing) {
    if (listed.has(e.toId)) continue;
    await deleteDependencyEdge({
      edge: {
        fromType: "track",
        fromId: trackId,
        toType: "workspace",
        toId: e.toId,
        linkType: ADVANCES_LINK_TYPE,
      },
      userId,
      ...(attribution ? { attribution } : {}),
    });
  }
  const primary = pillars[primaryAt];
  if (primary) {
    await write(ADVANCES_LINK_TYPE, "workspace", primary.workspaceId, true);
  }
}
