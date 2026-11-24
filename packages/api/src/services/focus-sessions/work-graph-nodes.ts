/**
 * What a work graph's sessions POINT AT, beside each other: the pull requests
 * they recorded, the holds they stand in, the goals they serve
 * (`work-graph.ts`). Kept out of the graph service on purpose: that file reads
 * SESSIONS only through the list's ONE WHERE and holds no query of its own
 * (`__tripwires__/work-graph-one-where.test.ts`). These reads are not session
 * reads; each goes through the door that already owns its rule:
 *
 *   - PRs: the packet's work-unit rule (`workUnitsSection`) and PR state read
 *     (`withPullRequestStates` → `foldPullRequestState`), once for every node;
 *   - holds: `listHolds`, the current hold of each paused session;
 *   - goals: `project_tracks` under its VisibilityRule (visible iff its project
 *     is), as `getTrack` / `listTracks` read it.
 *   - `serves` edges: `readServes`, the status read's own reader of the edge.
 *   - decisions and things (a pathway, B4): `entities` under its
 *     VisibilityRule; a decision's options and marks through
 *     `decisionRecordView`, the ONE adapter of a decision's ask record; whether
 *     the person is asked through `isOpenDecisionAsk`, the ask reactor's own
 *     test of a slot.
 *
 * Every function here THROWS on a failed read (or, for PRs, says
 * `unavailable`): the graph settles each one into its `sections` entry, so a
 * failure never reads as "none".
 */

import {
  and,
  db,
  drizzleSql,
  entities,
  eq,
  focusSessions,
  inArray,
  isLifecycleCategory,
  listHolds,
  or,
  projectTracks,
  type CurrentHold,
} from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import { parsePullRequestRef } from "@synap-core/types";
import {
  decisionAskSnapshot,
  decisionRecordView,
  type DecisionRecordOption,
} from "@synap-core/types/ask";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import type { LifecycleCategory } from "@synap-core/types/lifecycle";
import { deriveTrackStages, type TrackStage } from "@synap-core/types/units";
import { AccessContext, scopedDb } from "../../access/index.js";
import { pullRequestKey } from "../dev-loop/pr-state.js";
import {
  DECISION_PROFILE_SLUG,
  isOpenDecisionAsk,
} from "../decisions/decision-ask-reactor.js";
import { readServes } from "../status/status-read.js";
import {
  withPullRequestStates,
  workUnitsSection,
  type PacketPullRequestState,
  type PacketWorkUnitItem,
} from "./continuation-packet.js";

type Section = { status: "ok" } | { status: "unavailable"; reason: string };

/**
 * One pull request, once, however many nodes recorded it. `prState` is the
 * PR's own state, ABSENT when the pod recorded no fact about it (draw nothing,
 * never a guessed "Open"), `unavailable` when that read failed.
 */
export interface WorkGraphPullRequest {
  /** `owner/name#n`, the repo lower-cased (`pullRequestKey`). */
  id: string;
  url: string;
  /** The outcome's label, from the first node that recorded it. */
  label: string;
  /** Each node that recorded it, with that outcome's own state. */
  sessions: Array<{
    sessionId: string;
    key: string | null;
    state: PacketWorkUnitItem["state"];
  }>;
  prState?: PacketPullRequestState;
}

/** A node's standing hold (`listHolds`): the paused status it stands in and what it waits on. */
export interface WorkGraphHold {
  sessionId: string;
  status: string;
  hold: CurrentHold["hold"];
  /** `until.date` has come: the hourly sweep resumes it. */
  resumeDue: boolean;
  /** `reviewBy` has passed. */
  reviewDue: boolean;
}

/**
 * One stage of a goal's method, as `deriveTrackStages` places it against the
 * goal's `currentStage` — the rule every track surface uses. Only what a map
 * draws: the stage's brief, tasks, outputs and criteria stay on the goal's
 * own read (`getTrack`).
 */
export type WorkGraphGoalStage = Pick<
  TrackStage,
  "key" | "name" | "category" | "position"
>;

/** A goal (track) a node is filed into, as the track floor lets the caller see it. */
export interface WorkGraphGoal {
  id: string;
  name: string;
  status: string;
  projectId: string;
  /** The goal's METHOD (`project_tracks.playbook_id`); `null` = it follows none. */
  playbookId: string | null;
  /** The stage key the goal is at; `null` = stageless, or not started. */
  currentStage: string | null;
  /** The method's stages in order, each placed against `currentStage`; `[]` = stageless. */
  stages: WorkGraphGoalStage[];
}

/**
 * Every PR the nodes recorded, ONE state read for all of them: each node's
 * work units (`workUnitsSection`, the packet's rule), joined into one list for
 * `withPullRequestStates`, then grouped by PR. A failed state read marks every
 * PR `unavailable` (the PRs stay listed: they are the nodes' own outcomes).
 */
