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

  it("a linked project with zero seed entities is NOT a failure", () => {
    // Clean template install: uses-edge landed, entities: 0. layers[] is an
    // exception channel — `linked` with no seed rows is success, not an error.
    expect(
      summarizePostWorkspaceLayers({
        projectLink: { status: "linked", projectId: "p1", entities: 0 },
      })
    ).toEqual([]);
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
    // Comments merely DESCRIBING the convention are not producers.
    const lines = stripComments(src, "ts").split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/status:\s*"error"/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 6), i + 7).join("\n");
      const identified = /\b(key|name):/.test(window);
      // The two SCALAR bags carry one item each, so the bag key alone names it.
      const scalarBag =
        /result\.(agentMembership|projectLink|rules|skills)\s*=/.test(window);
      if (!identified && !scalarBag) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});

// ─── W3b: installedTrackTemplates ────────────────────────────────────────────
import { installedTrackTemplates } from "./install-layers.js";
import { stripComments } from "../../../../../scripts/strip-comments.mjs";

describe("installedTrackTemplates — the startable methods an install produced", () => {
  it("keeps project-scope playbooks with an id (created or reused), drops the rest", () => {
    const bag = {
      playbooks: [
        {
          name: "Grant Process",
          status: "created",
          playbookId: "p1",
          scope: "project",
        },
        {
          name: "Old Method",
          status: "reused",
          playbookId: "p2",
          scope: "project",
        },
        {
          name: "Digest",
          status: "created",
          playbookId: "p3",
          scope: "session",
        },
        {
          name: "Queued",
          status: "proposed",
          proposalId: "x",
          scope: "project",
        },
        { name: "Broken", status: "error", message: "boom" },
      ],
    };
    expect(installedTrackTemplates(bag)).toEqual([
      { playbookId: "p1", name: "Grant Process" },
      { playbookId: "p2", name: "Old Method" },
    ]);
  });

  it("[] for an absent / non-array bag", () => {
    expect(installedTrackTemplates(undefined)).toEqual([]);
    expect(installedTrackTemplates({ playbooks: "nope" })).toEqual([]);
  });
});

describe("the tRPC template doors offer every track template their layer 2 made startable", () => {
  // Since W3 `createFromDefinition` / `installFromCatalog` / `applyDefinition`
  // apply through the ONE template apply, and ONE reply mapping reads its
  // layer-2 bag (`templateDoorReply`, routers/workspaces/template-door.ts).
  // This used to count `applyPackagePostWorkspace(` vs
  // `installedTrackTemplates(` inside the procedure body, one per branch; the
  // branches are gone (`definition-engine.install-layers.tripwire.test.ts`
  // pins that the engine applies no bag itself), so assert the mapping.
  const base = {
    workspaceId: "ws-1",
    outcome: "created",
    materializeStatus: "created",
    dependencies: [],
    finished: null,
    warning: null,
  };
  const bag = {
    playbooks: [
      {
        name: "Grant Process",
        status: "created",
        playbookId: "p1",
        scope: "project",
      },
    ],
  };

  it("an applied layer 2's project-scope playbooks reach the reply", async () => {
    const { templateDoorReply } =
      await import("../../routers/workspaces/template-door.js");
    const reply = templateDoorReply({
      ...base,
      layer2: { status: "applied", post: bag },
    } as never);
    expect(reply.trackTemplates).toEqual(installedTrackTemplates(bag));
    expect(reply.trackTemplates).toEqual([
      { playbookId: "p1", name: "Grant Process" },
    ]);
  });

  it("no layer 2 (skipped / failed) → [] (a failure is `layers`' fact)", async () => {
    const { templateDoorReply } =
      await import("../../routers/workspaces/template-door.js");
    for (const layer2 of [
      { status: "skipped" },
      { status: "failed", error: new Error("x") },
    ])
      expect(
        templateDoorReply({ ...base, layer2 } as never).trackTemplates
      ).toEqual([]);
  });
});
