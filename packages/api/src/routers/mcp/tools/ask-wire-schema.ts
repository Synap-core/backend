/**
 * The `ask` as it is ADVERTISED on the wire: ONE small, loose object shared by
 * every tool that carries an ask (start/update_session, create/update_playbook,
 * ask_person, post_message). Loose on the wire, STRICT on the server: the real
 * contract stays `AskSchema` (@synap-core/types/ask), which every handler still
 * parses with, so a wrong shape is refused there, with a message that names the
 * `system/synap/asks` skill (`ASK_SKILL_HINT`). The full shapes and examples
 * are taught on demand by that skill, not pushed into every tool definition
 * (founder, 7 Nov 2026: tool definitions target 2K tokens).
 *
 * Every ask that `AskSchema` accepts also validates here (the schema declares
 * no `required` beyond `mode` and no `additionalProperties:false`): see
 * ask-wire-schema.test.ts.
 */
import { z } from "zod";
import { wireInputSchema } from "../tool-input.js";

export const ASK_SKILL_REF = "system/synap/asks";

/** Appended to a server refusal of an ask so the agent knows where the shapes are. */
export const ASK_SKILL_HINT = ` Shapes and examples: synap_load_skill("${ASK_SKILL_REF}").`;

const OBJ = z.record(z.string(), z.unknown());

export const ASK_WIRE_DESCRIPTION =
  `HOW the person answers (shapes: synap_load_skill("${ASK_SKILL_REF}")). mode: ` +
  "confirm {prompt, yes?, no?} | choose {options 1-8, at most one recommended} | " +
  "form {form:{fields}} | act {steps, url?} | provide {provide:{kind: connection|file|secret}}.";

export const ASK_INPUT = z
  .looseObject({
    mode: z.enum(["confirm", "choose", "form", "act", "provide"]),
    prompt: z.string().optional().describe("confirm: the question"),
    yes: OBJ.optional().describe(
      "confirm: {label?, description?, recommended?}"
    ),
    no: OBJ.optional().describe(
      "confirm: {label?, description?, recommended?}"
    ),
    options: z
      .array(OBJ)
      .optional()
      .describe(
        "choose: [{label, value?, description?, recommended?, caution?, followUp?, media?}]"
      ),
    allowOther: z.boolean().optional(),
    form: OBJ.optional().describe(
      "form: {fields:[{key,label,type}], title?, note?}"
    ),
    url: z.string().optional().describe("act: link"),
    steps: z.array(z.string()).optional().describe("act: up to 7"),
    provide: OBJ.optional().describe(
      "provide: {kind:'connection',service} | {kind:'file',accept?} | {kind:'secret',name}"
    ),
    risk: z.enum(["high", "medium", "low"]).optional(),
    stakes: z.enum(["routine", "commitment"]).optional(),
    urgency: z.enum(["today", "whenever"]).optional(),
    answerBy: z.string().optional().describe("ISO-8601 with offset"),
    consequence: z.string().optional().describe("what the answer will DO"),
    reversible: z.boolean().optional(),
    dedupeKey: z.string().optional(),
    lookedAt: z.array(OBJ).optional().describe("[{kind, id}], up to 8"),
  })
  .describe(ASK_WIRE_DESCRIPTION);

/** The ask as the wire carries it (JSON Schema). */
export function buildAskWireSchema(): Record<string, unknown> {
  return wireInputSchema(ASK_INPUT);
}