export async function readGraphPullRequests(
  nodes: ReadonlyArray<Pick<FocusSession, "id" | "expectedOutputs">>,
  reader: { userId: string; roster: boolean; lens?: string },
  /**
   * Set when the caller may not read the recorded PR facts (a key narrowed
   * by its grant, `workGraphReach`): the PRs the nodes recorded are listed
   * with no `prState`, and the section says why, never "no fact recorded".
   */
  statesWithheld?: string
): Promise<{ items: WorkGraphPullRequest[]; section: Section }> {
  const owners: string[] = [];
  const units: PacketWorkUnitItem[] = [];
  for (const n of nodes) {
    const slots = Array.isArray(n.expectedOutputs)
      ? (n.expectedOutputs as ExpectedOutput[]).filter(
          (s) => !!s && typeof s === "object"
        )
      : [];
    const section = workUnitsSection(slots, { uncapped: true });
    if (section.status !== "ok") continue;
    for (const item of section.items) {
      owners.push(n.id);
      units.push(item);
    }
  }
  const read = statesWithheld
    ? null
    : await withPullRequestStates(
        { status: "ok", total: units.length, items: units },
        reader
      );
  const items = read?.status === "ok" ? read.items : units;
  const byKey = new Map<string, WorkGraphPullRequest>();
  let unavailable: string | null = null;
  for (const [i, item] of items.entries()) {
    const ref = item.url ? parsePullRequestRef(item.url) : null;
    if (!ref || !item.url) continue;
    const id = pullRequestKey(ref);
    const pr = byKey.get(id) ?? {
      id,
      url: item.url,
      label: item.label,
      sessions: [],
      ...(item.prState ? { prState: item.prState } : {}),
    };
    pr.sessions.push({
      sessionId: owners[i]!,
      key: item.key,
      state: item.state,
    });
    byKey.set(id, pr);
    if (item.prState?.status === "unavailable")
      unavailable = item.prState.reason;
  }
  return {
    items: [...byKey.values()],
    section: statesWithheld
      ? { status: "unavailable", reason: statesWithheld }
      : unavailable === null
        ? { status: "ok" }
        : { status: "unavailable", reason: unavailable },
  };
}

/** The standing hold of each of these sessions that is paused with one. */
export async function readGraphHolds(
  sessionIds: readonly string[]
): Promise<WorkGraphHold[]> {
  const holds = await listHolds(db, {
    subjects: sessionIds.map((subjectId) => ({
      subjectType: "focus_session" as const,
      subjectId,
    })),
  });
  return holds.map((h) => ({
    sessionId: h.subjectId,
    status: h.status,
    hold: h.hold,
    resumeDue: h.resumeDue,
    reviewDue: h.reviewDue,
  }));
}

/** These goals, as far as the track floor lets `userId` see them. */
export async function readGraphGoals(
  trackIds: readonly string[],
  userId: string
): Promise<WorkGraphGoal[]> {
  if (trackIds.length === 0) return [];
  const rows = await db
    .select({
      id: projectTracks.id,
      name: projectTracks.name,
      status: projectTracks.status,
      projectId: projectTracks.projectId,
      playbookId: projectTracks.playbookId,
      currentStage: projectTracks.currentStage,
      definitionSnapshot: projectTracks.definitionSnapshot,
    })
    .from(projectTracks)
    .where(
      and(
        inArray(projectTracks.id, [...trackIds]),
        scopedDb(AccessContext.from({ userId })).predicate(projectTracks)
      )
    );
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    projectId: t.projectId,
    playbookId: t.playbookId,
    currentStage: t.currentStage,
    stages: deriveTrackStages(
      (t.definitionSnapshot as { stages?: unknown } | null)?.stages,
      t.currentStage
    ).map((st) => ({
      key: st.key,
      name: st.name,
      category: st.category,
      position: st.position,
    })),
  }));
}

/**
 * A `decision` entity a node waits on (`blocked_by`) or is about (its
 * subject): the choice a pathway branches on (B4). Its options and marks are
 * `decisionRecordView`'s, never re-derived here.
 */
export interface WorkGraphDecision {
  id: string;
  title: string | null;
  /** Its status (`proposed | accepted | superseded | rejected`); `null` = unset. */
  status: string | null;
  /** The status's fixed category (`open`, `done`, `lost`…); `null` = no lifecycle. */
  category: LifecycleCategory | null;
  /** Each option with its `recommended` / `chosen` mark; `[]` = a yes/no decision. */
  options: DecisionRecordOption[];
  /** The recommended option's key; `null` = nothing recommended. */
  recommendedOption: string | null;
  /** The chosen option's key; `null` = none chosen yet. */
  chosenOption: string | null;
  /**
   * The person's answer: `answered` = an option is chosen or the decision is
   * no longer open; `asked` = an owed question in one of the reader's open
   * sessions asks it (`askSessionId`); `not_asked` = still open and nothing
   * asks the person (a person's own open decision is their note).
   */
  answer: "answered" | "asked" | "not_asked";
  /** With `asked`: the reader's open session whose owed question asks it. */
  askSessionId: string | null;
  /** The session the decision came from, when stamped. */
  sourceSessionId: string | null;
}

