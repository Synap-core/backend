/**
 * An optional declared param left unanswered must not leak `{name}` into the
 * agent's prompt; an undeclared `{name}` keeps its braces as before.
 */
import { describe, expect, it } from "vitest";
import {
  resolveGoal,
  withDeclaredParamsDefaulted,
} from "./playbook-lifecycle.js";

describe("goal: declared-but-unanswered params", () => {
  const declared = [
    { name: "client", type: "entity" },
    { name: "programName", type: "text" },
  ] as never;

  it("renders an unanswered declared param as empty text", () => {
    const goal = resolveGoal(
      "Propose {programName} for {client}.",
      withDeclaredParamsDefaulted(declared, { client: "Acme" })
    );
    expect(goal).toBe("Propose  for Acme.");
    expect(goal).not.toContain("{programName}");
  });

  it("leaves an undeclared name's braces alone", () => {
    const goal = resolveGoal(
      "Use {unknownThing}.",
      withDeclaredParamsDefaulted(declared, {})
    );
    expect(goal).toContain("{unknownThing}");
  });
});
