/**
 * Design A's consent model (`consent-access`): one AppAccess v2 draft behind
 * the three lines, bounded by the offer. Sample apps mirror synap-chat (reads
 * pod-wide, 29 kinds in ONE request, no templates) and Content Studio (three
 * template spaces, edits in them).
 */
import { describe, expect, it } from "vitest";
import {
  KINDS_ROW,
  allowNew,
  canRows,
  canSummary,
  cantGive,
  draftBlockedReason,
  draftHeadline,
  firstDraft,
  heldAccessOf,
  inPhrase,
  kindsOn,
  needsWritePlace,
  newAllowed,
  notEverywhere,
  offerOf,
  placeNames,
  readChoices,
  readProjectsMode,
  reconsentChanges,
  reconsentDraft,
  rowLevel,
  sameDraft,
  setPermission,
  setReadProjectsMode,
  setReadSpacesMode,
  setRowLevel,
  showsUnion,
  toAccess,
  toApprovedPairs,
  toggleAllKinds,
  toggleKind,
  toggleReadProject,
  toggleReadSpace,
  toggleWritePlace,
  viewOnlySpaces,
  writeChoices,
  writePhrase,
  type ConsentAppWire,
  type ConsentDraft,
} from "./consent-access";
import { ALSO_SEE } from "./consent-model";

const BUILDER = { workspaceId: "w-builder", workspaceName: "Builder", templateSlug: null };
const CONTENT = { workspaceId: "w-content", workspaceName: "Content OS", templateSlug: "content-os" };
const ECO = { workspaceId: "w-eco", workspaceName: "Ecosystem", templateSlug: "ecosystem" };
const FINANCE = { workspaceId: "w-finance", workspaceName: "Finance", templateSlug: null };
const LAUNCH = { projectId: "p-launch", projectName: "Launch v1", workspaceId: "w-builder" };

const KINDS = ["task", "person", "deal"];
const GROUP = { permission: "entity.read", kinds: KINDS };

/** synap-chat: kinds read pod-wide in one request, sessions edited, no templates. */
const CHAT: ConsentAppWire = {
  permissions: [
    { permission: "session.update", workspaces: [BUILDER, CONTENT], reason: " To answer a run, as you. ", projects: [LAUNCH] },
    { permission: "track.read", workspaces: [BUILDER, CONTENT, FINANCE], reason: null, projects: [LAUNCH] },
    { permission: "proposal.approve", workspaces: [BUILDER, CONTENT], reason: null, projects: [] },
    { permission: "agent.read", workspaces: [], reason: null, projects: [] },
  ],
  podWide: [
    ...KINDS.map((k) => ({ permission: `entity.${k}.read`, reason: "To show records.", kindGroup: GROUP })),
    { permission: "session.read", reason: null, kindGroup: null },
    { permission: "document.read", reason: null, kindGroup: null },
  ],
  templates: [],
};

/** Content Studio: three template spaces, posts edited, documents read. */
const STUDIO: ConsentAppWire = {
  permissions: [
    { permission: "entity.post.read", workspaces: [BUILDER, CONTENT, ECO], reason: null },
    { permission: "entity.post.create", workspaces: [BUILDER, CONTENT, ECO], reason: "To draft your posts." },
    { permission: "document.read", workspaces: [BUILDER, CONTENT, ECO], reason: null },
  ],
  podWide: [],
  templates: ["content-os", "ecosystem"],
};

const ids = (d: ConsentDraft) => [...d.permissions].sort();

describe("the offer", () => {
  it("one item per permission, pod-wide ones flagged, reasons trimmed, projects known", () => {
    const offer = offerOf(CHAT);
    expect(offer.items.map((i) => i.permission)).toEqual([
      "session.update",
      "track.read",
      "proposal.approve",
      "agent.read",
      "entity.task.read",
      "entity.person.read",
      "entity.deal.read",
      "session.read",
      "document.read",
    ]);
    expect(offer.items[0]!.reason).toBe("To answer a run, as you.");
    expect(offer.items.find((i) => i.permission === "entity.task.read")!.podWide).toBe(true);
    expect(offer.projectsOffered).toBe(true);
    // Before #1196 no item carries projects: the Projects choice is omitted.
    expect(offerOf(STUDIO).projectsOffered).toBe(false);
  });

  it("reads may go everywhere only when a pod-wide read is on offer; writes list only writable places", () => {
    expect(readChoices(offerOf(CHAT)).everywhere).toBe(true);
    expect(readChoices(offerOf(STUDIO)).everywhere).toBe(false);
    expect(writeChoices(offerOf(CHAT)).spaces.map((s) => s.workspaceName)).toEqual(["Builder", "Content OS"]);
    // Finance is offered for a read only: absent from the write picker, named once.
    expect(viewOnlySpaces(offerOf(CHAT)).map((s) => s.workspaceName)).toEqual(["Finance"]);
  });
});

