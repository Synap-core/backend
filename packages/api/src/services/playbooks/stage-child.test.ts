import { describe, expect, it } from "vitest";
import { stageChildWanted } from "./stage-child.js";

describe("stageChildWanted: the slots a `uses` step expects back", () => {
  it("maps each declared slot to the child's label; an optional slot is not required", () => {
    expect(
      stageChildWanted({
        expectedOutputs: [
          { label: "Final cut", kind: "file" },
          { label: "Thumbnail", kind: "file", optional: true },
        ],
        uses: {
          playbookId: "00000000-0000-4000-8000-000000000000",
          version: 1,
          outputs: { "Final cut": "Render" },
        },
      } as never)
    ).toEqual([
      { parentLabel: "Final cut", childLabel: "Render", required: true },
      { parentLabel: "Thumbnail", childLabel: "Thumbnail", required: false },
    ]);
  });
});
