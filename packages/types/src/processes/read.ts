/**
 * THE process read contract — what the pod's ONE process read
 * (`services/playbooks/process-read.ts`: `readProcess(playbookId)`,
 * `listProcesses({ workspaceId? })`) returns, behind tRPC
 * (`playbooks.process` / `playbooks.processes`), Hub REST
 * (`GET /playbooks/:id/process`, `GET /processes`) and MCP
 * (`synap_list_playbooks({ playbookId })` → `process`). Process wave plan
 * 0adf8352 (founder-approved 16 Nov 2026), W2.
 *
 * A Process is a playbook seen whole: no `processes` table. Every field here
 * is COMPOSED from an existing read, and none is derived here:
 *   - definition: the playbook row (`playbooks`), `preApprovedVersion` from
 *     the person's run choice, `installedFrom` from `metadata.marketSource`,
 *     `updateAvailable` from the installed-package standing;
 *   - when: `playbook_automations` (the ONE playbook → automation link, 0425)
 *     and the enabled workers (`listEnabledWorkers`);
 *   - steps / checks: the playbook's `stages` and `criteria`;
 *   - moves: `flow.of` on the subject kind (its lifecycle, the stage owning
 *     each state);
 *   - needs: the playbook's `tools` and `requires` entries, with coverage from
 *     the capability registry (`foldIntentCoverage`, the run's own resolver);
 *   - skills: `readPlaybookSkills` (guidance refs, grants, context skill);
 *   - runs: the session list (`flow: { playbookId }`) and the run ledger;
 *   - health: `deriveProcessHealth` (this leaf, moved from the browser).
 *
 * UNMEASURED IS NOT EMPTY. A count the pod could not read is `null`, a need
 * whose coverage it could not measure is `unknown`, and a block whose read
 * failed is named in `unavailable` (never an empty list).
 */
import type { ProcessHealth } from "./health.js";
import type { ProcessStepRunnerKind } from "./steps.js";

// ── Needs ────────────────────────────────────────────────────────────────────

/**
 * What a need names. `intent`: a `capability_intents` slug (any verb serving
 * it fills it). `capability`: a capability (by name or id) or a verb id from
 * `tools`, or a capability key from `requires` (what the runner's computer
 * must have). Plan W3 (L3) adds `need`: a named group of intents a space fills
 * once.
 */
export const PROCESS_NEED_KINDS = ["intent", "capability"] as const;
export type ProcessNeedKind = (typeof PROCESS_NEED_KINDS)[number];

/**
 * `filled`: something visible under the process's lens serves it. `empty`:
 * the registry was read and nothing serves it (a fact to act on: install a
 * provider). `unknown`: not measured — the registry read failed, or the need
 * is checked elsewhere (a `requires` key is checked against the runner's
 * computer when a step is handed over, never at the space).
 */
export const PROCESS_NEED_STATES = ["filled", "empty", "unknown"] as const;
export type ProcessNeedState = (typeof PROCESS_NEED_STATES)[number];

/** Where a need is declared on the playbook. */
export const PROCESS_NEED_SOURCES = ["tools", "requires"] as const;
export type ProcessNeedSource = (typeof PROCESS_NEED_SOURCES)[number];

export interface ProcessNeedProvider {
  /** The serving capability (container) id, when the registry names one. */
  capabilityId: string | null;
  /** Its name (a person's word comes from the vocabulary door, never here). */
  capabilityName: string | null;
  /** The serving verb id. */
  verbId: string | null;
}

export interface ProcessNeed {
  /** The entry as declared (an intent slug, a capability name/id, a verb id, a capability key). */
  slug: string;
  kind: ProcessNeedKind;
  source: ProcessNeedSource;
  state: ProcessNeedState;
  /** Who fills it; `[]` exactly when `state` is not `filled`. */
  providers: ProcessNeedProvider[];
  /** The step keys that declare it (a step narrows its playbook's list); `[]` = the playbook itself. */
  steps: string[];
}

// ── When (what starts and moves it) ──────────────────────────────────────────

/**
 * The role an automation plays in a process (`playbook_automations.role`).
 * `schedule`: the backing cron automation of `playbooks.schedule`.
 * `flow`: the automation the playbook canvas saved (`playbooks.saveFlow`).
 * `activator`: a declared activator compiled to a rule (workers).
 * `member`: composed by hand or by the legacy `member_of` link.
 * Any other stored role reads as itself (the column is free text).
 */
