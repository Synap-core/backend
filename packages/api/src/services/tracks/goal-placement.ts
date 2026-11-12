/**
 * WHERE A GOAL SITS — its parent goal and the pillars it advances (goals /
 * pillars / health contract, 2026-11-12, C4). One input shape for every door
 * that starts or updates a goal: tRPC `tracks.start` / `tracks.setDirection`,
 * Hub `POST /tracks` / `PATCH /tracks/:id/direction`, MCP `synap_start_track`
 * / `synap_update_track`, and the `track/create` / `track/update` replays.
 *
 *   parentGoalId  → `goal --serves--> parent`. PRIMARY (`metadata.primary`)
 *                   when the goal has no primary parent yet, else a second,
 *                   non-primary parent (a goal rolls up fully to its primary
 *                   parent only).
 *   pillars       → `goal --advances--> space`, one per entry. Every space must
 *                   be one the goal's project `uses`. At most one `primary`;
 *                   when the list names none and the goal has no primary
 *                   pillar yet, the FIRST entry becomes primary (the same rule
 *                   as the parent). An existing edge re-linked with an explicit
 *                   `primary` changes only that mark.
 *
 * The links are part of the goal write, like `replacesTrackId`: they ride the
 * goal's own gate payload (an agent's start or update is ONE proposal, the
 * person sees the parent and the pillars in it), and are written AFTER that
 * write is authorized, through THE dependency door's ungoverned write
 * (`writeDependencyLink`: endpoint floor, cycle, project-uses and one-primary
 * checks, the one store write, `link.create.completed`). Malformed input is
 * refused BEFORE governance ({@link checkGoalPlacement}), so a person is never
 * asked to approve what cannot apply.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, db, eq, links, projectTracks } from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  ADVANCES_LINK_TYPE,
  LINK_PRIMARY_KEY,
  SERVES_LINK_TYPE,
  isPrimaryLinkMetadata,
} from "@synap-core/types/connections";
import { AccessContext, scopedDb } from "../../access/index.js";
import { listWorkspacesUsedByProject } from "../../utils/project-workspace.js";
import {
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
 * The checks a placement gets BEFORE the goal's gate, so a proposal is never
 * filed for what could not apply: the parent goal is visible to the caller
 * and is not the goal itself; every pillar is a space the project uses. The
 * door re-checks everything at the write (a proposal can sit for days).
 */
export async function checkGoalPlacement(
  input: GoalPlacementInput,
  ctx: { projectId: string; userId: string; trackId?: string }
): Promise<void> {
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
  }
}

/** Does goal `trackId` already have a PRIMARY edge of `linkType`? */
async function hasPrimary(
  trackId: string,
  linkType: typeof SERVES_LINK_TYPE | typeof ADVANCES_LINK_TYPE
): Promise<boolean> {
  const rows = await db
    .select({ metadata: links.metadata })
    .from(links)
    .where(
      and(
        eq(links.linkType, linkType),
        eq(links.fromType, "track"),
        eq(links.fromId, trackId)
      )
    );
  return rows.some((r) => isPrimaryLinkMetadata(r.metadata));
}

/**
 * Write a goal's placement through THE dependency door, the goal's own write
 * being ALREADY authorized (its gate passed, or its proposal was approved).
 * Non-primary pillars first, so a list that moves the primary from one space
 * to another demotes before it promotes. THROWS (`BAD_REQUEST` / `NOT_FOUND`)
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

  const pillars = input.pillars ?? [];
  if (pillars.length === 0) return;
  const named = pillars.some((x) => x.primary === true);
  const firstIsPrimary =
    !named && !(await hasPrimary(trackId, ADVANCES_LINK_TYPE));
  const plan = pillars.map((x, i) => ({
    workspaceId: x.workspaceId,
    primary: firstIsPrimary && i === 0 ? true : x.primary,
  }));
  for (const x of [
    ...plan.filter((x) => x.primary !== true),
    ...plan.filter((x) => x.primary === true),
  ]) {
    await write(ADVANCES_LINK_TYPE, "workspace", x.workspaceId, x.primary);
  }
}
