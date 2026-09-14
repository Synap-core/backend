/**
 * Size budget for the DEFAULT call of `synap_list_profiles` and
 * `synap_get_entities`, driven through the REAL handlers (`readHandlers`) with
 * only the data sources stubbed.
 *
 * WHY A BUDGET (measured on the live pod, 2026-09-14): the no-argument
 * `synap_list_profiles` — the call its own description says to make at session
 * start — returned 117,197 chars (117 profiles + 409 relation-type rows), and
 * `synap_get_entities {profileSlug:"note", limit:50}` returned 70,138. Claude
 * Code caps MCP tool output at ~25k tokens (≈ 60-100k chars of JSON depending
 * on tokenisation) and other clients are stricter, so an agent could not read
 * its own schema on call #1.
 *
 * BUDGET = 40,000 chars per default call on a pod THIS size (the fixture below
 * mirrors the live pod's counts and field lengths). It is not a hard protocol
 * limit; it is the "fits comfortably under the strictest common cap" line. A
 * pod several times larger will need paging — this test says when.
 *
 * Reachability, not shape: the lean output must still NAME every profile slug,
 * every relation slug valid for each lens, every entity id and every property
 * key. Non-vacuity: the fixture's `detail:'full'` output must exceed the budget
 * and carry the nulls / long values / systemData the lean path removes.
 *
 * WHAT THIS DOES NOT COVER: nested strings inside object/array property values
 * (passed through untouched), and a pod whose row COUNT (not length) exceeds
 * the budget — that is a paging problem, not a projection one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const BUDGET_CHARS = 40_000;

const { getUserMemberWorkspaceIds, listProfiles, listEffectiveRelationTypes } =
  vi.hoisted(() => ({
    getUserMemberWorkspaceIds: vi.fn(),
    listProfiles: vi.fn(),
    listEffectiveRelationTypes: vi.fn(),
  }));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds,
}));

vi.mock("../../../utils/relation-types.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/relation-types.js")
  >()),
  listEffectiveRelationTypes,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({})),
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";
import { ENTITY_STRING_CAP } from "./read-lean.js";

// ── Fixture: mirrors the live pod (117 profiles, 15 workspaces, 409+ relation
// rows of which 22 pod-wide; 50 notes with long bodies). Deterministic. ──────

const WS = Array.from(
  { length: 15 },
  (_, i) =>
    `0000000${i.toString(16)}-aaaa-4bbb-8ccc-${String(i).padStart(12, "0")}`
);
const uuid = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;
const words = (len: number, seed: string) =>
  `${seed} `.repeat(Math.ceil(len / (seed.length + 1))).slice(0, len);

const PROFILE_COUNT = 117;
const profileRows = Array.from({ length: PROFILE_COUNT }, (_, i) => {
  const isRole = i % 11 === 0;
  return {
    id: uuid(i + 1),
    slug: `kind-${i}`,
    displayName: `Kind Number ${i}`,
    entityScope: i % 3 === 0 ? "pod" : "workspace",
    scope: "shared",
    profileKind: isRole ? "role" : "kind",
    applicableKinds: isRole ? ["person", "company"] : null,
    // Live: min 9, median 68, max 151.
    uiHints: {
      icon: "sparkles",
      color: "#22aa88",
      description: words(40 + ((i * 37) % 112), `desc${i}`),
    },
    userId: i % 4 === 0 ? null : uuid(9000 + i),
    workspaceIdColumn: WS[i % WS.length],
    parentProfileId: null,
    defaultListRenderer: null,
    defaultDetailRenderer: null,
    defaultDashboardRenderer: null,
    defaultRenderers: { list: "table", detail: "entity-detail" },
    semanticSlug: `semantic-${i}`,
    plural: null,
    synonyms: null,
    roleCategory: null,
    aiPosture: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
});

const POD_SLUGS = Array.from({ length: 22 }, (_, i) => `pod_rel_${i}`);
const relRow = (slug: string, workspaceId: string | null) => ({
  slug,
  displayName: `Relation ${slug} display`,
  description: words(47, `about ${slug}`),
  isDirectional: slug.length % 2 === 0,
  inverseLabel: `inverse of ${slug}`,
  workspaceId,
});
/** Per workspace: 20 overrides of pod slugs + 6 slugs of its own. */
const wsOwnSlugs = (w: number) =>
  Array.from({ length: 6 }, (_, j) => `ws${w}_rel_${j}`);
