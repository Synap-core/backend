import { describe, expect, it } from "vitest";
import {
  AGENT_WRITE_MODE_CHOICES,
  AGENT_WRITE_MODE_LINE,
} from "@synap-core/types/agents";
import {
  currentWriteMode,
  decidingComputer,
  mayChangeWrites,
  writeModeLabel,
  writeModeLines,
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

describe("how an agent's writes land: THE choices (AGENT_WRITE_MODE_CHOICES)", () => {
  it("names each choice from the one list, never a local map", () => {
    for (const c of AGENT_WRITE_MODE_CHOICES)
      expect(writeModeLabel(c.mode)).toBe(c.label);
    // No posture of its own = it follows the pod default.
    expect(writeModeLabel(null)).toBe(
      AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === "pod-default")!.label
    );
  });

  it("an unknown posture humanizes, never leaks", () => {
    expect(writeModeLabel("act-freely")).not.toContain("-");
  });

  it("the choice in force is the stored posture; none is the pod default", () => {
    expect(currentWriteMode(read())).toBe("pod-default");
    expect(
      currentWriteMode(read({ postures: { pod: "create-with-undo" } }))
    ).toBe("create-with-undo");
    expect(currentWriteMode(read({ postures: { pod: "ask-first" } }))).toBe(
      "ask-first"
    );
  });

  it("a posture the pod does not name reads as none, never as a preset", () => {
    expect(currentWriteMode(read({ postures: { pod: "something-new" } }))).toBe(
      "pod-default"
    );
  });

  it("says each choice's consequence for THIS pod: with the pod default off, following it asks for every change", () => {
    const on = writeModeLines(read());
    for (const c of AGENT_WRITE_MODE_CHOICES) expect(on[c.mode]).toBe(c.line);

    const off = writeModeLines(
      read({
        podDefaultEnabled: false,
        writeMode: "ask-first",
        line: AGENT_WRITE_MODE_LINE["ask-first"],
        postures: { pod: "ask-first" },
      })
    );
    expect(off["pod-default"]).toBe(AGENT_WRITE_MODE_LINE["ask-first"]);
    expect(off["create-with-undo"]).toBe(
      AGENT_WRITE_MODE_LINE["create-with-undo"]
    );
  });

  it("the chosen one says what the pod answers today, never a re-derivation", () => {
    const odd = "Creates and edits apply directly with Undo (an older agent).";
    expect(writeModeLines(read({ line: odd }))["pod-default"]).toBe(odd);
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
      label: AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === "ask-first")!
        .label,
      line: AGENT_WRITE_MODE_LINE["ask-first"],
      computer: null,
    });
  });

  // Finding 168956d8: Claude Code set to Normal on an ask-first Mac. Its own
  // choice is Normal; every create asks, because the Mac does.
  const onAskFirstComputer = read({
    writeMode: "pod-default",
    line: AGENT_WRITE_MODE_LINE["pod-default"],
    postures: { pod: null },
    effective: {
      writeMode: "ask-first",
      line: AGENT_WRITE_MODE_LINE["ask-first"],
      decidedBy: "computer",
      computer: { id: "c-1", name: "MacBook" },
    },
  });

  it("says what REALLY applies: the computer's mode when it is stricter", () => {
    expect(writesSummary(onAskFirstComputer)).toEqual({
      label: AGENT_WRITE_MODE_CHOICES.find((c) => c.mode === "ask-first")!
        .label,
      line: AGENT_WRITE_MODE_LINE["ask-first"],
      computer: { id: "c-1", name: "MacBook" },
    });
    // The choice control still shows the agent's OWN choice.
    expect(currentWriteMode(onAskFirstComputer)).toBe("pod-default");
    expect(decidingComputer(onAskFirstComputer)).toEqual({
      id: "c-1",
      name: "MacBook",
      mode: "ask-first",
    });
  });

  it("names no computer when the agent's own side decides", () => {
    const own = read({
      effective: {
        writeMode: "pod-default",
        line: AGENT_WRITE_MODE_LINE["pod-default"],
        decidedBy: "pod-default",
        computer: { id: "c-1", name: "MacBook" },
      },
    });
    expect(decidingComputer(own)).toBeNull();
    expect(writesSummary(own).computer).toBeNull();
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
