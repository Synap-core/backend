/**
 * `runner`, `requires` and `uses` — the WRITE-boundary schemas of who does a
 * playbook or a step, the tools it needs, and a step that IS another playbook
 * (founder decision, proposal 72fdca0b; spec document 7111934d §2).
 *
 * The types live with `PlaybookStage` in `@synap/playbooks` (dependency-free);
 * these zod schemas are their one runtime check, used by the stage schema
 * (`playbook-stage.ts`) and the playbook definition (`playbook-definition.ts`).
 *
 * Every shape here is STRICT, like a stage's `gate` / `onFail` / `forEach`: a
 * runner or a `uses` is a control, and a misspelled key ("agent", "playbook")
 * must not survive as a step that looks handed off and is not.
 */

import { z } from "zod";
import {
  PLAYBOOK_REQUIRES_MAX,
  PLAYBOOK_RUNNER_MAX_CHOICES,
  type PlaybookRunner,
  type PlaybookRunnerRef,
  type PlaybookStageUses,
} from "@synap/playbooks";

/** A slug a person reads back: an agent role, a preset key, an engine, a persona. */
const slug = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, {
      message: `${what} must be a lowercase slug (e.g. "video-editor")`,
    });

/** A computer, by id or by name (matched like `synap_request_installation`). */
const computerRef = z.string().trim().min(1).max(200);

const IDENTIFIER_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const safePath = (what: string) =>
  z
    .string()
    .trim()
    .max(200)
    .regex(IDENTIFIER_PATH, {
      message: `${what} must be an identifier path (e.g. "takeUrl" or "subject.url"), not prose`,
    })
    .refine((p) => !p.split(".").some((s) => UNSAFE_SEGMENTS.has(s)), {
      message: "a path may not contain __proto__, constructor or prototype",
    });

const agentRefSchema = z.strictObject({
  agentId: z.string().trim().min(1).max(200),
  preset: slug("preset").optional(),
});
const roleRefSchema = z.strictObject({
  role: slug("role"),
  computer: computerRef.optional(),
});
const engineRefSchema = z.strictObject({
  engine: slug("engine"),
  computer: computerRef.optional(),
});
const synapAiRefSchema = z.strictObject({
  synapAi: z.strictObject({ persona: slug("persona") }),
});

/** One choice for a STEP (`"self"` allowed: the run's own agent). */
export const stageRunnerRefSchema: z.ZodType<PlaybookRunnerRef> = z.union([
  z.literal("self"),
  z.literal("synap_ai"),
  synapAiRefSchema,
  agentRefSchema,
  roleRefSchema,
  engineRefSchema,
]);

/** One choice for a whole PLAYBOOK (`"self"` names nobody at that level). */
export const playbookRunnerRefSchema: z.ZodType<PlaybookRunnerRef> = z.union([
  z.literal("synap_ai"),
  synapAiRefSchema,
  agentRefSchema,
  roleRefSchema,
  engineRefSchema,
]);

function runnerOf(
  ref: z.ZodType<PlaybookRunnerRef>
): z.ZodType<PlaybookRunner> {
  return z.union([
    ref,
    z
      .array(ref)
      .min(1)
      .max(PLAYBOOK_RUNNER_MAX_CHOICES, {
        message: `a runner lists at most ${PLAYBOOK_RUNNER_MAX_CHOICES} choices`,
      }),
  ]);
}

/** A step's `runner`: one choice, or an ordered list of fallbacks. */
export const stageRunnerSchema = runnerOf(stageRunnerRefSchema);

/** A playbook's `runner`: one choice, or an ordered list of fallbacks. */
export const playbookRunnerSchema = runnerOf(playbookRunnerRefSchema);

/**
 * `requires`: capability keys (`media-ffmpeg`), a SET. Shape only here: whether
 * a key is a capability the runner's computer can get is answered when the step
 * is handed over (the installations door says "not in the marketplace").
 */
export const requiresSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^@?[a-z0-9][a-z0-9._/-]*$/, {
        message:
          'a required tool is a capability key (e.g. "media-ffmpeg"), not prose',
      })
  )
  .max(PLAYBOOK_REQUIRES_MAX, {
    message: `requires lists at most ${PLAYBOOK_REQUIRES_MAX} tools`,
  })
  .superRefine((keys, ctx) => {
    const seen = new Set<string>();
    keys.forEach((key, index) => {
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: `requires repeats "${key}" — it is a set, not a list`,
        });
      }
      seen.add(key);
    });
  });

/**
 * A step's `uses`. `version` is optional HERE only: the write door
 * (`resolveStageUses`) fills in the used playbook's current version before the
 * definition is gated or stored, so a stored `uses` always carries one.
 */
export const stageUsesSchema = z.strictObject({
  playbookId: z.string().uuid({
    message: "uses.playbookId must be a playbook id from synap_list_playbooks",
  }),
  version: z.number().int().min(1).optional(),
  with: z
    .record(z.string().trim().min(1).max(120), safePath("uses.with"))
    .optional(),
  outputs: z
    .record(
      z.string().trim().min(1).max(200),
      z.string().trim().min(1).max(200)
    )
    .optional(),
}) as z.ZodType<PlaybookStageUses>;

/** Does any choice of this runner name one agent by id (pod-specific)? */
export function runnerNamesAgentId(runner: unknown): boolean {
  const list = Array.isArray(runner) ? runner : [runner];
  return list.some(
    (r) => !!r && typeof r === "object" && "agentId" in (r as object)
  );
}
