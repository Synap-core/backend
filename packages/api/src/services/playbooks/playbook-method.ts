/**
 * A playbook's METHOD, rendered once for every door that binds one.
 *
 * The method is what a playbook teaches the agent that works it: the
 * human-approved "how to run this playbook" context skill, and the current
 * stage's goal, expected outputs, suggested tasks, lessons from earlier runs
 * and advisory grants. Until this module, only the IS executor rendered it
 * (into the run's kickoff message); an MCP agent that bound the same playbook
 * with `synap_start_session { templateId }` or `synap_update_session
 * { followPlaybookId }` got none of it. Both doors now render through
 * {@link renderPlaybookMethod}, so the two can never drift.
 *
 * The method also carries the RULES the playbook follows (its declared
 * `guidance`, design b199a3a4): the current, person-approved version of each
 * ref, rendered by the ONE pure renderer (`@synap-core/types/guidance`)
 * through {@link loadMethodGuidance}. Every door renders it: the IS kickoff,
 * the MCP bind doors and the external-agent dispatch.
 */

import {
  getDb,
  playbooks,
  skills,
  links,
  eq,
  and,
  desc,
  drizzleSql,
} from "@synap/database";
import { readStageLessons, type PlaybookStage } from "@synap/playbooks";
import {
  guidanceSnapshotOf,
  guidanceUnavailableText,
  type GuidanceSnapshot,
} from "@synap-core/types/guidance";
import {
  loadPlaybookGuidance,
  recordRunGuidance,
} from "./playbook-guidance.js";

/** The heading the context skill is rendered under. */
export const PLAYBOOK_HOW_TO_HEADING = "## How to run this playbook";

/**
 * The active-stage section: name, goal, expected outputs, suggested tasks,
 * advisory grants, and the stage's LESSONS — what earlier runs of this stage
 * taught (`PlaybookStage.lessons`, revised by the lessons scanner). One
 * channel: lessons ride with the goal they qualify, never a second prompt.
 */
export function buildStageSection(stage: PlaybookStage): string {
  const lines = [`## Current stage: ${stage.name}`];
  if (stage.goal) lines.push(stage.goal);
  if (stage.expectedOutputs?.length) {
    lines.push(
      `Expected outputs: ${stage.expectedOutputs
        .map((o) => o.label)
        .join(", ")}`
    );
  }
  if (stage.suggestedTasks?.length) {
    lines.push(`Suggested tasks: ${stage.suggestedTasks.join(", ")}`);
  }
  const lessons = readStageLessons(stage);
  if (lessons.length) {
    lines.push(
      `Lessons from earlier runs of this stage:\n${lessons
        .map((l) => `- ${l}`)
        .join("\n")}`
    );
  }
  if (stage.grants?.length) {
    lines.push(
      `Capabilities available at this stage: ${stage.grants
        .map((g) => g.id)
        .join(", ")}`
    );
  }
  return lines.join("\n");
}

/**
 * THE renderer. Sections, in order, each omitted when empty: the context
 * skill ("how to run this playbook"), the rules this playbook follows (the
 * rendered guidance section, {@link loadMethodGuidance}), the `body` (the
 * executor's goal block; the MCP doors pass none, the agent already holds its
 * goal), the current stage. Joined by one blank line.
 */