/**
 * A thing a node is ABOUT (its subject) or waits on that is not a decision:
 * enough to draw it and open it.
 */
export interface WorkGraphEntity {
  id: string;
  title: string | null;
  /** Its kind (profile slug). */
  kind: string;
  /** Its status (the kind's lifecycle column, else its `status` field); `null` = none. */
  status: string | null;
  /** The status's fixed category; `null` = no lifecycle. */
  category: LifecycleCategory | null;
}

/**
 * These entities, as far as the entity floor lets `userId` see them (a
 * workspace-bound key: in its workspace only), split into decisions and other
 * things. A decision still open is checked against the reader's open
 * sessions: is an owed question asking the person (ONE read for all of them)?
 */
export async function readGraphThings(
  entityIds: readonly string[],
  reader: { userId: string; lens?: string }
): Promise<{ decisions: WorkGraphDecision[]; entities: WorkGraphEntity[] }> {
  if (entityIds.length === 0) return { decisions: [], entities: [] };
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      status: entities.status,
      statusCategory: entities.statusCategory,
      properties: entities.properties,
    })
    .from(entities)
    .where(
      and(
        inArray(entities.id, [...entityIds]),
        drizzleSql`${entities.deletedAt} IS NULL`,
        ...(reader.lens ? [eq(entities.workspaceId, reader.lens)] : []),
        scopedDb(AccessContext.from({ userId: reader.userId })).predicate(
          entities
        )
      )
    );
  const things: WorkGraphEntity[] = [];
  const open: Array<WorkGraphDecision> = [];
  const decisions: WorkGraphDecision[] = [];
  for (const r of rows) {
    const props =
      r.properties && typeof r.properties === "object"
        ? (r.properties as Record<string, unknown>)
        : {};
    const category = isLifecycleCategory(r.statusCategory)
      ? r.statusCategory
      : null;
    if (r.type !== DECISION_PROFILE_SLUG) {
      things.push({
        id: r.id,
        title: r.title ?? null,
        kind: r.type,
        status:
          r.status ?? (typeof props.status === "string" ? props.status : null),
        category,
      });
      continue;
    }
    const view = decisionRecordView(props);
    const snap = decisionAskSnapshot(props);
    const status = r.status ?? view.status;
    const decided =
      !!snap.chosenKey ||
      (category ? category !== "open" : !!status && status !== "proposed");
    const d: WorkGraphDecision = {
      id: r.id,
      title: r.title ?? null,
      status,
      category,
      options: view.options,
      recommendedOption: snap.recommendedKey ?? null,
      chosenOption: snap.chosenKey ?? null,
      answer: decided ? "answered" : "not_asked",
      askSessionId: null,
      sourceSessionId: view.sourceSessionId,
    };
    decisions.push(d);
    if (!decided) open.push(d);
  }
  if (open.length > 0) {
    const asking = await db
      .select({
        id: focusSessions.id,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, reader.userId),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
          or(
            ...open.map(
              (d) =>
                drizzleSql`${focusSessions.expectedOutputs} @> ${JSON.stringify(
                  [{ decisionId: d.id }]
                )}::jsonb`
            )
          )
        )
      );
    for (const d of open) {
      const home = asking.find(
        (s) =>
          Array.isArray(s.expectedOutputs) &&
          (s.expectedOutputs as ExpectedOutput[]).some((o) =>
            isOpenDecisionAsk(o, d.id)
          )
      );
      if (home) {
        d.answer = "asked";
        d.askSessionId = home.id;
      }
    }
  }
  return { decisions, entities: things };
}

/** One `serves` edge: the session or goal `from` is done for goal `to`. */
export interface WorkGraphServes {
  from: string;
  fromKind: "session" | "track";
  /** The goal served. */
  to: string;
  /** The goal criterion it serves, when the edge names one. */
  criterionKey?: string;
}

/**
 * The goals these sessions and goals SERVE (`X --serves--> goal`), each goal
 * end the reader may see, through `readServes` (the status read's reader).
 */
export async function readGraphServes(
  sessionIds: readonly string[],
  trackIds: readonly string[],
  userId: string
): Promise<WorkGraphServes[]> {
  if (sessionIds.length + trackIds.length === 0) return [];
  const read = await readServes(userId, [...sessionIds, ...trackIds]);
  const out: WorkGraphServes[] = [];
  const from = (ids: readonly string[], fromKind: "session" | "track") => {
    for (const id of ids) {
      for (const end of read.get(id)?.serves ?? []) {
        if (end.type !== "goal") continue;
        out.push({
          from: id,
          fromKind,
          to: end.id,
          ...(end.criterionKey ? { criterionKey: end.criterionKey } : {}),
        });
      }
    }
  };
  from(sessionIds, "session");
  from(trackIds, "track");
  return out;
}
