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

export const ASK_SKILL_REF = "system/synap/asks";

/** Appended to a server refusal of an ask so the agent knows where the shapes are. */
export const ASK_SKILL_HINT = ` Shapes and examples: synap_load_skill("${ASK_SKILL_REF}").`;

const OBJ = { type: "object" } as const;

export const ASK_WIRE_DESCRIPTION =
  `HOW the person answers (shapes: synap_load_skill("${ASK_SKILL_REF}")). mode: ` +
  "confirm {prompt, yes?, no?} | choose {options 1-8, at most one recommended} | " +
  "form {form:{fields}} | act {steps, url?} | provide {provide:{kind: connection|file|secret}}.";

export function buildAskWireSchema(
  description: string = ASK_WIRE_DESCRIPTION
): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      mode: {
        type: "string",
        enum: ["confirm", "choose", "form", "act", "provide"],
      },
      prompt: { type: "string", description: "confirm: the question" },
      yes: {
        ...OBJ,
        description: "confirm: {label?, description?, recommended?}",
      },
      no: {
        ...OBJ,
        description: "confirm: {label?, description?, recommended?}",
      },
      options: {
        type: "array",
        items: OBJ,
        description:
          "choose: [{label, value?, description?, recommended?, caution?, followUp?, media?}]",
      },
      allowOther: { type: "boolean" },
      form: {
        ...OBJ,
        description: "form: {fields:[{key,label,type}], title?, note?}",
      },
      url: { type: "string", description: "act: link" },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "act: up to 7",
      },
      provide: {
        ...OBJ,
        description:
          "provide: {kind:'connection',service} | {kind:'file',accept?} | {kind:'secret',name}",
      },
      risk: { type: "string", enum: ["high", "medium", "low"] },
      stakes: { type: "string", enum: ["routine", "commitment"] },
      urgency: { type: "string", enum: ["today", "whenever"] },
      answerBy: { type: "string", description: "ISO-8601 with offset" },
      consequence: { type: "string", description: "what the answer will DO" },
      reversible: { type: "boolean" },
      dedupeKey: { type: "string" },
      lookedAt: {
        type: "array",
        items: OBJ,
        description: "[{kind, id}], up to 8",
      },
    },
    required: ["mode"],
  };
}
