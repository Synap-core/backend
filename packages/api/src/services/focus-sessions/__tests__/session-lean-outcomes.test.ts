/**
 * The lean outcomes carry WHOSE each outcome is and whether it was WITHDRAWN.
 *
 * Why: a worker claims the one open deliverable an agent owns when its run
 * ends `done` (synap-cli `verdictClaim`). Since the reply cap (backend#906) it
 * can only read the lean session (the full read is over the cap), and without
 * `owner` and `retired` it could claim a person's slot or a withdrawn one.
 */
import { describe, expect, it } from "vitest";
import { projectLeanOutcomes } from "../session-lean.js";

type Section = Parameters<typeof projectLeanOutcomes>[0];

const outcome = (key: string, owner: "agent" | "human", retired: boolean) => ({
  key,
  label: key,
  kind: "document",
  owner,
  met: false,
  retired,
  state: { state: "open" },
});

describe("projectLeanOutcomes", () => {
  it("keeps owner and retired on every outcome", () => {
    const lean = projectLeanOutcomes({
      status: "ok",
      counts: { met: 0, total: 3 },
      outcomes: [
        outcome("mine", "agent", false),
        outcome("theirs", "human", false),
        outcome("dropped", "agent", true),
      ],
      inputs: [],
    } as unknown as Section);
    if (lean.status !== "ok") throw new Error("unavailable");
    expect(lean.outcomes.map((o) => [o.key, o.owner, o.retired])).toEqual([
      ["mine", "agent", false],
      ["theirs", "human", false],
      ["dropped", "agent", true],
    ]);
  });
});
