/**
 * The machines declared beside sessions, runs and proposals: each stored
 * status's category, and the moves the pod makes between them (each table is
 * read from the writers, like `PROPOSAL_TRANSITIONS`; `machine-writers` pins
 * each writer's move against them). A column's enum is typed
 * from these lists, so a status added there and not here stops the build.
 * Stored words are never renamed.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  statusesInCategories,
  type StatusOfCategory,
  type StatusTransitions,
} from "../lifecycle/category-sets.js";

export {
  canTransition,
  statusesThatMayBecome,
  type StatusTransitions,
} from "../lifecycle/category-sets.js";

// ── automation (`automations.status`) ─────────────────────────────────────

export const AUTOMATION_STATUSES = [
  "draft",
  "active",
  "paused",
  "error",
  "archived",
] as const;
export type AutomationStatusValue = (typeof AUTOMATION_STATUSES)[number];

/** `error` waits on the person to fix it (`activate` brings it back). */
export const AUTOMATION_STATUS_DECLARATION = {
  draft: { category: "open" },
  active: { category: "active" },
  paused: { category: "paused" },
  error: { category: "paused" },
  archived: { category: "lost" },
} as const satisfies Record<
  AutomationStatusValue,
  { category: LifecycleCategory }
>;

/**
 * An archived automation comes back only through `activate`: pausing or
 * editing it would revive a row whose name another one may now hold.
 */
export const AUTOMATION_TRANSITIONS = {
  draft: ["draft", "active", "paused", "error", "archived"],
  active: ["active", "draft", "paused", "error", "archived"],
  paused: ["paused", "draft", "active", "error", "archived"],
  error: ["error", "draft", "active", "paused", "archived"],
  archived: ["archived", "active"],
} as const satisfies StatusTransitions<AutomationStatusValue>;

/**
 * The status an automation is BORN with — the one decision every door that
 * writes a new automation reads (`insertAutomation`).
 *
 *   - A person approved this definition: it keeps the status it asked for,
 *     `active` when it asked none (an approval activates).
 *   - An agent wrote it and no person approved it: `draft` (activating an
 *     agent's automation is floored to a person, `automation/activate`).
 *   - Anyone else's own create keeps its status, `draft` when it asked none.
 */
export function automationStatusAtCreate(input: {
  requested: AutomationStatusValue | undefined;
  personApproved: boolean;
  actorIsAgent: boolean;
}): AutomationStatusValue {
  if (input.personApproved) return input.requested ?? "active";
  if (input.actorIsAgent) return "draft";
  return input.requested ?? "draft";
}

// ── automation run (`automation_runs.status`) ─────────────────────────────

export const AUTOMATION_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
  "blocked_by_policy",
  "waiting_on_you",
] as const;
export type AutomationRunStatusValue = (typeof AUTOMATION_RUN_STATUSES)[number];

/**
 * `skipped`: its precondition was false, nothing to do. `blocked_by_policy`:
 * nothing broke, it waits on a rule (the reading `units/state.ts` settles).
 */
