import { describe, it, expect } from "vitest";
import { summarizeMarketInstall } from "./market-preflight.js";

describe("summarizeMarketInstall", () => {
  it("capability: names the container, its tools and skills, its params and vault", () => {
    const s = summarizeMarketInstall("capability", {
      key: "gmail",
      name: "Gmail",
      tools: [{ name: "send" }, { name: "read" }],
      skills: [{ name: "triage" }],
      params: [
        { name: "apiKey", label: "API key", required: true },
        { name: "region", default: "eu" },
      ],
      vault: [{ ref: "k", name: "Gmail key", value: "{{apiKey}}" }],
    });
    expect(s.workspace).toBe("optional");
    expect(s.adds).toEqual([
      { kind: "capability", names: ["Gmail"] },
      { kind: "tool", names: ["send", "read"] },
      { kind: "skill", names: ["triage"] },
    ]);
    expect(s.params).toEqual([
      {
        name: "apiKey",
        label: "API key",
        description: null,
        required: true,
        hasDefault: false,
        secret: true,
      },
      {
        name: "region",
        label: null,
        description: null,
        required: false,
        hasDefault: true,
        secret: false,
      },
    ]);
    expect(s.notices).toEqual(["Stores 1 secret in this pod's vault."]);
  });

  it("capability: reads a package-shaped definition nested under `capability`", () => {
    const s = summarizeMarketInstall("capability", {
      profiles: [],
      capability: { name: "Stripe", tools: [], skills: [] },
    });
    expect(s.adds).toEqual([{ kind: "capability", names: ["Stripe"] }]);
  });

  it("skill: unwraps `skill` and says a code skill starts switched off", () => {
    const s = summarizeMarketInstall("skill", {
      skill: { name: "Summarize", kind: "code" },
    });
    expect(s.adds).toEqual([{ kind: "skill", names: ["Summarize"] }]);
    expect(s.notices[0]).toMatch(/switched off/);
    expect(
      summarizeMarketInstall("skill", { name: "Brief", kind: "instruction" })
        .notices
    ).toEqual([]);
  });

  it("automation: needs a space and says how many run by themselves", () => {
    const s = summarizeMarketInstall("automation", {
      automations: [
        { name: "Nightly digest", triggerType: "cron" },
        { name: "On demand", triggerType: "manual" },
      ],
    });
    expect(s.workspace).toBe("required");
    expect(s.adds).toEqual([
      { kind: "automation", names: ["Nightly digest", "On demand"] },
    ]);
    expect(s.notices).toEqual([
      "1 of them runs by itself — on a schedule, an event or a webhook.",
    ]);
  });

  it("view: lists every view of a pack, or the single top-level view", () => {
    expect(
      summarizeMarketInstall("view", {
        views: [{ name: "Board" }, { name: "Calendar" }],
      }).adds
    ).toEqual([{ kind: "view", names: ["Board", "Calendar"] }]);
    expect(
      summarizeMarketInstall("view", { name: "Board", type: "kanban" }).adds
    ).toEqual([{ kind: "view", names: ["Board"] }]);
  });

  it("cell: discloses declared outside sites, and says nothing when none are declared", () => {
    expect(
      summarizeMarketInstall("cell", {
        name: "Chart",
        externalHosts: ["api.example.com"],
      }).notices
    ).toEqual([
      "It declares these outside sites it may reach: api.example.com.",
    ]);
    expect(summarizeMarketInstall("cell", { name: "Chart" }).notices).toEqual(
      []
    );
  });

  it("template: creates its space and lists the living layers, not profiles", () => {
    const s = summarizeMarketInstall("template", {
      workspaceName: "CRM",
      profiles: [{ slug: "deal" }],
      views: [{ name: "Pipeline" }],
      playbooks: [{ name: "Weekly review" }],
      automations: [],
    });
    expect(s.workspace).toBe("creates");
    expect(s.adds).toEqual([
      { kind: "view", names: ["Pipeline"] },
      { kind: "playbook", names: ["Weekly review"] },
    ]);
  });
});
