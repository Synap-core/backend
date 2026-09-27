/**
 * Start work FROM a work template — the ONE rule, shared by every surface that
 * offers it (browser Home "Start from…", relay new-work, relay capture).
 *
 * ── A WORK TEMPLATE SEEDS, IT NEVER BINDS ───────────────────────────────────
 * `playbooks.run` instantiates a run, and `templateId` / `followPlaybookId`
 * stamp `playbookId`, which reclassifies the session from `work` to `run` and
 * moves it off the Work list. So a work template starts YOUR work: a plain
 * session with your goal, and the template's steps copied onto it as the
 * session's own snapshot (`focusSessions.update { stages }`). `playbookId` is
 * never written. Track templates are a different act (`tracks.start`) and do
 * not come through here.
 *
 * ── A FAILED READ IS NOT "NO STEPS" ────────────────────────────────────────
 * The template read runs FIRST, in its own try. Starting blank on a 500 would
 * say "started" over work that silently lost its steps.
 *
 * PURE: the doors arrive as arguments, so each surface wires its own client and
 * navigation while the order of acts and the outcome words stay one.
 */

import { readSeedableStages, type SeedableStage } from "./templates.js";

/** What a surface's create door answered. `deduped` = an open twin was reused. */
export interface CreatedWork {
  id: string;
  deduped?: boolean;
}

export interface WorkFromTemplateDoors {
  /** `playbooks.get` — the template, whose `stages` are read. */
  getTemplate: (id: string) => Promise<unknown>;
  /**
   * The surface's own start join: create PLAIN work with `goal`, await
   * `onCreated` (the seed runs there, BEFORE the work is opened), then open it.
   * Resolves the new work's id, or null when nothing was created (the join has
   * already said why).
   */
  startWork: (
    goal: string,
    onCreated: (created: CreatedWork) => Promise<void>
  ) => Promise<string | null>;
  /** `focusSessions.update { id, stages }` — the seed. */
  seedSteps: (input: {
    id: string;
    stages: SeedableStage[];
  }) => Promise<unknown>;
}

export type WorkFromTemplateOutcome =
  /** Work started, with this many steps copied onto it (0 = the template has none). */
  | { kind: "started"; sessionId: string; steps: number }
  /** An open session with this goal already existed: opened, NOT re-seeded. */
  | { kind: "reused"; sessionId: string }
  /** Work started, but the steps did not land: said, never swallowed. */
  | { kind: "unseeded"; sessionId: string; message: string }
  /** Nothing was started. */
  | { kind: "refused"; message: string };

const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : "The pod refused it.";

/**
 * Start work from a work template. The goal is what the person typed, else the
 * template's own name: a session needs a sentence, and the name is the one the
 * person just chose.
 */
export async function startWorkFromTemplate(
  doors: WorkFromTemplateDoors,
  args: { goal: string; template: { id: string; name: string } }
): Promise<WorkFromTemplateOutcome> {
  const { template } = args;
  const goal = args.goal.trim() || template.name;

  let stages: SeedableStage[];
  try {
    stages = readSeedableStages(await doors.getTemplate(template.id));
  } catch {
    return {
      kind: "refused",
      message: `Couldn't read ${template.name} just now, so nothing was started. Try again.`,
    };
  }

  let seedError: string | null = null;
  let reused = false;
  let sessionId: string | null;
  try {
    sessionId = await doors.startWork(goal, async (created) => {
      // A reused twin is work already in flight: copying steps over it would
      // rewrite its path under whoever is working it. Open it as it is.
      if (created.deduped) {
        reused = true;
        return;
      }
      if (stages.length === 0) return;
      try {
        await doors.seedSteps({ id: created.id, stages });
      } catch (err) {
        seedError = errorText(err);
      }
    });
  } catch (err) {
    return {
      kind: "refused",
      message: `Couldn't start ${template.name}: ${errorText(err)}`,
    };
  }

  if (!sessionId) {
    // The join already reported why; this only says nothing was started.
    return { kind: "refused", message: `Couldn't start ${template.name}.` };
  }
  if (reused) return { kind: "reused", sessionId };
  if (seedError) return { kind: "unseeded", sessionId, message: seedError };
  return { kind: "started", sessionId, steps: stages.length };
}

/**
 * The words for an outcome, or null when landing on the work says it all.
 * "Step" is the glossary word (concepts.md), on every surface.
 */
export function describeWorkFromTemplate(
  outcome: WorkFromTemplateOutcome,
  templateName: string
): { tone: "info" | "error"; text: string } | null {
  switch (outcome.kind) {
    case "started":
      if (outcome.steps === 0) return null;
      return {
        tone: "info",
        text: `Started from ${templateName}: ${outcome.steps === 1 ? "its 1 step was" : `its ${outcome.steps} steps were`} copied onto your work.`,
      };
    case "reused":
      return {
        tone: "info",
        text: "You already had work with that goal, so it was opened as it is.",
      };
    case "unseeded":
      return {
        tone: "error",
        text: `Started, but the steps of ${templateName} were not copied: ${outcome.message}`,
      };
    case "refused":
      return { tone: "error", text: outcome.message };
  }
}
