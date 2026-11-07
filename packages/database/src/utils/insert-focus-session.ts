import { buildDerivedSessionTitle } from "@synap-core/types/focus-sessions";
import { stampSlotKeys } from "@synap-core/types/units";
import { db } from "../client-pg.js";
import { focusSessions, type FocusSession } from "../schema/focus-sessions.js";
import { stampProbeMarker } from "./request-write-context.js";

/**
 * THE ONE WRITER of a new `focus_sessions` row (plan "One model" §11 row 5).
 *
 * The four birth doors (`createFocusSession`, `instantiateSessionRow`, the
 * `focus_session/create` executor, `openRunSession`) each held their own
 * INSERT, and the copies drifted (the run funnel never copied the stages, the
 * direct door never owed the first stage's outputs, a run session was born
 * nameless with unkeyed slots). Every rule a row is born with lives here; the
 * doors decide WHAT to write and what to do around it.
 *
 * In `@synap/database` because the jobs layer opens run sessions and cannot
 * import `@synap/api`. The birth rules that need api services sit beside it,
 * in `session-birth.ts` (`withBirthStageSlots`, `writeSessionBirthSubjectMove`).
 * The sync upsert (`routers/sync.ts`) replays a row a client already holds:
 * not a birth, it keeps its own write.
 */

/** The process a session is born following: its playbook, read as stored. */
export interface SessionDefinition {
  id: string;
  /** Names a run's derived title ("<playbook> — <date>"). */
  name?: string | null;
  /** The playbook's `stages` JSONB, as stored: never trusted to be an array. */
  stages: unknown;
}

export interface NewFocusSessionRow {
  /** A caller-minted id (the proposal's prospective id, a held start's id). */
  id?: string;
  userId: string;
  goal: string;
  /** The session's name. Absent ⇒ derived ({@link derivedSessionTitle}). */
  title?: string | null;
  correlationId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  /** A goal is only ever written with ITS project: the caller resolved both. */
  trackId?: string | null;
  /** The track stage; dropped when there is no track (a stage belongs to one). */
  trackStage?: string | null;
  subjectEntityId?: string | null;
  /** Legacy pointer (a free-text template, an automation id). */
  templateId?: string | null;
  /**
   * The playbook this session runs. Its definition is SNAPSHOTTED here:
   * `playbookId`, the session's own copy of the stages (0270) and the first
   * stage as `currentStage`. Absent ⇒ no process: no stages, no stage.
   */
  playbook?: SessionDefinition | null;
  origin: "playbook" | "automation" | "agent" | "human";
  channelId?: string | null;
  agentIds?: string[];
  /** Born live, or as an appointment a person opens. Default `active`. */
  status?: "active" | "scheduled";
  /**
   * Every slot the session owes from birth, already through the doors'
   * floors (`sanitizeDeclaredOutputs` + server-minted slots). Keyed here.
   */
  expectedOutputs?: readonly unknown[];
  criteria?: readonly unknown[];
  metadata?: Record<string, unknown>;
}

export interface InsertFocusSessionOptions {
  /**
   * `nothing` — a caller-fixed `id` that already names a row writes nothing
   * and returns `null` (a re-approve, a replay). Default: the insert throws on
   * any conflict, which is what a freshly minted id wants.
   */
  onConflict?: "nothing";
}

/**
 * The key of a playbook's first stage, or null for a stageless playbook.
 * Stages are stored as JSONB, so this stays defensive about shape rather than
 * trusting the row to be well-formed.
 */
