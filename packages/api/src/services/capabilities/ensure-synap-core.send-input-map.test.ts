/**
 * Synap Core's `messaging.send` input map INSTALLS (channels wave, lane D).
 *
 * The map is checked when the definition is applied (`assertInputMaps`,
 * official definitions only), and Synap Core is applied whole: one invalid
 * map would make `ensureSynapCoreCapability` throw, log "non-fatal" and
 * leave EVERY new builtin of the release unseeded. So the map is checked here
 * against the same rule and the send_message intent's input shape (0369).
 *
 * Its account source is `messaging.accounts`, a builtin of the same
 * definition with no tool: two builtins of one definition reach the same
 * "tool" (the pod), and the source must be a declared read.
 */
import { describe, it, expect } from "vitest";
import { SYNAP_CORE_DEFINITION } from "./ensure-synap-core.js";
import { definitionInputMapProblems } from "./intent-input.js";
import { READ_ONLY_BUILTIN_VERBS } from "./builtin-verbs.js";

/** `capability_intents.input_schema` of send_message (migration 0369). */
const SEND_MESSAGE_INPUT = {
  type: "object",
  properties: {
    to: { type: "string", format: "uuid" },
    text: { type: "string", minLength: 1, maxLength: 10000 },
    subject: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["to", "text"],
  additionalProperties: false,
};

const skill = (name: string) =>
  SYNAP_CORE_DEFINITION.skills.find((s) => s.name === name)!;

describe("Synap Core: messaging.send serves send_message with one input", () => {
  it("its input map has no problem against the intent and its own definition", () => {
    const send = skill("messaging.send");
    expect(send.intent).toBe("send_message");
    expect(send.inputMap).toBeDefined();
    expect(
      definitionInputMapProblems(
        send,
        SYNAP_CORE_DEFINITION.skills,
        SEND_MESSAGE_INPUT
      )
    ).toEqual([]);
  });

  it("its account source is a declared read that auto-runs", () => {
    const accounts = skill("messaging.accounts");
    expect(accounts.metadata?.readOnly).toBe(true);
    expect(READ_ONLY_BUILTIN_VERBS.has("messaging.accounts")).toBe(true);
    expect(READ_ONLY_BUILTIN_VERBS.has("channel.history")).toBe(true);
    // A send is never a read.
    expect(READ_ONLY_BUILTIN_VERBS.has("messaging.send")).toBe(false);
  });

  it("a builtin cannot list accounts for a verb of ANOTHER tool", () => {
    const problems = definitionInputMapProblems(
      {
        ...skill("messaging.send"),
        kind: "declarative",
        requires: ["unipile"],
      },
      SYNAP_CORE_DEFINITION.skills,
      SEND_MESSAGE_INPUT
    );
    expect(problems.join(" ")).toMatch(/must use the same tool/);
  });
});