describe("a first consent's draft (design A §2)", () => {
  it("synap-chat: every place, every project; no write place picked (no templates); decisions off", () => {
    const d = firstDraft(offerOf(CHAT));
    expect(d.read).toEqual({ spaces: "all", projects: "all" });
    expect(d.write).toEqual({ spaces: [], projects: [] });
    expect(d.permissions.has("proposal.approve")).toBe(false);
    // Nothing that cannot be given anywhere is drafted.
    expect(d.permissions.has("agent.read")).toBe(false);
    expect(d.permissions.has("session.update")).toBe(true);
  });

  it("Content Studio: its template spaces, for reads and writes; no project", () => {
    const d = firstDraft(offerOf(STUDIO));
    expect(d.read).toEqual({ spaces: ["w-content", "w-eco"], projects: [] });
    expect(d.write).toEqual({ spaces: ["w-content", "w-eco"], projects: [] });
  });

  it("no templates, one writable place: that place, the only valid option", () => {
    const one: ConsentAppWire = {
      ...STUDIO,
      templates: [],
      permissions: STUDIO.permissions.map((p) => ({ ...p, workspaces: [BUILDER] })),
    };
    expect(firstDraft(offerOf(one)).write.spaces).toEqual(["w-builder"]);
  });

  it("no templates, no pod-wide read: every space its reads are offered in, as today", () => {
    const d = firstDraft(offerOf({ ...STUDIO, templates: [] }));
    expect(d.read.spaces).toEqual(["w-builder", "w-content", "w-eco"]);
    expect(d.write.spaces).toEqual([]);
  });
});

describe("what Allow sends", () => {
  it("toAccess never holds what the offer does not: an unknown permission or place is dropped; All includes every project (Q1)", () => {
    const offer = offerOf(STUDIO);
    const d: ConsentDraft = {
      permissions: new Set(["entity.post.read", "entity.post.create", "admin.everything"]),
      read: { spaces: ["w-content", "w-elsewhere"], projects: ["p-unknown"] },
      write: { spaces: ["w-eco", "w-elsewhere"], projects: [] },
    };
    expect(toAccess(d, offer)).toEqual({
      version: 2,
      permissions: ["entity.post.read", "entity.post.create"],
      read: { spaces: ["w-content"], projects: [] },
      write: { spaces: ["w-eco"], projects: [] },
    });
    // "All spaces" without a pod-wide read on offer is every offered space, never "all".
    const all = toAccess({ ...d, read: { spaces: "all", projects: [] } }, offer);
    expect(all.read).toEqual({ spaces: ["w-builder", "w-content", "w-eco"], projects: [] });
    const chat = offerOf(CHAT);
    expect(toAccess({ ...firstDraft(chat) }, chat).read).toEqual({ spaces: "all", projects: "all" });
  });

  it("on today's wire: pod-wide reads as null, other reads in every offered space under All; writes in the picked spaces only", () => {
    const offer = offerOf(CHAT);
    const d = toggleWritePlace(firstDraft(offer), "space", "w-builder");
    const pairs = toApprovedPairs(d, offer);
    expect(pairs).toContainEqual({ permission: "entity.task.read", workspaceId: null });
    expect(pairs).toContainEqual({ permission: "track.read", workspaceId: "w-finance" });
    expect(pairs).toContainEqual({ permission: "session.update", workspaceId: "w-builder" });
    expect(pairs).not.toContainEqual({ permission: "session.update", workspaceId: "w-content" });
    // Every pair is one the offer holds.
    for (const p of pairs) {
      const item = offer.items.find((i) => i.permission === p.permission)!;
      expect(p.workspaceId === null ? item.podWide : item.spaces.some((s) => s.workspaceId === p.workspaceId)).toBe(true);
    }
  });

  it("the headline is the access sentence over the draft", () => {
    const offer = offerOf(STUDIO);
    const sentence = draftHeadline(firstDraft(offer), offer);
    expect(sentence).toMatch(/Content OS/);
    expect(sentence.endsWith(".")).toBe(true);
  });
});