export function firstStageKey(stages: unknown): string | null {
  if (!Array.isArray(stages) || stages.length === 0) return null;
  const first = stages[0] as { key?: unknown } | null;
  const key = first && typeof first === "object" ? first.key : undefined;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * The stage list to COPY onto a new session. Anything that is not an array is
 * no stages — a jsonb column can hold whatever was last written to it, and a
 * session is not the place to discover that.
 */
export function readStages(stages: unknown): unknown[] {
  return Array.isArray(stages) ? stages : [];
}

/**
 * The name a session is born with when nobody gave one (plan 9992207a,
 * c-auto-titles): no session is stored nameless. Derived from the playbook it
 * runs, else from its goal, and marked `derived` so the background titler may
 * still improve it and a person's or agent's own title always wins.
 */
export function derivedSessionTitle(row: {
  goal: string;
  playbook?: { name?: string | null } | null;
}): string {
  return row.playbook?.name
    ? buildDerivedSessionTitle({ kind: "run", name: row.playbook.name })
    : buildDerivedSessionTitle({ kind: "goal", goal: row.goal });
}

/**
 * The columns a session's definition decides, for a row being born (inserted
 * here, or adopted by the direct start: an auto-opened receipt becoming this
 * work is a birth too). One answer for both, so an adopted session and an
 * inserted one cannot carry different stages for the same playbook.
 */
export function sessionDefinitionColumns(
  playbook: SessionDefinition | null | undefined,
  expectedOutputs: readonly unknown[] | undefined
) {
  return {
    playbookId: playbook?.id ?? null,
    // SNAPSHOTTED at birth, like criteria and slots: editing the playbook
    // afterwards must not rewrite what an in-flight session says it is doing.
    stages: readStages(playbook?.stages),
    // "Seeded from the playbook's first stage on instantiation" (the column's
    // contract); a stageless playbook leaves it NULL.
    currentStage: firstStageKey(playbook?.stages),
    // Keyed at birth (`slot-keys.ts`): every slot's stable identity.
    expectedOutputs: [...(expectedOutputs ?? [])] as never[],
  };
}

/**
 * Insert one session row. With no conflict mode the row is always returned (a
 * conflict throws); with `onConflict: "nothing"` a taken id returns `null`.
 */
export async function insertFocusSessionRow(
  database: typeof db,
  row: NewFocusSessionRow,
  options?: { onConflict?: undefined }
): Promise<FocusSession>;
export async function insertFocusSessionRow(
  database: typeof db,
  row: NewFocusSessionRow,
  options: InsertFocusSessionOptions
): Promise<FocusSession | null>;
export async function insertFocusSessionRow(
  database: typeof db,
  row: NewFocusSessionRow,
  options: InsertFocusSessionOptions = {}
): Promise<FocusSession | null> {
  const trackId = row.trackId ?? null;
  const title = row.title || derivedSessionTitle(row);
  const metadata = row.title
    ? (row.metadata ?? {})
    : { ...(row.metadata ?? {}), titleSource: "derived" };
  const insert = database.insert(focusSessions).values({
    ...(row.id ? { id: row.id } : {}),
    userId: row.userId,
    goal: row.goal,
    title,
    correlationId: row.correlationId ?? null,
    workspaceId: row.workspaceId ?? null,
    projectId: row.projectId ?? null,
    trackId,
    trackStage: trackId ? (row.trackStage ?? null) : null,
    subjectEntityId: row.subjectEntityId ?? null,
    templateId: row.templateId ?? null,
    ...sessionDefinitionColumns(row.playbook, row.expectedOutputs),
    // Typed origin (migration 0240): the door says who authored the row from
    // its own typed inputs, never from the metadata bag.
    origin: row.origin,
    channelId: row.channelId ?? null,
    agentIds: row.agentIds ?? [],
    status: row.status ?? "active",
    criteria: [...(row.criteria ?? [])] as never[],
    // D8: a test-key request's session is a probe (no-op outside that scope).
    metadata: stampProbeMarker(metadata),
  });
  if (options.onConflict === "nothing") {
    const [kept] = await insert.onConflictDoNothing().returning();
    return kept ?? null;
  }
  const [session] = await insert.returning();
  // Unreachable for Postgres (an INSERT that does not throw returns its row);
  // said rather than asserted, so a driver that ever drops it is loud.
  if (!session) throw new Error("focus_sessions insert returned no row");
  return session;
}
