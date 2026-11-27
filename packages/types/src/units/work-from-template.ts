/**
 * Start work FROM a playbook — the ONE rule, shared by every surface that
 * offers it (browser Home "Start from…", relay new-work, relay capture).
 *
 * ── STARTING FROM A PLAYBOOK BINDS IT (founder, 27 Nov 2026) ───────────────
 * The session is started WITH the playbook: `focusSessions.create { goal,
 * templateId }`. The pod's one create door (`createFocusSession`) then makes
 * it a real run of that playbook: `playbookId` stamped, the playbook's stages
 * snapshotted onto the session with the first one current, a `playbook_runs`
 * row, the session placed in the playbook's space (W3), and a stage that moves
 * the subject's status moves it (W6). The surface copies nothing: the steps
 * come from the binding, so a stage advance and the subject's status follow
 * the playbook. (Until 27 Nov this leaf started plain work and copied the
 * steps onto it with `focusSessions.update { stages }`; nothing advanced.)
 * Track templates are a different act (`tracks.start`) and do not come
 * through here.
 *
 * ── A REFUSAL IS SAID ──────────────────────────────────────────────────────
 * A playbook the person cannot see, or any other refusal of the start door,
 * comes back as `refused` with its reason; nothing half-started is reported
 * as started.
 *
 * PURE: the door arrives as an argument, so each surface wires its own client
 * and navigation while the order of acts and the outcome words stay one.
 */

/** What a surface's create door answered. `deduped` = an open twin was reused. */
export interface CreatedWork {
  id: string;
  deduped?: boolean;
}

export interface WorkFromTemplateDoors {
  /**
   * The surface's own start join: create the session with `goal` BOUND to the
   * playbook `templateId` (`focusSessions.create { goal, templateId }`), then
   * open it. Resolves what was created, or null when nothing was (the join
   * has already said why).
   */
  startWork: (start: {
    goal: string;
    templateId: string;
  }) => Promise<CreatedWork | null>;
}

export type WorkFromTemplateOutcome =
  /** A run of the playbook started: bound, its steps its own. */
  | { kind: "started"; sessionId: string }
  /** The join reused an open session with this goal: opened as it is. */
  | { kind: "reused"; sessionId: string }
  /** Nothing was started. */
  | { kind: "refused"; message: string };

const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : "The pod refused it.";

/**
 * Start work from a playbook. The goal is what the person typed, else the
 * playbook's own name: a session needs a sentence, and the name is the one
 * the person just chose.
 */
export async function startWorkFromTemplate(
  doors: WorkFromTemplateDoors,
  args: { goal: string; template: { id: string; name: string } }
): Promise<WorkFromTemplateOutcome> {
  const { template } = args;
  const goal = args.goal.trim() || template.name;

  let created: CreatedWork | null;
  try {
    created = await doors.startWork({ goal, templateId: template.id });
  } catch (err) {
    return {
      kind: "refused",
      message: `Couldn't start ${template.name}: ${errorText(err)}`,
    };
  }

  if (!created) {
    // The join already reported why; this only says nothing was started.
    return { kind: "refused", message: `Couldn't start ${template.name}.` };
  }
  if (created.deduped) return { kind: "reused", sessionId: created.id };
  return { kind: "started", sessionId: created.id };
}

/**
 * The words for an outcome, or null when landing on the work says it all
 * (a started run shows its own steps).
 */
export function describeWorkFromTemplate(
  outcome: WorkFromTemplateOutcome,
  _templateName: string
): { tone: "info" | "error"; text: string } | null {
  switch (outcome.kind) {
    case "started":
      return null;
    case "reused":
      return {
        tone: "info",
        text: "You already had work with that goal, so it was opened as it is.",
      };
    case "refused":
      return { tone: "error", text: outcome.message };
  }
}
