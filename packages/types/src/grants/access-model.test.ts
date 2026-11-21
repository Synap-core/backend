/**
 * accessModel / describeAccess — per tier, what and WHERE, and the one access
 * sentence. Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import {
  accessModel,
  describeAccess,
  GRANT_FULL_ACCESS_SENTENCE,
  type GrantDraft,
} from "./index.js";

const plural = (kind: string) => resolveObjectNounPlural(kind).toLowerCase();
const names = { s: "Sales", f: "Finance", o: "Ops" };
const g = (
  permissions: string[],
  workspaceIds: string[] | null
): GrantDraft => ({
  permissions,
  workspaceIds,
});
const say = (grants: GrantDraft[], holder: "app" | "key" | "agent" = "app") =>
  describeAccess(accessModel(grants, holder), { names }).sentence;

describe("accessModel — per tier, where", () => {
  // Rules out: one "where" for every tier (holder.ts before access model B).
  it("a change in Sales and a read in Finance stay in their own spaces", () => {
    const m = accessModel(
      [g(["entity.person.create"], ["s"]), g(["entity.note.read"], ["f"])],
      "app"
    );
    expect(m.tiers.change.map((r) => r.place)).toEqual([
      { kind: "spaces", ids: ["s"] },
    ]);
    expect(m.tiers.read.map((r) => r.place)).toEqual([
      { kind: "spaces", ids: ["f"] },
    ]);
    expect(
      say([g(["entity.person.create"], ["s"]), g(["entity.note.read"], ["f"])])
    ).toBe(
      `Reads ${plural("note")} in Finance; changes ${plural("person")} in Sales.`
    );
  });

  // Rules out: a label a wider place reaches said again for a narrower one.
  it("a pod-wide read covers the same read in a space", () => {
    expect(
      say([
        g(["entity.decision.read"], null),
        g(["entity.decision.read"], ["s"]),
      ])
    ).toBe(`Reads ${plural("decision")} everywhere in your pod.`);
  });

  it("spaces that reach the same things read as one place", () => {
    expect(
      say([g(["entity.note.read"], ["s"]), g(["entity.note.read"], ["f"])])
    ).toBe(`Reads ${plural("note")} in Sales and Finance.`);
    expect(
      say([
        g(["entity.note.read"], ["s"]),
        g(["entity.note.read"], ["f"]),
        g(["entity.note.read"], ["o"]),
      ])
    ).toBe(
      `Reads ${plural("note")} in 3 ${resolveObjectNounPlural("workspace").toLowerCase()}.`
    );
  });

  it("one place for every tier is said once, at the end; anywhere is not said", () => {
    expect(say([g(["entity.note"], ["s"])])).toBe(
      `Reads ${plural("note")}, changes ${plural("note")} in Sales.`
    );
    expect(say([g(["entity.note"], null)], "key")).toBe(
      `Reads ${plural("note")}, changes ${plural("note")}.`
    );
  });

  // Rules out: full access said as if it held everywhere when it is pinned.
  it("full access names its place unless it is anywhere", () => {
    expect(say([g(["*"], ["s"])], "key")).toBe(
      `${GRANT_FULL_ACCESS_SENTENCE} in Sales.`
    );
    expect(say([g(["*"], null)], "key")).toBe(`${GRANT_FULL_ACCESS_SENTENCE}.`);
  });

  it("no grant is no access", () => {
    expect(accessModel([], "app").state).toBe("nothing");
    expect(say([])).toBe("No access yet.");
  });

  it("each tier's places come in words, widest first", () => {
    const d = describeAccess(
      accessModel(
        [g(["entity.note.read"], ["s"]), g(["entity.decision.read"], null)],
        "app"
      ),
      { names }
    );
    expect(d.tiers.read.map((t) => [t.what, t.where])).toEqual([
      [plural("decision"), "Everywhere in your pod"],
      [plural("note"), "Sales"],
    ]);
    expect(d.tiers.change).toEqual([]);
  });
});

describe("accessModel — projects (app permissions W2)", () => {
  const pg = (permissions: string[], projectIds: string[]): GrantDraft => ({
    permissions,
    workspaceIds: null,
    projectIds,
  });
  const projectNames = { ...names, acme: "Acme", beta: "Beta" };
  const sayP = (grants: GrantDraft[], holder: "app" | "key" = "app") =>
    describeAccess(accessModel(grants, holder), { names: projectNames })
      .sentence;

  // Rules out: a project-pinned grant said with no place ("anywhere").
  it("a project grant says its project by name", () => {
    expect(sayP([pg(["entity.note.read"], ["acme"])])).toBe(
      `Reads ${plural("note")} in project Acme.`
    );
    expect(sayP([pg(["entity.note.read"], ["acme", "beta"])], "key")).toBe(
      `Reads ${plural("note")} in projects Acme and Beta.`
    );
  });

  it("an unnamed project is never its raw id", () => {
    expect(
      describeAccess(accessModel([pg(["entity.note.read"], ["zz"])], "app"))
        .sentence
    ).toBe(`Reads ${plural("note")} in a project.`);
  });

  // Rules out: a space and a project merged into one place (F3: a union).
  it("a space and a project are named apart", () => {
    expect(
      sayP([
        g(["entity.note.read"], ["s"]),
        pg(["entity.note.create"], ["acme"]),
      ])
    ).toBe(
      `Reads ${plural("note")} in Sales; changes ${plural("note")} in project Acme.`
    );
  });

  it("projects that reach the same things read as one place", () => {
    expect(
      sayP([
        pg(["entity.note.read"], ["acme"]),
        pg(["entity.note.read"], ["beta"]),
      ])
    ).toBe(`Reads ${plural("note")} in projects Acme and Beta.`);
  });

  it("full access in a space and a project names both", () => {
    expect(sayP([g(["*"], ["s"]), pg(["*"], ["acme"])], "key")).toBe(
      `${GRANT_FULL_ACCESS_SENTENCE} in Sales and in project Acme.`
    );
  });
});
