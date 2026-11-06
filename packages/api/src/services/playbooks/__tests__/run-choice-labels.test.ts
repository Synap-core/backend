/**
 * `distinctAgentLabels`: the ask never offers two options with one name
 * (founder's pod, 2026-11-05, finding 2288ffce: two "Claude Code", one per
 * computer, both awake). Each row rules out a rule the others would pass: a
 * unique name stays bare, a shared one carries its computer, an agent with no
 * computer says how the pod reaches it, and agents still alike get an ordinal.
 */
import { describe, expect, it } from "vitest";
import { distinctAgentLabels } from "../run-choice.js";

const agent = (
  agentUserId: string,
  name: string | null,
  computer: string | null,
  reach = "pull"
) => ({ agentUserId, name, computer, reach });

describe("distinctAgentLabels", () => {
  it("a name nobody else has stays bare, even with a computer", () => {
    const labels = distinctAgentLabels([
      agent("a", "Claude Code", "MacBook"),
      agent("b", "Codex", "devbox"),
    ]);
    expect([...labels.values()]).toEqual(["Claude Code", "Codex"]);
  });

  it("two agents with one name carry their computers (the founder's two Claude Codes)", () => {
    const labels = distinctAgentLabels([
      agent("7455fd94", "Claude Code", "MacBook"),
      agent("c340f738", "Claude Code", "devbox"),
    ]);
    expect(labels.get("7455fd94")).toBe("Claude Code · MacBook");
    expect(labels.get("c340f738")).toBe("Claude Code · devbox");
  });

  it("with no computer: a connector says how the pod reaches it, else No computer", () => {
    const labels = distinctAgentLabels([
      agent("a", "Claude Code", null, "dispatch"),
      agent("b", "Claude Code", null, "pull"),
      agent("c", "Claude Code", "MacBook"),
    ]);
    expect(labels.get("a")).toBe("Claude Code · Synap sends it work");
    expect(labels.get("b")).toBe("Claude Code · No computer");
    expect(labels.get("c")).toBe("Claude Code · MacBook");
  });

  it("still alike on the same computer: an ordinal, in roster order; every label distinct", () => {
    const labels = distinctAgentLabels([
      agent("a", "Claude Code", "MacBook"),
      agent("b", "Claude Code", "MacBook"),
      agent("c", null, null),
    ]);
    expect(labels.get("a")).toBe("Claude Code · MacBook");
    expect(labels.get("b")).toBe("Claude Code · MacBook (2)");
    expect(labels.get("c")).toBe("Agent");
    expect(new Set(labels.values()).size).toBe(labels.size);
  });
});
