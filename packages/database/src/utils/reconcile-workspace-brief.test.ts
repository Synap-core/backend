/**
 * SEAM test: the REAL `reconcileWorkspaceFromDefinition` drives the space
 * brief's three-way stamp through the REAL `WorkspaceRepository.replaceSpaceBrief`
 * against a mocked `client-pg`. Nothing between the definition and the captured
 * SQL write is hand-built — the assertions read the JSON the door would merge
 * into `settings`, so deleting section 1b (or its identity gate, or the CAS)
 * fails here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let liveSettings: Record<string, unknown> = {};
let casMatches = true;
const writes: Array<{ patch: Record<string, unknown>; whereSql: string }> = [];

/** Pull the JSON params and SQL text out of a drizzle `sql` object. */
function flatten(node: unknown, params: string[], text: string[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    params.push(node);
    return;
  }
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) {
    for (const c of n.queryChunks) flatten(c, params, text);
    return;
  }
  if (Array.isArray(n.value)) text.push((n.value as string[]).join(""));
}

vi.mock("../client-pg.js", () => {
  const db = {
    query: {
      workspaces: {
        findFirst: async () => ({ id: "ws-1", settings: liveSettings }),
      },
      views: { findMany: async () => [] },
      relationDefs: {
        findMany: async () => [],
        findFirst: async () => undefined,
      },
      intelligenceCommands: { findMany: async () => [] },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: (w: unknown) => {
          const params: string[] = [];
          const text: string[] = [];
          flatten(v.settings, params, text);
          const whereParams: string[] = [];
          const whereText: string[] = [];
          flatten(w, whereParams, whereText);
          for (const p of params) {
            try {
              writes.push({
                patch: JSON.parse(p) as Record<string, unknown>,
                whereSql: whereText.join(" "),
              });
            } catch {
              /* not JSON */
            }
          }
          const isCas = whereText.join(" ").includes("onboarding");
          const rows =
            casMatches || !isCas ? [{ id: "ws-1", settings: {} }] : [];
          const p = Promise.resolve(rows) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>;
          };
          p.returning = async () => rows;
          return p;
        },
      }),
    }),
  };
  return { getDb: async () => db, sql: {} };
});
vi.mock("../repositories/event-repository.js", () => ({
  EventRepository: class {
    async append() {}
  },
}));
vi.mock("./workspace-client-projection.js", () => ({
  projectWorkspaceSettings: (w: unknown) => w,
}));

const { reconcileWorkspaceFromDefinition } =
  await import("./reconcile-workspace-from-definition.js");
const { hashBriefField } = await import("./space-brief-seed.js");

const TEMPLATE = {
  goal: "Capture the brand",
  framing: "THE BRAND STRATEGIST",
  purpose: "Brand source of truth",
};

const briefWrite = () =>
  writes.find((w) => "onboarding" in w.patch || "onboardingSeed" in w.patch);

beforeEach(() => {
  writes.length = 0;
  casMatches = true;
});

describe("reconcile — space brief three-way stamp (seam)", () => {
  it("an EXISTING space with NO brief gets one, stamped", async () => {
    liveSettings = {};
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId: "ws-1",
      userId: "u-1",
      definition: { workspaceSubtype: "brand-library", onboarding: TEMPLATE },
    });
    const w = briefWrite();
    expect(w?.patch.onboarding).toEqual(TEMPLATE);
    expect(
      (w?.patch.onboardingSeed as { fields: Record<string, string> }).fields
    ).toEqual({
      goal: hashBriefField(TEMPLATE.goal),
      framing: hashBriefField(TEMPLATE.framing),
      purpose: hashBriefField(TEMPLATE.purpose),
    });
    // The CAS guards on "there was no brief".
    expect(w?.whereSql).toContain("IS NULL");
    expect(report.brief?.outcomes).toEqual({
      goal: "written",
      framing: "written",
      purpose: "written",
    });
  });

  it("a user-edited field is never overwritten; the conflict is reported", async () => {
    liveSettings = {
      onboarding: { ...TEMPLATE, framing: "My own voice" },
      onboardingSeed: {
        v: 1,
        fields: {
          goal: hashBriefField(TEMPLATE.goal),
          framing: hashBriefField(TEMPLATE.framing),
          purpose: hashBriefField(TEMPLATE.purpose),
        },
      },
    };
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId: "ws-1",
      userId: "u-1",
      definition: {
        workspaceSubtype: "brand-library",
        onboarding: { ...TEMPLATE, framing: "Template v2", goal: "Goal v2" },
      },
    });
    const w = briefWrite();
    expect((w?.patch.onboarding as { framing: string }).framing).toBe(
      "My own voice"
    );
    expect((w?.patch.onboarding as { goal: string }).goal).toBe("Goal v2");
    expect(report.brief?.conflicts).toEqual([
      { field: "framing", reason: "edited" },
    ]);
  });

  it("a compose overlay (no subtype, no identity) never touches the brief", async () => {
    liveSettings = {};
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId: "ws-1",
      userId: "u-1",
      definition: { onboarding: TEMPLATE },
    });
    expect(briefWrite()).toBeUndefined();
    expect(report.brief).toBeUndefined();
  });

  it("a lost compare-and-set is reported, not retried blindly", async () => {
    liveSettings = {};
    casMatches = false;
    const report = await reconcileWorkspaceFromDefinition({
      workspaceId: "ws-1",
      userId: "u-1",
      definition: { workspaceSubtype: "brand-library", onboarding: TEMPLATE },
    });
    expect(report.brief?.raced).toBe(true);
  });
});