export const PROCESS_AUTOMATION_ROLES = [
  "schedule",
  "flow",
  "activator",
  "member",
] as const;
export type ProcessAutomationRole =
  (typeof PROCESS_AUTOMATION_ROLES)[number] | (string & {});

export interface ProcessAutomation {
  id: string;
  name: string;
  role: ProcessAutomationRole;
  /** event | cron | webhook | manual. */
  triggerType: string;
  /** draft | active | paused | archived | error. */
  status: string;
  sortOrder: number | null;
  /** The automation's next scheduled fire (cron), ISO; null when none. */
  nextRunAt: string | null;
}

export interface ProcessWorker {
  ruleId: string;
  activatorKey: string;
  mode: "run" | "propose";
  scope: string;
  state: "running" | "paused";
  automationId: string | null;
  projectId: string | null;
  trackId: string | null;
}

// ── Steps, checks, moves ─────────────────────────────────────────────────────

export interface ProcessStep {
  key: string;
  name: string;
  goal: string | null;
  /** The stage category (`resolveStageCategory`). */
  category: string;
  /** Who works it, as declared (`PlaybookRunner` | null = the playbook's). */
  runner: unknown | null;
  /** Who moves it on, for its mark (`classifyStepRunner`, the one classifier). */
  runnerKind: ProcessStepRunnerKind;
  /** The step's `tools` (narrows the playbook's list); `[]` = the playbook's. */
  tools: string[];
  /** The step's own `requires` (capability keys). */
  requires: string[];
  /** human | check | awaits | null. */
  gate: string | null;
  /** The subject status this step moves the subject to, if any. */
  subjectStatus: string | null;
}

export interface ProcessCriterion {
  key: string;
  statement: string;
  /** evidence | capability | judge | human. */
  checkKind: string | null;
  /** The step that declares it; null = the playbook's own. */
  stepKey: string | null;
}

export interface ProcessGate {
  stepKey: string;
  /** human | check | awaits. */
  kind: string;
}

export interface ProcessMoveState {
  key: string;
  label: string;
  category: string;
  /** The steps of THIS process that own the state (move a thing into it). */
  ownedBy: string[];
}

export interface ProcessMoves {
  /** The kind or role the process works on. */
  profileSlug: string;
  /** The kind's declared lifecycle, in order. */
  states: ProcessMoveState[];
  /** Statuses a step names that the lifecycle does not declare. */
  undeclaredStatuses: string[];
}

// ── Skills ───────────────────────────────────────────────────────────────────

/**
 * Where a skill of a process is declared. `guidance`: a `skill:<slug>` ref in
 * the playbook's rules (0411). `grant`: a `playbook --grants--> skill` link
 * (or a granted capability's member). `context`: the "how to run this
 * playbook" instruction skill (`documents` edge). `goal`: named in the goal
 * text (the run preflight still matches it; see `readPlaybookSkills`).
 */
export const PROCESS_SKILL_SOURCES = [
  "guidance",
  "grant",
  "context",
  "goal",
] as const;
export type ProcessSkillSource = (typeof PROCESS_SKILL_SOURCES)[number];