describe("It can: rows and levels", () => {
  const offer = offerOf(CHAT);
  const rows = canRows(offer, "person");

  it("the kinds declared in one request are ONE Records row, first; the rest as today's rows", () => {
    expect(rows[0]!.key).toBe(KINDS_ROW);
    expect(rows[0]!.kinds.map((k) => k.kind)).toEqual(KINDS);
    expect(rows[0]!.levels).toEqual(["off", "view"]);
    expect(rows.some((r) => r.key === ALSO_SEE)).toBe(true);
    expect(rows.at(-1)!.decisions).toBe(true);
    // A permission with no place at all is not a row: it is "can't give".
    expect(rows.flatMap((r) => [...r.permissions, ...r.members.flatMap((m) => m.permissions)]).some((p) => p.permission === "agent.read")).toBe(false);
  });

  it("a kind turned off stays off; All toggles every kind; Off clears the row", () => {
    const records = rows[0]!;
    let d = firstDraft(offer);
    expect(kindsOn(d, records)).toBe(3);
    d = toggleKind(d, records, "person");
    expect(kindsOn(d, records)).toBe(2);
    expect(rowLevel(d, records)).toBe("view");
    d = toggleAllKinds(d, records);
    expect(kindsOn(d, records)).toBe(3);
    d = toggleAllKinds(d, records);
    expect(rowLevel(d, records)).toBe("off");
    d = setRowLevel(d, records, "view");
    expect(kindsOn(d, records)).toBe(3);
  });

  it("the summary says each level once, folding what it also sees as a count", () => {
    const d = firstDraft(offer);
    const said = canSummary(d, rows);
    expect(said[0]).toEqual({ level: "view", text: expect.stringMatching(/^records \(3 kinds\)/) });
    expect(said.find((s) => s.level === "edit")!.text).toMatch(/sessions/i);
    expect(said.some((s) => s.level === "on")).toBe(false);
  });

  it("a decision is On only when the person turns it on", () => {
    const decide = rows.find((r) => r.decisions)!;
    let d = firstDraft(offer);
    expect(rowLevel(d, decide)).toBe("off");
    d = setRowLevel(d, decide, "on");
    expect(d.permissions.has("proposal.approve")).toBe(true);
  });
});

describe("In and It changes things in", () => {
  const offer = offerOf(CHAT);
  const names = placeNames(offer);

  it("All, then picking: from All the person starts from the templates (none here) with no project", () => {
    let d = firstDraft(offer);
    expect(inPhrase(d, names)).toMatch(/^Every space and every project/);
    d = setReadSpacesMode(d, offer, "pick");
    expect(d.read).toEqual({ spaces: [], projects: [] });
    expect(inPhrase(d, names)).toBe("Nowhere yet");
    d = toggleReadSpace(toggleReadSpace(d, "w-builder"), "w-content");
    expect(inPhrase(d, names)).toBe("Builder and Content OS");
    expect(showsUnion(d)).toBe(false);
    d = toggleReadProject(setReadProjectsMode(d, "pick"), "p-launch");
    expect(readProjectsMode(d, false)).toBe("pick");
    expect(inPhrase(d, names)).toBe("Builder and Content OS, or project Launch v1");
    expect(showsUnion(d)).toBe(true);
    d = setReadProjectsMode(d, "none");
    expect(d.read.projects).toEqual([]);
    d = setReadSpacesMode(d, offer, "all");
    expect(d.read).toEqual({ spaces: "all", projects: "all" });
  });

  it("a read with no pod-wide form is named under All, never dropped silently", () => {
    const d = firstDraft(offer);
    expect(notEverywhere(d, canRows(offer, "person"))).toEqual(["goals"]);
    expect(notEverywhere(setReadSpacesMode(d, offer, "pick"), canRows(offer, "person"))).toEqual([]);
  });

  it("the write line exists only while something changes things", () => {
    const rows = canRows(offer, "person");
    let d = firstDraft(offer);
    expect(needsWritePlace(d)).toBe(true);
    expect(writePhrase(d, names)).toBeNull();
    for (const r of rows) if (rowLevel(d, r) === "edit") d = setRowLevel(d, r, "view");
    expect(needsWritePlace(d)).toBe(false);
  });
});