export const AUTOMATION_RUN_STATUS_DECLARATION = {
  running: { category: "active" },
  waiting_on_you: { category: "paused" },
  blocked_by_policy: { category: "paused" },
  completed: { category: "done" },
  skipped: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<
  AutomationRunStatusValue,
  { category: LifecycleCategory }
>;

/** A settled parent whose child failed is re-settled `failed`. */
export const AUTOMATION_RUN_TRANSITIONS = {
  running: [
    "completed",
    "failed",
    "skipped",
    "blocked_by_policy",
    "waiting_on_you",
  ],
  waiting_on_you: [
    "running",
    "completed",
    "skipped",
    "failed",
    "blocked_by_policy",
  ],
  completed: ["failed"],
  blocked_by_policy: ["failed"],
  failed: [],
  cancelled: [],
  skipped: [],
} as const satisfies StatusTransitions<AutomationRunStatusValue>;

// ── stage run (`session_stage_runs.status`) ───────────────────────────────

/**
 * running        the step is being worked;
 * waiting_tools  its runner's computer lacks a tool it needs;
 * waiting_child  a child run works it (`uses`, or `forEach` batches);
 * waiting_start  starting its agent's provider task waits for the person;
 * unreached      the start or the send failed: never "running" over a
 *                delivery nothing received;
 * done / failed / cancelled  it ended.
 */
export const STAGE_RUN_STATUSES = [
  "running",
  "waiting_tools",
  "waiting_child",
  "waiting_start",
  "unreached",
  "done",
  "failed",
  "cancelled",
] as const;
export type StageRunStatusValue = (typeof STAGE_RUN_STATUSES)[number];

export const STAGE_RUN_STATUS_DECLARATION = {
  running: { category: "active" },
  waiting_tools: { category: "paused" },
  waiting_child: { category: "paused" },
  waiting_start: { category: "paused" },
  unreached: { category: "paused" },
  done: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<
  StageRunStatusValue,
  { category: LifecycleCategory }
>;

export const STAGE_RUN_TRANSITIONS = {
  running: [
    "waiting_start",
    "unreached",
    "waiting_child",
    "done",
    "failed",
    "cancelled",
  ],
  waiting_tools: ["running", "waiting_child", "done", "failed", "cancelled"],
  waiting_child: ["done", "failed", "cancelled"],
  waiting_start: ["running", "done", "failed", "cancelled"],
  unreached: ["running", "done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
} as const satisfies StatusTransitions<StageRunStatusValue>;

/** The statuses of a step that has not ended. */
export const OPEN_STAGE_RUN_STATUSES = statusesInCategories(
  STAGE_RUN_STATUS_DECLARATION,
  ["active", "paused"]
) as readonly StatusOfCategory<
  typeof STAGE_RUN_STATUS_DECLARATION,
  "active" | "paused"
>[];

// ── chat turn (`chat_turns.status`) ───────────────────────────────────────

export const CHAT_TURN_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ChatTurnStatusValue = (typeof CHAT_TURN_STATUSES)[number];

export const CHAT_TURN_STATUS_DECLARATION = {
  running: { category: "active" },
  completed: { category: "done" },
  failed: { category: "lost" },
  cancelled: { category: "lost" },
} as const satisfies Record<
  ChatTurnStatusValue,
  { category: LifecycleCategory }
>;

/** A failed turn is reopened when its request is retried. */
export const CHAT_TURN_TRANSITIONS = {
  running: ["completed", "failed", "cancelled"],
  failed: ["running"],
  completed: [],
  cancelled: [],
} as const satisfies StatusTransitions<ChatTurnStatusValue>;

// ── playbook (`playbooks.status`) ─────────────────────────────────────────

export const PLAYBOOK_STATUSES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type PlaybookStatusValue = (typeof PLAYBOOK_STATUSES)[number];

export const PLAYBOOK_STATUS_DECLARATION = {
  draft: { category: "open" },
  active: { category: "active" },
  paused: { category: "paused" },
  archived: { category: "lost" },
} as const satisfies Record<
  PlaybookStatusValue,
  { category: LifecycleCategory }
>;

/** The update door may move a playbook between any two statuses. */
export const PLAYBOOK_TRANSITIONS = {
  draft: ["draft", "active", "paused", "archived"],
  active: ["active", "draft", "paused", "archived"],
  paused: ["paused", "draft", "active", "archived"],
  archived: ["archived", "draft", "active", "paused"],
} as const satisfies StatusTransitions<PlaybookStatusValue>;

// ── installation (`installations.status`) ─────────────────────────────────

/** Stored lifecycle; health is read, never stored. */
export const INSTALLATION_STATUSES = [
  "planned",
  "installing",
  "installed",
  "updating",
  "removing",
  "removed",
  "failed",
] as const;
export type InstallationStatusValue = (typeof INSTALLATION_STATUSES)[number];

/** `installed` is the job delivered; `removed` no longer stands. */
export const INSTALLATION_STATUS_DECLARATION = {
  planned: { category: "open" },
  installing: { category: "active" },
  updating: { category: "active" },
  removing: { category: "active" },
  installed: { category: "done" },
  removed: { category: "lost" },
  failed: { category: "lost" },
} as const satisfies Record<
  InstallationStatusValue,
  { category: LifecycleCategory }
>;

/** A job's start, its finish, a passing verify, or a held job released. */
export const INSTALLATION_TRANSITIONS = {
  planned: ["installing", "removing"],
  installing: ["installed", "failed", "removing"],
  installed: ["installing", "updating", "removing"],
  updating: ["installed", "failed", "removing"],
  removing: ["removed", "failed"],
  failed: ["installing", "installed", "removing", "removed"],
  removed: [],
} as const satisfies StatusTransitions<InstallationStatusValue>;
