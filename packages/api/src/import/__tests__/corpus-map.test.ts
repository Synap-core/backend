import { describe, it, expect } from "vitest";
import {
  buildCorpusMap,
  corpusMapToOperations,
  inferFolderIntent,
  orderItemsByCorpusMap,
  linkProvenanceToContainers,
} from "../corpus-map.js";

describe("inferFolderIntent", () => {
  it("tags Projects root as area", () => {
    expect(inferFolderIntent("5. Projects")).toBe("area");
    expect(inferFolderIntent("Projects")).toBe("area");
  });
  it("tags children of area as project", () => {
    expect(inferFolderIntent("WineSafe", "area")).toBe("project");
    expect(inferFolderIntent("Empire", "area")).toBe("project");
  });
  it("tags chapter under project", () => {
    expect(inferFolderIntent("Chapter 1", "project")).toBe("chapter");
  });
  it("tags journals and resources", () => {
    expect(inferFolderIntent("1. Daily")).toBe("journal");
    expect(inferFolderIntent("Z_Ressources")).toBe("resource");
  });
});

describe("buildCorpusMap + ops", () => {
  const items = [
    {
      path: "5. Projects/Started projects/WineSafe/notes.md",
      title: "notes.md",
    },
    { path: "5. Projects/Started projects/WineSafe/todo.md", title: "todo.md" },
    { path: "3. 2nd Brain/Mathematique/algebra.md", title: "algebra.md" },
    { path: "1. Daily/2023-01-01.md", title: "2023-01-01.md" },
  ];

  it("builds folder tree with intents", () => {
    const map = buildCorpusMap(items);
    const paths = map.folders.map((f) => f.path);
    expect(paths).toContain("5. Projects");
    expect(paths).toContain("5. Projects/Started projects/WineSafe");
    expect(map.folders.find((f) => f.path === "5. Projects")?.intent).toBe(
      "area"
    );
    expect(
      map.folders.find(
        (f) => f.path === "5. Projects/Started projects/WineSafe"
      )?.intent
    ).toBe("project");
    expect(
      map.fileToContainerPath["5. Projects/Started projects/WineSafe/notes.md"]
    ).toBe("5. Projects/Started projects/WineSafe");
  });

  it("emits containers before children with parent_of", () => {
    const map = buildCorpusMap(items);
    const { operations, containerRefByPath } = corpusMapToOperations(map);
    const creates = operations.filter((o) => o.op === "create_entity");
    const relations = operations.filter((o) => o.op === "create_relation");
    expect(creates.length).toBeGreaterThan(0);
    // First create should be area or high-priority container
    expect(creates[0]?.op).toBe("create_entity");
    if (creates[0]?.op === "create_entity") {
      expect(creates[0].properties?.isContainer).toBe(true);
    }
    expect(
      relations.some(
        (r) => r.op === "create_relation" && r.type === "parent_of"
      )
    ).toBe(true);
    expect(containerRefByPath["5. Projects"]).toBeTruthy();
  });

  it("orders project files before unrelated collections", () => {
    const map = buildCorpusMap(items);
    const ordered = orderItemsByCorpusMap(items, map);
    const wineIdx = ordered.findIndex((i) => i.path.includes("WineSafe"));
    const mathIdx = ordered.findIndex((i) => i.path.includes("Mathematique"));
    expect(wineIdx).toBeGreaterThanOrEqual(0);
    expect(mathIdx).toBeGreaterThanOrEqual(0);
    // project priority (20) before collection (40)
    expect(wineIdx).toBeLessThan(mathIdx);
  });

  it("links provenance src refs to containers", () => {
    const map = buildCorpusMap([
      { path: "5. Projects/WineSafe/a.md", title: "a.md" },
    ]);
    const { containerRefByPath } = corpusMapToOperations(map);
    const ops = [
      {
        op: "create_entity" as const,
        ref: "src0",
        profileSlug: "note",
        title: "a.md",
      },
    ];
    const links = linkProvenanceToContainers(
      ops,
      [{ path: "5. Projects/WineSafe/a.md", title: "a.md" }],
      map,
      containerRefByPath
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      op: "create_relation",
      type: "parent_of",
      targetRef: "src0",
    });
  });
});
