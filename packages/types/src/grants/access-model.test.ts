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