export function renderPlaybookMethod(input: {
  contextSkill?: string | null;
  guidance?: string | null;
  body?: string | null;
  stage?: PlaybookStage | null;
}): string {
  const howTo = input.contextSkill?.trim();
  return [
    howTo ? `${PLAYBOOK_HOW_TO_HEADING}\n${howTo}` : "",
    input.guidance?.trim() ?? "",
    input.body ?? "",
    input.stage ? buildStageSection(input.stage) : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * The playbook's layer-2 CONTEXT SKILL body — the "how to run THIS playbook"
 * instruction, linked to the playbook by a non-grant `documents` edge. `null`
 * when it has none. THROWS on a failed read: the caller decides whether that
 * is fatal (the executor proceeds without it; the MCP doors say so).
 */
export async function loadPlaybookContextSkill(
  playbookId: string
): Promise<string | null> {
  const db = await getDb();
  const [ctxSkill] = await db
    .select({ body: skills.body })
    .from(links)
    // `skills.id` is uuid, `links.toId` is text → SQLSTATE 42883 without the
    // cast (it once failed silently inside the executor's non-fatal catch, so
    // the prefix never injected on any pod with real data).
    .innerJoin(skills, eq(drizzleSql`${skills.id}::text`, links.toId))
    .where(
      and(
        eq(links.fromType, "playbook"),
        eq(links.fromId, playbookId),
        eq(links.linkType, "documents"),
        eq(links.toType, "skill"),
        eq(skills.kind, "instruction"),
        // SECURITY — only HUMAN-APPROVED prose. This body is prompt surface on
        // every door that renders it. Agent-authored instruction skills are
        // born unapproved (playbooks.ts / skills.ts) precisely so an agent
        // cannot write into its own future prompts without review — above all
        // a "learning" derived from fetched web content.
        eq(skills.approved, true)
      )
    )
    // Deterministic pick: a composed template or re-install can leave more
    // than one instruction skill linked; always take the newest.
    .orderBy(desc(skills.createdAt))
    .limit(1);
  const body = ctxSkill?.body?.trim();
  return body ? body : null;
}

/**
 * The guidance section for one reader, and what a run records of it. NEVER
 * throws: a failed read renders a section that says the rules could not be
 * loaded (never an empty one, which would read as "no rules") and snapshots
 * `{ status: "unavailable" }`. `text` is "" when the playbook declares none.
 */
export async function loadMethodGuidance(
  playbookId: string,
  userId: string
): Promise<{ text: string; snapshot: GuidanceSnapshot }> {
  try {
    const { rendered } = await loadPlaybookGuidance(playbookId, { userId });
    return { text: rendered.text, snapshot: guidanceSnapshotOf(rendered) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      text: guidanceUnavailableText(error),
      snapshot: { status: "unavailable", error },
    };
  }
}

/** The run id the runner threads into an executor's `input` (`runId`). */
export function runIdOf(input: unknown): string | null {
  const id = (input as { runId?: unknown } | null | undefined)?.runId;
  return typeof id === "string" && id ? id : null;
}

/**
 * What an EXECUTOR renders the method from, read once per run: the context
 * skill and the guidance section, with the guidance the run used stamped on
 * its definition snapshot (`runId`). Shared by the IS kickoff and the
 * external-agent dispatch so the two cannot read the method differently.
 * Never throws: a failed context-skill read is logged and skipped (the
 * executor's long-standing rule), a failed guidance read says so in the
 * section, and a failed stamp is logged.
 */
export async function loadRunMethodParts(input: {
  playbookId: string | undefined;
  userId: string;
  runId?: string | null;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<{ contextSkill: string | null; guidance: string }> {
  if (!input.playbookId) return { contextSkill: null, guidance: "" };
  let contextSkill: string | null = null;
  try {
    contextSkill = await loadPlaybookContextSkill(input.playbookId);
  } catch (err) {
    // Logged because this query runs on EVERY playbook run: a persistent
    // failure would silently degrade every run otherwise.
    input.warn(
      { err, playbookId: input.playbookId },
      "context skill lookup failed (non-fatal)"
    );
  }
  const guidance = await loadMethodGuidance(input.playbookId, input.userId);
  if (input.runId) {
    try {
      await recordRunGuidance(input.runId, guidance.snapshot);
    } catch (err) {
      input.warn(
        { err, runId: input.runId },
        "recording the run's guidance failed (non-fatal)"
      );
    }
  }
  return { contextSkill, guidance: guidance.text };
}

/** What a binding door hands the agent: the method, or why it could not. */
export type BoundPlaybookMethod =
  | {
      status: "ok";
      playbookId: string;
      playbookName: string;
      /** The stage the session is in, or null (a follow names none by default). */
      stageKey: string | null;
      /** The rendered method; "" when the playbook declares none. */
      text: string;
    }
  | { status: "unavailable"; playbookId: string; error: string };

/**
 * The method of the playbook a session just bound, for the binding door's
 * reply. The bind already passed the playbook's access floor, so the row is
 * read by id. `stages` is the session's own snapshot when it has one (a
 * session started from the playbook); otherwise (a follow) the playbook's.
 * A failed read is `unavailable`, never an empty method.
 */
export async function loadBoundPlaybookMethod(input: {
  playbookId: string;
  stageKey: string | null;
  stages?: unknown;
  /** The reader: the guidance renders what THEY may read. */
  userId: string;
}): Promise<BoundPlaybookMethod> {
  try {
    const db = await getDb();
    const [playbook] = await db
      .select({ name: playbooks.name, stages: playbooks.stages })
      .from(playbooks)
      .where(eq(playbooks.id, input.playbookId))
      .limit(1);
    if (!playbook) {
      return {
        status: "unavailable",
        playbookId: input.playbookId,
        error: "the bound playbook could not be read",
      };
    }
    const own = Array.isArray(input.stages) ? input.stages : [];
    const stages = (
      own.length > 0
        ? own
        : Array.isArray(playbook.stages)
          ? playbook.stages
          : []
    ) as PlaybookStage[];
    const stage = input.stageKey
      ? (stages.find((s) => s?.key === input.stageKey) ?? null)
      : null;
    const contextSkill = await loadPlaybookContextSkill(input.playbookId);
    const guidance = await loadMethodGuidance(input.playbookId, input.userId);
    return {
      status: "ok",
      playbookId: input.playbookId,
      playbookName: playbook.name,
      stageKey: input.stageKey,
      text: renderPlaybookMethod({
        contextSkill,
        guidance: guidance.text,
        stage,
      }),
    };
  } catch (err) {
    return {
      status: "unavailable",
      playbookId: input.playbookId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
