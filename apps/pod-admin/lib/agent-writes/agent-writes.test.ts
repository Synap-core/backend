import { describe, expect, it } from "vitest";
import { AGENT_WRITE_MODE_LINE } from "@synap-core/types/agents";
import {
  AGENT_POSTURE_CHOICES,
  choiceFromKey,
  choiceMode,
  currentChoice,
  mayChangeWrites,
  postureChoices,
  writesSummary,
  type AgentWritesRead,
} from "./agent-writes";

const read = (over: Partial<AgentWritesRead> = {}): AgentWritesRead => ({
  writeMode: "pod-default",
  line: AGENT_WRITE_MODE_LINE["pod-default"],
  postures: { pod: null },
  podDefaultEnabled: true,
  ...over,
});

describe("how an agent's writes land: the three choices", () => {
  it("offers follow the pod default, create with undo and ask first, in that order", () => {
    expect(postureChoices(read()).map((c) => c.key)).toEqual([
      "pod-default",
      "create-with-undo",
      "ask-first",
    ]);
    expect(postureChoices(read()).map((c) => c.label)).toEqual([
      "Follows the pod default",
      "Creates with undo",
      "Asks first",
    ]);
  });

  it("marks the posture in force, and only it", () => {
    const choices = postureChoices(
      read({
        writeMode: "create-with-undo",
        line: AGENT_WRITE_MODE_LINE["create-with-undo"],
        postures: { pod: "create-with-undo" },
      })
    );
    expect(choices.filter((c) => c.selected).map((c) => c.value)).toEqual([
      "create-with-undo",
    ]);
  });

  it("says each choice's consequence for THIS pod: with the pod default off, following it asks for every change", () => {
    const on = postureChoices(read());
    expect(on[0]!.line).toBe(AGENT_WRITE_MODE_LINE["pod-default"]);
    expect(on[1]!.line).toBe(AGENT_WRITE_MODE_LINE["create-with-undo"]);
    expect(on[2]!.line).toBe(AGENT_WRITE_MODE_LINE["ask-first"]);

    const off = postureChoices(
      read({
        podDefaultEnabled: false,
        writeMode: "ask-first",
        line: AGENT_WRITE_MODE_LINE["ask-first"],
        postures: { pod: "ask-first" },
      })
    );
    expect(off[0]!.line).toBe(AGENT_WRITE_MODE_LINE["ask-first"]);
  });

  it("the chosen one says what the pod answers today, never a re-derivation", () => {
    const odd = "Creates and edits apply directly with Undo (an older agent).";
    expect(postureChoices(read({ line: odd }))[0]!.line).toBe(odd);
  });

  it("a posture the pod does not name reads as none, never as a preset", () => {
    expect(currentChoice(read({ postures: { pod: "something-new" } }))).toBe(
      null
    );
  });

  it("a radio value goes back to the choice setPosture takes", () => {
    for (const c of AGENT_POSTURE_CHOICES)
      expect(choiceFromKey(choiceMode(c))).toBe(c);
    expect(choiceFromKey("act-freely")).toBe(null);
  });
});

describe("a row's summary", () => {
  it("is the choice's name and the pod's own sentence", () => {
    expect(
      writesSummary(
        read({
          writeMode: "ask-first",
          line: AGENT_WRITE_MODE_LINE["ask-first"],
          postures: { pod: "ask-first" },
        })
      )
    ).toEqual({
      label: "Asks first",
      line: AGENT_WRITE_MODE_LINE["ask-first"],
    });
  });
});

describe("who may change it (the server's gate)", () => {
  it("the person who connected the agent, or a pod admin", () => {
    expect(
      mayChangeWrites({
        viewerId: "u1",
        creatorId: "u1",
        viewerIsPodAdmin: false,
      })
    ).toBe(true);
    expect(
      mayChangeWrites({
        viewerId: "u2",
        creatorId: "u1",
        viewerIsPodAdmin: true,
      })
    ).toBe(true);
  });

  it("nobody else, and never on a missing id", () => {
    expect(
      mayChangeWrites({
        viewerId: "u2",
        creatorId: "u1",
        viewerIsPodAdmin: false,
      })
    ).toBe(false);
    expect(
      mayChangeWrites({
        viewerId: null,
        creatorId: null,
        viewerIsPodAdmin: false,
      })
    ).toBe(false);
  });
});