function relationsForLens(lens: string | null) {
  if (lens === null) return POD_SLUGS.map((s) => relRow(s, null));
  const w = WS.indexOf(lens);
  const overridden = new Set(POD_SLUGS.slice(0, 20));
  return [
    ...POD_SLUGS.filter((s) => !overridden.has(s)).map((s) => relRow(s, null)),
    ...[...overridden].map((s) => relRow(s, lens)),
    ...wsOwnSlugs(w).map((s) => relRow(s, lens)),
  ].sort((a, b) => a.slug.localeCompare(b.slug));
}

const ENTITY_COUNT = 50;
const entityRows = Array.from({ length: ENTITY_COUNT }, (_, i) => {
  const long = i % 5 < 2; // 20 of 50 carry a long body (live max 5,537)
  const content = long
    ? words(900 + ((i * 331) % 4700), `note${i} body`)
    : words(120, `short${i}`);
  return {
    id: uuid(50_000 + i),
    userId: uuid(1),
    workspaceId: i % 2 ? WS[0] : null,
    profileId: uuid(1),
    type: "note",
    title: `Note ${i}`,
    preview: long ? content : null,
    documentId: i % 5 === 0 ? uuid(70_000 + i) : null,
    properties: {
      title: `Note ${i}`,
      content,
      tags: ["a", "b"],
      dueDate: null,
    },
    systemData: {},
    version: 1,
    createdByKind: "agent",
    createdByUserId: uuid(2),
    agentUserId: i % 2 ? uuid(3) : null,
    sourceProposalId: i % 3 ? uuid(80_000 + i) : null,
    correlationId: i % 3 ? null : uuid(90_000 + i),
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    deletedAt: null,
    profileSlug: "note",
    fileUrl: null,
    filePath: null,
    fileSize: null,
    fileType: null,
    checksum: null,
  };
});

const getEntities = vi.fn(async () => entityRows);

function ctx(toolName: string, args: Record<string, unknown>): McpToolContext {
  return {
    toolName,
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      profiles: { listProfiles },
      entities: { getEntities },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  };
}

async function call(
  tool: "synap_list_profiles" | "synap_get_entities",
  args: Record<string, unknown>
) {
  const res = await readHandlers[tool]!(ctx(tool, args));
  const block = res.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return { text: block.text, json: JSON.parse(block.text) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserMemberWorkspaceIds.mockResolvedValue([...WS]);
  listProfiles.mockImplementation(
    async ({ workspaceId }: { workspaceId: string }) => ({
      profiles: profileRows.filter((p) => p.workspaceIdColumn === workspaceId),
    })
  );
  listEffectiveRelationTypes.mockImplementation(
    async (_db: unknown, lens: string | null) => relationsForLens(lens)
  );
});

