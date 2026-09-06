import { describe, it, expect } from "vitest";
import { summarizePostWorkspaceLayers } from "./install-layers.js";

describe("summarizePostWorkspaceLayers", () => {
  it("reports nothing when the bag is absent or empty", () => {
    expect(summarizePostWorkspaceLayers(undefined)).toEqual([]);
    expect(summarizePostWorkspaceLayers(null)).toEqual([]);
    expect(summarizePostWorkspaceLayers({})).toEqual([]);
  });

  it("reports nothing when every item applied — an empty layers[] means 'nothing failed'", () => {
    const bag = {
      capabilities: [{ name: "gmail", status: "created" }],
      playbooks: [{ name: "triage", status: "reused" }],
      projectLink: { status: "linked", projectId: "p1", entities: 3 },
    };
    expect(summarizePostWorkspaceLayers(bag)).toEqual([]);
  });

  it("reports a FAILED post-workspace layer for a per-item error inside an array", () => {
    const bag = {
      capabilities: [
        { name: "gmail", status: "created" },
        { name: "slack", status: "error", message: "vault secret missing" },
      ],
    };
    const layers = summarizePostWorkspaceLayers(bag);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layer).toBe("post-workspace");
    expect(layers[0]?.status).toBe("failed");
    expect(layers[0]?.message).toContain("capabilities:slack");
    expect(layers[0]?.message).toContain("vault secret missing");
  });

  it("reports a per-item error on a NON-array bag entry (agentMembership, projectLink)", () => {
    const bag = {
      projectLink: { status: "error", message: "no such project" },
    };
    const layers = summarizePostWorkspaceLayers(bag);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.message).toContain("projectLink");
    expect(layers[0]?.message).toContain("no such project");
  });

  it("aggregates every failure into ONE layer entry and counts them", () => {
    const bag = {
      capabilities: [
        { name: "a", status: "error", message: "x" },
        { name: "b", status: "error", message: "y" },
      ],
      cells: [{ key: "c", status: "error", message: "z" }],
    };
    const layers = summarizePostWorkspaceLayers(bag);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.message).toContain("3 item(s) failed");
  });

  it("does not mistake a status that merely CONTAINS 'error' for an error", () => {
    // `status` is compared for EQUALITY, not substring — an item legitimately
    // reporting e.g. "error-handler-installed" must not trip the summary.
    const bag = { cells: [{ key: "c", status: "error-handler-installed" }] };
    expect(summarizePostWorkspaceLayers(bag)).toEqual([]);
  });

  it("tolerates a missing message rather than emitting 'undefined'", () => {
    const bag = { skills: [{ name: "s", status: "error" }] };
    const layers = summarizePostWorkspaceLayers(bag);
    expect(layers[0]?.message).toContain("skills:s: failed");
    expect(layers[0]?.message).not.toContain("undefined");
  });
});

describe("summarizePostWorkspaceLayers — the identifier lives under two keys", () => {
  it("names a failed item by `key` (capabilities / loops / cells write that, not `name`)", () => {
    // The regression this pins: `describe()` read only `item.name`, so three
    // failed capabilities rendered three identical `"capabilities: <msg>"`
    // lines and the operator could not tell which one failed.
    const [layer] = summarizePostWorkspaceLayers({
      capabilities: [
        { key: "gmail_send", status: "error", message: "boom" },
        { key: "exa_api", status: "error", message: "nope" },
      ],
    });
    expect(layer!.message).toContain("capabilities:gmail_send: boom");
    expect(layer!.message).toContain("capabilities:exa_api: nope");
  });

  it("prefers `name` when a producer writes both", () => {
    const [layer] = summarizePostWorkspaceLayers({
      automations: [{ name: "Nightly", key: "k", status: "error" }],
    });
    expect(layer!.message).toContain("automations:Nightly: failed");
  });
});

describe("install-layers ↔ applier identifier parity (source scan)", () => {
  it('every `status:"error"` producer writes an identifier this module reads', async () => {
    // A source scan, not a fixture: the interface was written from ONE producer
    // and asserted over seven. A new bag that identifies its items under, say,
    // `slug` would render as a bare bag name here and nobody would notice.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "package-apply-post-workspace.ts"),
      "utf8"
    );
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/status:\s*"error"/.test(line)) return;
      // Comments merely DESCRIBING the convention are not producers.
      if (line.trimStart().startsWith("//")) return;
      const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      const identified = /\b(key|name):/.test(window);
      // The two SCALAR bags carry one item each, so the bag key alone names it.
      const scalarBag = /result\.(agentMembership|projectLink)\s*=/.test(
        window
      );
      if (!identified && !scalarBag) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
