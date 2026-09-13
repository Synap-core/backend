import { describe, expect, it } from "vitest";
import {
  RETIRED_PROFILE_PROPERTIES,
  SYSTEM_PROFILE_PROPERTY_LINKS,
} from "@synap/database";
import {
  classifySchemaContract,
  summarizeSchemaContract,
  type ActiveProfileRow,
  type SystemLinkRow,
} from "./schema-contract.js";
import { summarizeGlobalHealth, type GlobalSignals } from "./global.js";

let n = 0;
const link = (
  profileSlug: string,
  defSlug: string,
  defWorkspaceId: string | null = null
): SystemLinkRow => ({
  profileId: `p-${profileSlug}`,
  profileSlug,
  propertyDefId: `d-${++n}`,
  defSlug,
  defWorkspaceId,
});

const row = (
  slug: string,
  scope: string,
  workspaceId: string | null = null,
  profileId = `${scope}-${slug}-${workspaceId ?? "pod"}`
): ActiveProfileRow => ({ profileId, slug, scope, workspaceId });

/** One active system row per seeded profile — no twins among themselves. */
const SYSTEM_ROWS = SYSTEM_PROFILE_PROPERTY_LINKS.map((l) =>
  row(l.profileSlug, "system")
);

describe("schema contract — the seed table it derives from", () => {
  it("is the seeder's real table, not an empty or stub import (non-vacuity)", () => {
    expect(SYSTEM_PROFILE_PROPERTY_LINKS.length).toBeGreaterThanOrEqual(15);
    const task = SYSTEM_PROFILE_PROPERTY_LINKS.find(
      (l) => l.profileSlug === "task"
    );
    expect(task?.propertySlugs.map((p) => p.slug)).toContain("status");
  });

  it("the current seed declares decisionStatus / researchStatus and NOT status on decision / research", () => {
    for (const [profile, own] of [
      ["decision", "decisionStatus"],
      ["research", "researchStatus"],
    ] as const) {
      const slugs = SYSTEM_PROFILE_PROPERTY_LINKS.find(
        (l) => l.profileSlug === profile
      )!.propertySlugs.map((p) => p.slug);
      expect(slugs).toContain(own);
      expect(slugs).not.toContain("status");
    }
  });
});

describe("classifySchemaContract — undeclared links and retirements", () => {
  it("flags a base link the seed does not declare; ignores declared links and workspace overlay defs (task-status)", () => {
    const signal = classifySchemaContract({
      activeProfiles: SYSTEM_ROWS,
      systemLinks: [
        link("task", "status"),
        link("decision", "decisionStatus"),
        link("decision", "status"),
        link("task", "task-status", "ws-builder"),
        link("task", "task-priority", "ws-builder"),
      ],
    });
    expect(signal.undeclaredLinks).toEqual([
      { profileSlug: "decision", propertySlug: "status" },
    ]);
  });

  it("marks a retirement PENDING when a fold-equal link is still present (`ek-type` for `ek_type`)", () => {
    const signal = classifySchemaContract({
      activeProfiles: SYSTEM_ROWS,
      systemLinks: [
        link("knowledge", "knowledgeForm"),
        link("knowledge", "ek-type"),
      ],
    });
    expect(
      signal.retirements.find(
        (r) => r.profileSlug === "knowledge" && r.propertySlug === "ek_type"
      )
    ).toEqual({
      profileSlug: "knowledge",
      propertySlug: "ek_type",
      state: "pending",
      linkedSlugs: ["ek-type"],
    });
  });

  it("marks AMBIGUOUS when two links fold to the entry, INERT when none, PROFILE_ABSENT when the kind is gone", () => {
    const signal = classifySchemaContract({
      activeProfiles: SYSTEM_ROWS.filter((r) => r.slug !== "research"),
      systemLinks: [link("knowledge", "ek_type"), link("knowledge", "ek-type")],
    });
    const state = (p: string, s: string) =>
      signal.retirements.find(
        (r) => r.profileSlug === p && r.propertySlug === s
      )?.state;
    expect(state("knowledge", "ek_type")).toBe("ambiguous");
    expect(state("decision", "status")).toBe("inert");
    expect(state("research", "status")).toBe("profile_absent");
    expect(signal.retirements).toHaveLength(RETIRED_PROFILE_PROPERTIES.length);
  });
});