describe("why Allow waits", () => {
  it("nothing to give, nothing on, no write place (with the View remedy), no read place; else null", () => {
    const offer = offerOf(CHAT);
    const rows = canRows(offer, "person");
    expect(draftBlockedReason(firstDraft(offerOf({ permissions: [{ permission: "x.read", workspaces: [] }], podWide: [], templates: [] })), offerOf({ permissions: [{ permission: "x.read", workspaces: [] }], podWide: [], templates: [] }), [])).toBe("You have no space to give it yet.");
    const none = { ...firstDraft(offer), permissions: new Set<string>() };
    expect(draftBlockedReason(none, offer, rows)).toBe("Turn on at least one thing it asks for.");
    expect(draftBlockedReason(firstDraft(offer), offer, rows)).toBe("Pick where it can make changes, or set Sessions to View.");
    const placed = toggleWritePlace(firstDraft(offer), "space", "w-builder");
    expect(draftBlockedReason(placed, offer, rows)).toBeNull();
    const nowhere = setReadSpacesMode(placed, offer, "pick");
    expect(draftBlockedReason(nowhere, offer, rows)).toBe("Pick at least one space or project it can work in.");
  });
});

describe("what it asked that cannot be given", () => {
  it("scopes no app is given, and permissions with no place, each with its reason", () => {
    const items = cantGive(offerOf(CHAT), ["*"]);
    expect(items.map((i) => [i.permission, i.label])).toEqual([
      ["*", "Full access"],
      ["agent.read", expect.any(String)],
    ]);
    expect(items[0]!.reason).toBe("Apps are never given this.");
    expect(items[1]!.reason).toBe("You have no space where you can let it see this.");
  });
});

describe("what the connection holds: re-consent", () => {
  const offer = offerOf(STUDIO);
  const rows = canRows(offer, "person");

  it("nothing held is a first consent; pairs that fit one access are that access", () => {
    expect(heldAccessOf([]).kind).toBe("none");
    const held = heldAccessOf([
      { permission: "entity.post.read", workspaceId: "w-content" },
      { permission: "entity.post.create", workspaceId: "w-content" },
    ]);
    expect(held.kind).toBe("access");
    expect(reconsentChanges(held, offer, rows, [
      { permission: "entity.post.read", workspaceId: "w-content" },
      { permission: "entity.post.create", workspaceId: "w-content" },
    ]).map((c) => c.key)).toEqual(["new:document.read"]);
  });

  it("pairs that would widen: each widened permission says now / was and has ONE door that turns it off, with Undo", () => {
    const current = [
      { permission: "entity.post.read", workspaceId: "w-content" },
      { permission: "document.read", workspaceId: "w-eco" },
    ];
    const held = heldAccessOf(current);
    expect(held.kind).toBe("reconsent");
    const changes = reconsentChanges(held, offer, rows, current);
    const wider = changes.filter((c) => c.mark === "wider");
    expect(wider.length).toBeGreaterThan(0);
    for (const c of wider) {
      expect(c.now).toMatch(/^in /);
      expect(c.was).toMatch(/^in /);
      expect(c.narrow).toMatch(/^Turn .* off$/);
    }
    let d = reconsentDraft(held, offer);
    const first = wider[0]!;
    d = setPermission(d, first.permission, false);
    expect(d.permissions.has(first.permission)).toBe(false);
    d = setPermission(d, first.permission, true);
    expect(d.permissions.has(first.permission)).toBe(true);
    // The new ask (create) starts OFF, and the one switch turns it on.
    expect(d.permissions.has("entity.post.create")).toBe(false);
    expect(newAllowed(d, changes)).toBe(false);
    d = allowNew(d, changes, true);
    expect(d.permissions.has("entity.post.create")).toBe(true);
    expect(newAllowed(d, changes)).toBe(true);
  });

  it("sameDraft compares sets, not order", () => {
    const a = firstDraft(offer);
    const b: ConsentDraft = { ...a, permissions: new Set(ids(a).reverse()) };
    expect(sameDraft(a, b)).toBe(true);
    expect(sameDraft(a, toggleWritePlace(a, "space", "w-builder"))).toBe(false);
  });
});
