/**
 * A by-name playbook_run node is stamped with its playbook's id at save (one
 * link per relation, Process wave W2), and only when the name names exactly
 * one visible playbook.
 */
import { describe, expect, it, vi } from "vitest";
import { stampPlaybookRunIds } from "./playbook-run-ids.js";

const node = (data: Record<string, unknown>, type = "playbook_run") => ({
  id: String(Math.random()),
  type,
  data,
});

describe("stampPlaybookRunIds", () => {
  it("stamps the id of the ONE visible playbook a name names, keeping the name", async () => {
    const flow = {
      nodes: [
        node({ label: "Run", playbookName: "Ship a change" }),
        node({ label: "Run", playbookName: "Twin" }),
        node({ label: "Run", playbookName: "Nowhere" }),
        node({
          label: "Run",
          playbookId: "pb-kept",
          playbookName: "Ship a change",
        }),
        node({ label: "Run", playbookName: "Ship a change" }, "skill"),
      ],
    };
    const lookup = vi.fn(async () => [
      { id: "pb-ship", name: "Ship a change" },
      { id: "pb-twin-1", name: "Twin" },
      { id: "pb-twin-2", name: "Twin" },
    ]);
    await stampPlaybookRunIds(flow, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(["Ship a change", "Twin", "Nowhere"]);
    expect(flow.nodes.map((n) => n.data.playbookId ?? null)).toEqual([
      "pb-ship", // one match → stamped
      null, // two matches → never a guess
      null, // no match → left for the validator
      "pb-kept", // an id already there wins
      null, // not a playbook_run node
    ]);
    expect(flow.nodes[0]!.data.playbookName).toBe("Ship a change");
  });

  it("reads nothing when no node names a playbook by name only", async () => {
    const lookup = vi.fn(async () => []);
    await stampPlaybookRunIds(
      { nodes: [node({ label: "Run", playbookId: "pb-1" })] },
      lookup
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
