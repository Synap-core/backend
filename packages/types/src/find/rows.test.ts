import { describe, expect, it } from "vitest";
import {
  actionTier,
  resolveFindRowTierLabel,
  toFindRows,
  type FindWire,
} from "./rows.js";
import { isQuestion } from "./question.js";

const cov = { hit: 1, of: 1 };
const obj = (kind: string, id: string, why: string | null = "prose") => ({
  kind,
  id,
  title: `T ${id}`,
  why,
  workspaceId: null,
  termCoverage: cov,
});

const wire: FindWire = {
  capabilities: {
    matches: [
      {
        action: {
          verbId: "gmail.send",
          label: "Send email",
          tool: "gmail",
          governance: "propose",
          kind: "write",
          parameters: { to: "string", attachments: "file[]:url?" },
        },
        whenToUse: "  Send   mail ",
        termCoverage: cov,
      },
      {
        action: {
          verbId: "gmail.search",
          label: "Search email",
          tool: "gmail",
          governance: "auto",
          kind: "read",
          parameters: {},
        },
        whenToUse: null,
        termCoverage: cov,
      },
    ],
  },
  playbooks: {
    candidates: [
      {
        id: "pb1",
        name: "Onboard a client",
        reason: "You mentioned “client”",
        templateKind: "Work template",
        subject: "person",
        requiredParams: [],
      },
    ],
  },
  goals: { matches: [obj("goal", "g1", 'Goal in project "X", active')] },
  documents: { error: "documents down" },
  entities: {
    matches: [
      { ...obj("entity", "e1", "VP of Product"), profileSlug: "person" },
    ],
  },
};

const ALL = [
  "entities",
  "capabilities",
  "playbooks",
  "goals",
  "documents",
] as const;

describe("toFindRows", () => {
  it("interleaves each catalog's best, then each one's second (scores never compared)", () => {
    const r = toFindRows(wire, { catalogs: ALL, max: 10, query: "email" });
    expect(r.rows.map((x) => x.key)).toEqual([
      "entities:e1",
      "capabilities:gmail.send",
      "playbooks:pb1",
      "goals:g1",
      "capabilities:gmail.search",
    ]);
  });

  it("an absent block is no rows and not failed; an `error` block is failed, never nothing", () => {
    const r = toFindRows(wire, {
      catalogs: ["documents", "views"],
      max: 10,
      query: "x",
    });
    expect(r.rows).toEqual([]);
    expect(r.failedCatalogs).toEqual(["documents"]);
  });

  it("folds goal → track once, and an entity row's kind is its profile", () => {
    const r = toFindRows(wire, { catalogs: ALL, max: 10, query: "x" });
    expect(r.rows.find((x) => x.id === "g1")?.kind).toBe("track");
    expect(r.rows.find((x) => x.id === "e1")?.kind).toBe("person");
  });

  it("a line only for prose catalogs; a goal's built `why` is not prose", () => {
    const r = toFindRows(wire, { catalogs: ALL, max: 10, query: "x" });
    expect(r.rows.find((x) => x.id === "g1")?.line).toBeNull();
    expect(r.rows.find((x) => x.id === "e1")?.line).toBe("VP of Product");
    expect(r.rows.find((x) => x.id === "gmail.send")?.line).toBe("Send mail");
    expect(r.rows.find((x) => x.id === "pb1")?.noun).toBe("Work template");
  });

  it("a tier reads its words through the vocabulary's one run-mode resolver", () => {
    expect(resolveFindRowTierLabel("read-only")).toBe("Read only");
    expect(resolveFindRowTierLabel("auto")).toBe("Runs on its own");
    expect(resolveFindRowTierLabel("asks-first")).toBe("Asks first");
  });

  it("the tier truth table, with an unknown verb kind NEVER read-only", () => {
    expect(actionTier({ kind: "read", governance: "propose" })).toBe(
      "read-only"
    );
    expect(actionTier({ kind: "write", governance: "auto" })).toBe("auto");
    expect(actionTier({ kind: "action", governance: "propose" })).toBe(
      "asks-first"
    );
    expect(actionTier({ kind: undefined, governance: "auto" })).toBe("auto");
    expect(actionTier({ kind: undefined, governance: "propose" })).toBe(
      "asks-first"
    );
    const r = toFindRows(wire, {
      catalogs: ["capabilities"],
      max: 10,
      query: "x",
    });
    expect(r.rows.map((x) => x.tier)).toEqual(["asks-first", "read-only"]);
  });

  it("an answer row leads only when the query is a question", () => {
    const q = toFindRows(wire, {
      catalogs: ALL,
      max: 3,
      query: "who leads product?",
    });
    expect(q.rows[0]).toMatchObject({
      role: "answer",
      run: { door: "knowledge.answer", query: "who leads product?" },
    });
    expect(q.rows).toHaveLength(3);
    const s = toFindRows(wire, { catalogs: ALL, max: 3, query: "send email" });
    expect(s.rows.some((x) => x.role === "answer")).toBe(false);
  });

  it("binds a selection into runnable rows, and only when one is given", () => {
    const selection = {
      items: [
        { id: "p1", kind: "person", roles: [] },
        { id: "f1", kind: "file", file: { mimeType: null } },
      ],
    };
    const r = toFindRows(wire, {
      catalogs: ["capabilities", "playbooks"],
      max: 10,
      query: "x",
      selection,
    });
    const send = r.rows.find((x) => x.id === "gmail.send")!;
    expect(send.binding?.filled).toEqual([
      { name: "attachments", value: ["f1"], source: "file" },
    ]);
    expect(r.rows.find((x) => x.id === "pb1")?.binding?.filled).toEqual([
      { name: "subject", value: "p1", source: "subject" },
    ]);
    const none = toFindRows(wire, {
      catalogs: ["capabilities"],
      max: 10,
      query: "x",
    });
    expect(none.rows.every((x) => x.binding === undefined)).toBe(true);
  });
});

describe("isQuestion", () => {
  it.each([
    ["who is our VP of product", true],
    ["What's next", true],
    ["send the report?", true],
    ["  how  ", true],
    ["send email", false],
    ["whoever", false],
    ["", false],
    ["  ", false],
  ])("%j → %s", (q, want) => {
    expect(isQuestion(q)).toBe(want);
  });
});