export interface ProcessSkill {
  /** null when a guidance ref names a slug no visible skill carries. */
  id: string | null;
  slug: string | null;
  name: string;
  source: ProcessSkillSource;
  /** A person approved it (an unapproved skill never reaches a prompt / is off). */
  approved: boolean | null;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/**
 * Run counts, each EXACT or `null` (not measured, never 0).
 * open: open sessions running this process (session list `flow: {playbookId}`).
 * needsYou: of those, the ones holding an ask the person must answer (THE
 *   needs-you owed predicate, `asksYouSessionIds`).
 * doneThisWeek: sessions of it closed in the last 7 days.
 * failedThisWeek: runs that failed in the last 7 days (run ledger).
 * total: every run of it (run ledger).
 */
export interface ProcessRunCounts {
  open: number | null;
  needsYou: number | null;
  doneThisWeek: number | null;
  failedThisWeek: number | null;
  total: number | null;
}

export interface ProcessRunRow {
  sessionId: string;
  title: string | null;
  status: string;
  currentStage: string | null;
  updatedAt: string;
}

// ── The definition ───────────────────────────────────────────────────────────

export interface ProcessInstalledFrom {
  packageSlug: string;
  packageVersion: string | null;
  installedAt: string | null;
}

export interface ProcessDefinition {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
  /** draft | active | paused | archived. */
  status: string;
  version: number;
  /** is-agent | external-agent | hybrid | generate. */
  executor: string;
  /** Who runs it by default (`PlaybookRunner`), null = nobody named. */
  runner: unknown | null;
  /** session | project. */
  scope: string;
  subjectProfileSlug: string | null;
  /**
   * The version the person pre-approved agents to run without asking; null =
   * none, or unread (then `unavailable` names `preApproval`).
   */
  preApprovedVersion: number | null;
  installedFrom: ProcessInstalledFrom | null;
  /** true / false when compared with the catalog; null when not compared. */
  updateAvailable: boolean | null;
}

// ── The two shapes ───────────────────────────────────────────────────────────

/** The blocks of a ProcessRead whose read can fail on its own. */
export const PROCESS_READ_PARTS = [
  "when",
  "needs",
  "skills",
  "moves",
  "runs",
  "health",
  "updateAvailable",
  "preApproval",
] as const;
export type ProcessReadPart = (typeof PROCESS_READ_PARTS)[number];

/** One card of a space's processes. */
export interface ProcessSummary {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string | null;
  status: string;
  health: ProcessHealth;
  counts: ProcessRunCounts;
  stepCount: number;
  /** Its automations; null when the `when` read failed (never a 0 for unmeasured). */
  automationCount: number | null;
  needs: ProcessNeedSummary[];
  /** Parts that could not be read (their fields are null / unknown). */
  unavailable: ProcessReadPart[];
}

/**
 * An automation that belongs to no live process (no `playbook_automations`
 * row to a playbook that is not archived): the "Automations outside a
 * process" list. The read decides membership once,
 * so no surface re-derives it.
 */
export interface ProcessOutsideAutomation {
  id: string;
  name: string;
  /** event | cron | webhook | manual. */
  triggerType: string;
  /** draft | active | paused | error (archived ones are left out). */
  status: string;
  workspaceId: string | null;
}

/**
 * The index of a space's processes (`listProcesses`, `playbooks.processes`,
 * Hub REST `GET /processes`): the cards, plus the automations outside any
 * process. `automationsOutsideProcess` is `null` when that read failed (then
 * `unavailable` names `"when"`); an empty list means there are none.
 */
export interface ProcessIndex {
  processes: ProcessSummary[];
  automationsOutsideProcess: ProcessOutsideAutomation[] | null;
  /** Index-level parts that could not be read. */
  unavailable: ProcessReadPart[];
}

export interface ProcessNeedSummary {
  slug: string;
  kind: ProcessNeedKind;
  state: ProcessNeedState;
}

/** One process, whole. */
export interface ProcessRead {
  playbook: ProcessDefinition;
  when: {
    automations: ProcessAutomation[];
    workers: ProcessWorker[];
    /** A person can start it by hand (an active, session-scoped playbook). */
    manualStart: boolean;
  };
  steps: ProcessStep[];
  checks: { criteria: ProcessCriterion[]; gates: ProcessGate[] };
  /** null when the playbook names no subject kind. */
  moves: ProcessMoves | null;
  needs: ProcessNeed[];
  skills: ProcessSkill[];
  runs: { counts: ProcessRunCounts; recent: ProcessRunRow[] };
  health: ProcessHealth;
  unavailable: ProcessReadPart[];
}

// ── Counts helpers (pure) ────────────────────────────────────────────────────

export type ProcessNeedCounts = Record<ProcessNeedState, number>;

/** How many needs are filled, empty and unmeasured. */
export function countProcessNeeds(
  needs: ReadonlyArray<Pick<ProcessNeed, "state">>
): ProcessNeedCounts {
  const out: ProcessNeedCounts = { filled: 0, empty: 0, unknown: 0 };
  for (const n of needs) out[n.state] += 1;
  return out;
}

/**
 * Whether every need is known filled. `null` when any need is unmeasured:
 * "ready" is a claim, and an unmeasured need cannot back it.
 */
export function processNeedsReady(
  needs: ReadonlyArray<Pick<ProcessNeed, "state">>
): boolean | null {
  const c = countProcessNeeds(needs);
  if (c.empty > 0) return false;
  if (c.unknown > 0) return null;
  return true;
}

/** The empty run counts: nothing measured. */
export function unmeasuredProcessRunCounts(): ProcessRunCounts {
  return {
    open: null,
    needsYou: null,
    doneThisWeek: null,
    failedThisWeek: null,
    total: null,
  };
}

/** Collapse a full need to its card form. */
export function summarizeProcessNeed(need: ProcessNeed): ProcessNeedSummary {
  return { slug: need.slug, kind: need.kind, state: need.state };
}
