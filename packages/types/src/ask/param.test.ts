import { describe, it, expect } from "vitest";
import {
  AskAnswerValueSchema,
  AskSchema,
  PLAYBOOK_PARAM_FIELD_TYPE,
  PLAYBOOK_PARAM_TYPES,
  playbookParamAsk,
  summarizeAnswer,
} from "./index.js";

describe("playbookParamAsk — a missing param as the ask it is owed through", () => {
  it("choice with options → choose, each option its own value, no Other…", () => {
    const ask = playbookParamAsk({
      name: "channel",
      type: "choice",
      options: ["email", "linkedin"],
    });
    expect(ask).toEqual({
      mode: "choose",
      options: [
        { label: "email", value: "email" },
        { label: "linkedin", value: "linkedin" },
      ],
    });
  });

  it("boolean → confirm", () => {
    expect(playbookParamAsk({ name: "dryRun", type: "boolean" })).toEqual({
      mode: "confirm",
    });
  });

  it("text / number / entity → a one-field required form keyed by the param NAME, typed like the web form", () => {
    for (const type of ["text", "number", "entity"] as const) {
      const ask = playbookParamAsk({
        name: "target",
        label: "Target",
        type,
        description: "what to aim at",
      });
      expect(ask).toEqual({
        mode: "form",
        form: {
          fields: [
            {
              key: "target",
              label: "Target",
              type: PLAYBOOK_PARAM_FIELD_TYPE[type],
              required: true,
              help: "what to aim at",
            },
          ],
        },
      });
    }
  });

  it("an unlabelled param is humanized, never shown raw", () => {
    const ask = playbookParamAsk({ name: "outputTypes", type: "text" });
    expect(ask.mode === "form" && ask.form.fields[0]!.label).toBe(
      "Output types"
    );
  });

  it("choice with > 8 options → an enum field; with none → any text", () => {
    const many = Array.from({ length: 9 }, (_, i) => `o${i}`);
    const wide = playbookParamAsk({ name: "c", type: "choice", options: many });
    expect(wide.mode === "form" && wide.form.fields[0]).toMatchObject({
      type: "enum",
      constraints: { enum: many },
    });
    const open = playbookParamAsk({ name: "c", type: "choice" });
    expect(open.mode === "form" && open.form.fields[0]!.type).toBe("text");
  });

  it("an unknown type degrades to a text field (never dropped)", () => {
    const ask = playbookParamAsk({ name: "x", type: "colour" });
    expect(ask.mode === "form" && ask.form.fields[0]!.type).toBe("text");
  });

  it("every mapped ask parses through the ONE AskSchema, for every declared type", () => {
    for (const type of PLAYBOOK_PARAM_TYPES) {
      const ask = playbookParamAsk({
        name: "p",
        type,
        options: type === "choice" ? ["a", "b"] : undefined,
      });
      expect(AskSchema.safeParse(ask).success).toBe(true);
    }
  });
});

describe("provide references are row ids — a plaintext credential cannot parse", () => {
  it("connection and file refs must be uuids", () => {
    for (const ref of [
      { kind: "connection", connectionId: "sk_live_51Hplaintextsecret" },
      { kind: "file", fileId: "ghp_plaintexttoken" },
      { kind: "secret", vaultRef: "sk_live_51Hplaintextsecret" },
    ]) {
      expect(
        AskAnswerValueSchema.safeParse({ type: "provide", ref }).success
      ).toBe(false);
    }
    expect(
      AskAnswerValueSchema.safeParse({
        type: "provide",
        ref: {
          kind: "connection",
          connectionId: "123e4567-e89b-42d3-a456-426614174000",
        },
      }).success
    ).toBe(true);
  });

  it("a file answer names the file when the door resolved it, never its id", () => {
    const value = {
      type: "provide" as const,
      ref: {
        kind: "file" as const,
        fileId: "123e4567-e89b-42d3-a456-426614174000",
      },
    };
    const ask = {
      mode: "provide" as const,
      provide: { kind: "file" as const },
    };
    expect(summarizeAnswer(ask, value, null, { refName: "Q3 deck.pdf" })).toBe(
      'Attached "Q3 deck.pdf"'
    );
    expect(summarizeAnswer(ask, value)).toBe("Attached a file");
  });
});