describe("classifySchemaContract — twins and reserved rows (positive control, live pod shape)", () => {
  // Reproduces the 5 same-slug twins verified on the live pod 2026-09-13:
  // system+workspace (knowledge, campaign, document), shared+workspace role
  // (partner), and workspace+workspace (project, on a RESERVED slug).
  const LIVE_SHAPE: ActiveProfileRow[] = [
    ...SYSTEM_ROWS,
    row("knowledge", "workspace", "ws-pod-admin", "ff8924b2"),
    row("campaign", "system"),
    row("campaign", "workspace", "ws-crm", "8c3d9dde"),
    row("document", "system"),
    row("document", "workspace", "ws-crm", "3d118a1b"),
    row("partner", "shared", null, "7c7679b7"),
    row("partner", "workspace", "ws-crm", "13006be5"),
    row("project", "workspace", "ws-agent-fleet", "b1e46799"),
    row("project", "workspace", "ws-builder", "2b491c45"),
    // Singletons in every scope — never twins.
    row("lead", "workspace", "ws-crm"),
    row("vendor", "shared"),
  ];
  const signal = classifySchemaContract({
    activeProfiles: LIVE_SHAPE,
    systemLinks: [],
  });

  it("reports exactly the 5 twin slugs, across all three scope shapes", () => {
    expect(signal.twins.map((t) => t.slug)).toEqual([
      "campaign",
      "document",
      "knowledge",
      "partner",
      "project",
    ]);
  });

  it("reports the shared+workspace role twin with both rows", () => {
    const partner = signal.twins.find((t) => t.slug === "partner");
    expect(partner?.rows.map((r) => [r.scope, r.profileId])).toEqual([
      ["shared", "7c7679b7"],
      ["workspace", "13006be5"],
    ]);
  });

  it("reports the system+workspace twin with both rows", () => {
    const knowledge = signal.twins.find((t) => t.slug === "knowledge");
    expect(knowledge?.rows.map((r) => r.scope).sort()).toEqual([
      "system",
      "workspace",
    ]);
    expect(knowledge?.rows.map((r) => r.profileId)).toContain("ff8924b2");
  });

  it("lists every active row on a reserved slug (the two workspace `project` rows)", () => {
    expect(signal.reservedRows.map((r) => r.profileId)).toEqual([
      "b1e46799",
      "2b491c45",
    ]);
  });

  it("a pod with no same-slug rows and no reserved slugs reads zero of each", () => {
    const clean = classifySchemaContract({
      activeProfiles: SYSTEM_ROWS,
      systemLinks: [],
    });
    expect(clean.twins).toEqual([]);
    expect(clean.reservedRows).toEqual([]);
  });
});

describe("summarizeSchemaContract", () => {
  const empty = {
    undeclaredLinks: [],
    twins: [],
    reservedRows: [],
    retirements: [],
  };

  it("is honest-empty when nothing drifted", () => {
    const section = summarizeSchemaContract(empty);
    expect(section.key).toBe("schema_contract");
    expect(section.status).toBe("ok");
    expect(section.headline).toContain("matches the seed");
  });

  it("is attention (never degraded) and names each count", () => {
    const section = summarizeSchemaContract(
      classifySchemaContract({
        activeProfiles: [
          ...SYSTEM_ROWS,
          row("knowledge", "workspace", "ws-1"),
          row("project", "workspace", "ws-2"),
        ],
        systemLinks: [link("decision", "status")],
      })
    );
    expect(section.status).toBe("attention");
    expect(section.headline).toContain("1 base link(s)");
    expect(section.headline).toContain("1 slug(s) held by more than one");
    expect(section.headline).toContain(
      "1 active profile row(s) on a reserved slug"
    );
    expect(section.headline).toContain("1 retirement(s) not applied");
  });

  it("is emitted by the global report only when computed", () => {
    const clean: GlobalSignals = {
      stuckHours: 24,
      stuck: [],
      failedFlows: [],
      backlog: {
        pending: 0,
        oldestAgeHours: null,
        mineOutsideLens: 0,
        oldestAgeHoursIncludingOutsideLens: null,
      },
      duplicateClusters: [],
      capabilities: { enabled: 0, unapproved: 0 },
      agentActivity: [],
    };
    const without = summarizeGlobalHealth(clean, { workspaceId: null });
    expect(without.sections.some((s) => s.key === "schema_contract")).toBe(
      false
    );
    const withSignal = summarizeGlobalHealth(
      { ...clean, schemaContract: empty },
      { workspaceId: null }
    );
    expect(
      withSignal.sections.find((s) => s.key === "schema_contract")?.status
    ).toBe("ok");
  });
});
