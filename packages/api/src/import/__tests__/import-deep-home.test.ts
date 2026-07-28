import { describe, it, expect } from "vitest";
import {
  matchWorkspaceFromPath,
  resolveItemHome,
  deepStructureImportItems,
  type StructureCapableClient,
} from "../import-deep.js";
import type { ImportItem } from "../import-items.js";

const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";
const WS_LONG = "33333333-3333-3333-3333-333333333333";

const available = [
  { id: WS_A, name: "Alpha Home" },
  { id: WS_B, name: "Beta" },
  { id: WS_LONG, name: "Beta Extended" },
];

describe("matchWorkspaceFromPath", () => {
  it("matches a path segment case-insensitively", () => {
    expect(
      matchWorkspaceFromPath(
        { path: ["notes", "alpha home", "x"], title: "x" },
        available
      )
    ).toBe(WS_A);
  });

  it("prefers longer workspace names when both could match segments", () => {
    // "Beta Extended" is longer than "Beta" — wins when both present as segments.
    expect(
      matchWorkspaceFromPath(
        { path: ["Beta", "Beta Extended"], title: "n" },
        available
      )
    ).toBe(WS_LONG);
  });

  it("matches title path-like segments", () => {
    expect(
      matchWorkspaceFromPath(
        { path: [], title: "Alpha Home / Meeting notes" },
        available
      )
    ).toBe(WS_A);
  });

  it("returns undefined when no segment matches", () => {
    expect(
      matchWorkspaceFromPath({ path: ["misc"], title: "orphan" }, available)
    ).toBeUndefined();
  });
});

describe("resolveItemHome", () => {
  it("uses structure targetWorkspaceId when in availableWorkspaces", () => {
    expect(
      resolveItemHome(
        { path: ["Alpha Home"], title: "t" },
        { targetWorkspaceId: WS_B },
        available
      )
    ).toEqual({ targetWorkspaceId: WS_B });
  });

  it("ignores unknown structure workspace id and falls back to path", () => {
    expect(
      resolveItemHome(
        { path: ["Alpha Home"], title: "t" },
        { targetWorkspaceId: "00000000-0000-0000-0000-000000000000" },
        available
      )
    ).toEqual({ targetWorkspaceId: WS_A });
  });

  it("stamps projectId only when structure supplies it", () => {
    const projectId = "44444444-4444-4444-4444-444444444444";
    expect(
      resolveItemHome(
        { path: [], title: "t" },
        { targetProjectId: projectId },
        available
      )
    ).toEqual({ projectId });
  });

  it("omits home when no signals", () => {
    expect(resolveItemHome({ path: [], title: "t" }, {}, available)).toEqual(
      {}
    );
  });
});

function item(partial: Partial<ImportItem> & { title: string }): ImportItem {
  return {
    path: [],
    metadata: {},
    body: "body text",
    links: [],
    labels: [],
    ...partial,
  };
}

describe("deepStructureImportItems multi-home stamping", () => {
  it("stamps create_entity + provenance with structure home; first wins on dup", async () => {
    const client: StructureCapableClient = {
      async structure({ text }) {
        if (text.includes("NOTE_A")) {
          return {
            entities: [
              {
                tempId: "t1",
                profileSlug: "task",
                title: "Shared Task",
                confidence: 0.9,
              },
            ],
            relations: [],
            targetWorkspaceId: WS_A,
            targetProjectId: "55555555-5555-5555-5555-555555555555",
          };
        }
        // Second note extracts the same entity but routes to WS_B — first wins.
        return {
          entities: [
            {
              tempId: "t1",
              profileSlug: "task",
              title: "Shared Task",
              confidence: 0.9,
            },
          ],
          relations: [],
          targetWorkspaceId: WS_B,
        };
      },
    };

    const result = await deepStructureImportItems(
      [
        item({ title: "Note A", body: "NOTE_A content", path: [] }),
        item({ title: "Note B", body: "NOTE_B content", path: ["Beta"] }),
      ],
      client,
      {
        validSlugs: new Set(["task", "note"]),
        availableWorkspaces: available,
      },
      { logger: { warn: () => {} } }
    );

    const creates = result.operations.filter((o) => o.op === "create_entity");
    const shared = creates.find((o) => o.title === "Shared Task");
    expect(shared?.targetWorkspaceId).toBe(WS_A);
    expect(shared?.projectId).toBe("55555555-5555-5555-5555-555555555555");

    const srcA = creates.find((o) => o.ref === "src0");
    expect(srcA?.targetWorkspaceId).toBe(WS_A);
    expect(srcA?.projectId).toBe("55555555-5555-5555-5555-555555555555");

    // Provenance for note B still gets B's home (path heuristic / structure).
    const srcB = creates.find((o) => o.ref === "src1");
    expect(srcB?.targetWorkspaceId).toBe(WS_B);

    expect(result.stats.duplicatesMerged).toBe(1);
    expect(result.stats.homesByWorkspace[WS_A]).toBeGreaterThanOrEqual(2); // src0 + shared
    expect(result.stats.homesByWorkspace[WS_B]).toBe(1); // src1 only
  });

  it("path-heuristic homes when structure omits workspace", async () => {
    const client: StructureCapableClient = {
      async structure() {
        return {
          entities: [
            {
              tempId: "t1",
              profileSlug: "note",
              title: "From Path",
              confidence: 1,
            },
          ],
          relations: [],
        };
      },
    };

    const result = await deepStructureImportItems(
      [item({ title: "x", body: "hello", path: ["Alpha Home", "inbox"] })],
      client,
      {
        validSlugs: new Set(["note"]),
        availableWorkspaces: available,
        includeProvenance: false,
      },
      { logger: { warn: () => {} } }
    );

    const ent = result.operations.find(
      (o) => o.op === "create_entity" && o.title === "From Path"
    );
    expect(ent && ent.op === "create_entity" && ent.targetWorkspaceId).toBe(
      WS_A
    );
    expect(result.stats.homesByWorkspace[WS_A]).toBe(1);
    expect(result.stats.homesByWorkspace.podWide).toBeUndefined();
  });

  it("keeps pod-wide when no signals", async () => {
    const client: StructureCapableClient = {
      async structure() {
        return {
          entities: [
            {
              tempId: "t1",
              profileSlug: "note",
              title: "Lonely",
              confidence: 1,
            },
          ],
          relations: [],
        };
      },
    };

    const result = await deepStructureImportItems(
      [item({ title: "x", body: "hello", path: [] })],
      client,
      {
        validSlugs: new Set(["note"]),
        availableWorkspaces: available,
        includeProvenance: false,
      },
      { logger: { warn: () => {} } }
    );

    const ent = result.operations.find((o) => o.op === "create_entity");
    expect(ent?.op).toBe("create_entity");
    if (ent?.op === "create_entity") {
      expect(ent.targetWorkspaceId).toBeUndefined();
    }
    expect(result.stats.homesByWorkspace).toEqual({ podWide: 1 });
  });
});