describe("synap_list_profiles — default digest fits the budget", () => {
  it("non-vacuity: detail:'full' reproduces the live overflow and carries what the digest drops", async () => {
    const full = await call("synap_list_profiles", { detail: "full" });
    expect(full.text.length).toBeGreaterThan(BUDGET_CHARS * 2);
    expect(full.json.profiles).toHaveLength(PROFILE_COUNT);
    expect(full.json.relationTypes.length).toBeGreaterThanOrEqual(400);
    const row = full.json.relationTypes[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        "description",
        "displayName",
        "inverseLabel",
        "isDirectional",
        "slug",
        "workspaceId",
      ].sort()
    );
    expect(full.json.profiles[0]).toHaveProperty("uiHints");
    expect(full.json.profiles[0]).toHaveProperty("defaultListRenderer", null);
    expect(full.json.detail).toBeUndefined();
  });

  it("the no-argument call is ≤ budget and still names every profile slug and every valid relation slug per lens", async () => {
    const lean = await call("synap_list_profiles", {});
    expect(lean.text.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(lean.json.detail).toBe("digest");
    expect(lean.json.note).toMatch(/detail:'full'/);

    const slugs = new Set(
      (lean.json.profiles as Array<{ slug: string }>).map((p) => p.slug)
    );
    expect(slugs).toEqual(new Set(profileRows.map((p) => p.slug)));
    const role = (lean.json.profiles as Array<Record<string, unknown>>).find(
      (p) => p.profileKind === "role"
    );
    expect(role?.applicableKinds).toEqual(["person", "company"]);
    for (const p of lean.json.profiles as Array<Record<string, unknown>>) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.workspaceId).toBe("string");
      expect(typeof p.description).toBe("string");
    }

    // Per lens: pod-wide ∪ that workspace's group === exactly the slugs the
    // full rows make valid there (what relations.create validates against).
    const full = await call("synap_list_profiles", { detail: "full" });
    const groups = lean.json.relationTypes as Array<{
      workspaceId: string | null;
      slugs: string[];
    }>;
    const pod = new Set(groups.find((g) => g.workspaceId === null)!.slugs);
    for (const ws of WS) {
      const expected = new Set(
        (
          full.json.relationTypes as Array<{
            slug: string;
            workspaceId: string | null;
          }>
        )
          .filter((r) => r.workspaceId === null || r.workspaceId === ws)
          .map((r) => r.slug)
      );
      const own = groups.find((g) => g.workspaceId === ws)?.slugs ?? [];
      expect(new Set([...pod, ...own])).toEqual(expected);
    }
  });
});

describe("synap_get_entities — default lean rows fit the budget", () => {
  it("non-vacuity: detail:'full' exceeds the budget and carries nulls, systemData and untruncated bodies", async () => {
    const full = await call("synap_get_entities", {
      profileSlug: "note",
      limit: 50,
      detail: "full",
    });
    expect(full.text.length).toBeGreaterThan(BUDGET_CHARS * 1.5);
    const longest = entityRows.reduce((a, b) =>
      a.properties.content.length > b.properties.content.length ? a : b
    );
    const row = (full.json.entities as Array<Record<string, unknown>>).find(
      (e) => e.id === longest.id
    )!;
    expect(row).toHaveProperty("systemData");
    expect(row).toHaveProperty("fileUrl", null);
    expect((row.properties as { content: string }).content).toBe(
      longest.properties.content
    );
    expect(longest.properties.content.length).toBeGreaterThan(
      ENTITY_STRING_CAP * 10
    );
  });

  it("the default call is ≤ budget, keeps every id and property key, and marks every cut", async () => {
    const lean = await call("synap_get_entities", {
      profileSlug: "note",
      limit: 50,
    });
    expect(lean.text.length).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(lean.json.detail).toBe("lean");
    expect(lean.json.note).toMatch(/synap_get_entity/);
    expect(lean.json.count).toBe(ENTITY_COUNT);

    const byId = new Map(
      (lean.json.entities as Array<Record<string, unknown>>).map((e) => [
        e.id as string,
        e,
      ])
    );
    expect(byId.size).toBe(ENTITY_COUNT);
    let cuts = 0;
    for (const src of entityRows) {
      const got = byId.get(src.id)!;
      expect(got).toBeDefined();
      expect(got).not.toHaveProperty("systemData");
      expect(got).not.toHaveProperty("fileUrl");
      const props = got.properties as Record<string, unknown>;
      expect(Object.keys(props).sort()).toEqual(
        Object.keys(src.properties).sort()
      );
      const content = props.content as string;
      if (src.properties.content.length > ENTITY_STRING_CAP) {
        cuts++;
        expect(
          content.startsWith(src.properties.content.slice(0, ENTITY_STRING_CAP))
        ).toBe(true);
        expect(content).toContain(
          `[truncated: ${src.properties.content.length} chars total]`
        );
      } else {
        expect(content).toBe(src.properties.content);
      }
    }
    expect(cuts).toBeGreaterThanOrEqual(20);
  });
});
