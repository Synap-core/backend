/**
 * "MAKE IT A GOAL" — the door (work model D2 part 2, W5b, 2026-10-23).
 *
 * A pod with Life OS `goal`, Enterprise `objective` or Project Management
 * `okr` entities offers each one a one-tap conversion into a goal (a track).
 * ONE service, reached by tRPC `tracks.convertFromEntity`, Hub REST
 * `POST /tracks/convert` and MCP `synap_convert_to_goal`. It reads the entity,
 * maps its fields ({@link goalFromEntity}) and goes through THE start door
 * (`startTrack` with `fromEntity`) — no second write path: governance (an
 * agent's conversion is a proposal), the approval replay, the owner seat, the
 * `entity --promoted_to--> track` link and an ended entity's close all ride
 * the start (`goal-source-entity.ts`).
 *
 * The field map (catalog lane note, D2 part 2):
 *   title                         → name
 *   description / outcome / okr-notes → end state
 *   target-date / targetDate      → appended to the end state: "— by <date>"
 *   kr1..3 (label/target/current/unit) → criteria, check kind `measured`
 *                                   ("Qualified leads: target 40 per month"; the
 *                                   current value in the check's hint). ONE key
 *                                   result → a lasting goal with it in the end
 *                                   state (a goal has no criteria or 2–5).
 *   status achieved / Completed   → born closed, verdict `met` (its key results
 *                                   then ride the end state: `met` needs every
 *                                   criterion met, and nobody judged them)
 *   status abandoned / Cancelled  → born dropped, verdict `no_longer_needed`
 *   the entity's owner            → the goal's owner
 * Every other field that holds a value (progress, area, horizon, quarter,
 * confidence…) is NOT carried, and the result names it (`notCarried`).
 *
 * The entity is kept as it is — never changed, never deleted.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray, getDb, projects, relations } from "@synap/database";
import type { GoalConvertibleKind } from "@synap-core/types/units";
import { AccessContext, scopedDb } from "../../access/index.js";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import { TRACK_END_STATE_MAX } from "./goal-content.js";
import {
  loadConvertibleEntity,
  type GoalSourceEntity,
  type TrackFromEntityEnding,
} from "./goal-source-entity.js";
import {
  startTrack,
  type StartTrackResult,
  type TrackActor,
} from "./tracks-service.js";

/** What every door accepts. */
export const convertToGoalInputSchema = z
  .object({
    /** The goal / objective / okr entity. */
    entityId: z.string().uuid(),
    /** The project the goal lives in — required when the entity is filed in none or several. */
    projectId: z.string().uuid().optional(),
    /** A name other than the entity's title. */
    name: z.string().trim().min(1).max(200).optional(),
    reasoning: z.string().max(2000).optional(),
  })
  .strict();
export type ConvertToGoalInput = z.infer<typeof convertToGoalInputSchema>;

/** Where each kind keeps what the goal needs (the catalog's property slugs). */
const FIELDS: Record<
  GoalConvertibleKind,
  { endState: string; targetDate: string | null; status: string }
> = {
  goal: {
    endState: "description",
    targetDate: "target-date",
    status: "status",
  },
  objective: {
    endState: "outcome",
    targetDate: "targetDate",
    status: "status",
  },
  okr: { endState: "okr-notes", targetDate: null, status: "okr-status" },
};
const KEY_RESULT_SLOTS = [1, 2, 3] as const;
const DONE_VALUES = new Set(["achieved", "completed"]);
const LOST_VALUES = new Set(["abandoned", "cancelled"]);

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** A stored date as its day (`2026-12-31`), else as written. */
function day(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * How the entity had ended, if it had: its lifecycle category when it has one
 * (`entities.status_category`), else its status value.
 */
export function endingOf(
  entity: Pick<GoalSourceEntity, "kind" | "properties" | "statusCategory">
): TrackFromEntityEnding | null {
  const kind = entity.kind as GoalConvertibleKind;
  const value = text(entity.properties[FIELDS[kind].status])?.toLowerCase();
  if (entity.statusCategory === "done" || (value && DONE_VALUES.has(value))) {
    return { status: "completed", verdict: "met" };
  }
  if (entity.statusCategory === "lost" || (value && LOST_VALUES.has(value))) {
    return { status: "archived", verdict: "no_longer_needed" };
  }
  return null;
}

export interface GoalFromEntity {
  name: string | null;
  endState: string | null;
  criteria: Array<{
    key: string;
    statement: string;
    checkKind: "measured";
    check: { kind: "evidence"; evidenceKey: string; hint?: string };
  }>;
  /** Property slugs that held a value the goal does not carry. */
  notCarried: string[];
}

/** THE field map — pure. `ended` decides where key results go. */
export function goalFromEntity(
  entity: Pick<GoalSourceEntity, "kind" | "title" | "properties">,
  ended: TrackFromEntityEnding | null
): GoalFromEntity {
  const kind = entity.kind as GoalConvertibleKind;
  const props = entity.properties;
  const fields = FIELDS[kind];
  const carried = new Set<string>(["title", fields.endState, fields.status]);
  if (fields.targetDate) carried.add(fields.targetDate);

  const keyResults =
    kind === "okr"
      ? KEY_RESULT_SLOTS.flatMap((i) => {
          const slot = (f: string) => `kr${i}-${f}`;
          const label = text(props[slot("label")]);
          if (!label) return [];
          for (const f of ["label", "target", "current", "unit"]) {
            carried.add(slot(f));
          }
          const target = text(props[slot("target")]);
          const current = text(props[slot("current")]);
          const unit = text(props[slot("unit")]);
          // "40 per month", "45%" — a unit that is a word takes a space.
          const amount = (n: string) =>
            unit ? (/^[a-z]/i.test(unit) ? `${n} ${unit}` : `${n}${unit}`) : n;
          return [
            {
              key: `kr${i}`,
              statement: clip(
                target ? `${label}: target ${amount(target)}` : label,
                500
              ),
              current: current
                ? `Was ${amount(current)} when it became a goal`
                : null,
            },
          ];
        })
      : [];
  // A goal holds no criteria or 2–5; an achieved one is closed as met, which
  // needs every criterion met — so one key result, or an achieved entity's,
  // ride the end state.
  const asCriteria = keyResults.length >= 2 && ended?.status !== "completed";

  const body = text(props[fields.endState]);
  const by = fields.targetDate ? day(props[fields.targetDate]) : null;
  const lines = [
    by ? (body ? `${body} — by ${by}` : `By ${by}`) : body,
    !asCriteria && keyResults.length > 0
      ? [
          keyResults.length === 1 ? "Key result:" : "Key results:",
          ...keyResults.map((k) => `- ${k.statement}`),
        ].join("\n")
      : null,
  ].filter((l): l is string => Boolean(l));

  return {
    name: text(entity.title) ?? text(props.title),
    endState:
      lines.length > 0 ? clip(lines.join("\n"), TRACK_END_STATE_MAX) : null,
    criteria: asCriteria
      ? keyResults.map((k) => ({
          key: k.key,
          statement: k.statement,
          checkKind: "measured" as const,
          check: {
            kind: "evidence" as const,
            evidenceKey: k.key,
            ...(k.current ? { hint: k.current } : {}),
          },
        }))
      : [],
    notCarried: Object.entries(props)
      .filter(([k, v]) => !carried.has(k) && text(v) !== null)
      .map(([k]) => k)
      .sort(),
  };
}

/**
 * The project the goal lives in: the one asked for, else the ONE project the
 * entity is filed in (`belongs_to_project`) among those the caller can see.
 * None or several → a refusal that asks to pick one.
 */
async function projectFor(
  entity: Pick<GoalSourceEntity, "id" | "title">,
  projectId: string | undefined,
  actor: TrackActor
): Promise<string> {
  if (projectId) return projectId;
  const db = await getDb();
  const filed = await db
    .select({ id: relations.targetEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(relations.sourceEntityId, entity.id)
      )
    );
  const ids = [...new Set(filed.flatMap((r) => (r.id ? [r.id] : [])))];
  const visible =
    ids.length === 0
      ? []
      : await scopedDb(AccessContext.from(actor)).findMany<{
          id: string;
          name: string;
        }>(projects, {
          where: inArray(projects.id, ids),
          columns: { id: true, name: true },
        });
  const title = entity.title ?? "This entity";
  if (visible.length === 1) return visible[0]!.id;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      visible.length === 0
        ? `"${title}" is filed in no project — a goal lives in one. Pick the project (projectId), or file it into one first.`
        : `"${title}" is filed in several projects (${visible
            .map((p) => `"${p.name}" ${p.id}`)
            .join(", ")}) — pick the one its goal lives in (projectId).`,
  });
}

export type ConvertToGoalResult = StartTrackResult & {
  /** The entity it was made from — kept as it is. */
  entityId: string;
  /** Property slugs that held a value the goal does not carry. */
  notCarried: string[];
};

/**
 * Make a goal / objective / okr entity a goal — once. Refuses another kind
 * (BAD_REQUEST), an entity already made a goal (CONFLICT), an entity filed in
 * no or several projects without `projectId` (BAD_REQUEST), and a name a live
 * goal on the project already holds (CONFLICT). An agent's conversion is a
 * proposal (`status: "proposed"` — success).
 */
export async function convertEntityToGoal(input: {
  entityId: string;
  projectId?: string;
  name?: string;
  actor: TrackActor;
}): Promise<ConvertToGoalResult> {
  const entity = await loadConvertibleEntity(input.entityId, input.actor);
  const projectId = await projectFor(entity, input.projectId, input.actor);
  const ended = endingOf(entity);
  const goal = goalFromEntity(entity, ended);
  const name = input.name?.trim() || goal.name;
  if (!name) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This entity has no title — name its goal (name).",
    });
  }
  const result = await startTrack({
    projectId,
    name: clip(name, 200),
    ...(goal.endState ? { endState: goal.endState } : {}),
    ...(goal.criteria.length > 0 ? { criteria: goal.criteria } : {}),
    fromEntity: {
      entityId: entity.id,
      kind: entity.kind,
      title: entity.title ?? name,
      ended,
    },
    actor: input.actor,
  });
  return { ...result, entityId: entity.id, notCarried: goal.notCarried };
}
