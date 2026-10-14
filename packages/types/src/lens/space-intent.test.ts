/**
 * The homes models. Rows chosen where naive rules disagree: an authored tone
 * vs the category's, a headline that is NOT the first kind's, a goal with no
 * measured value, an unknown needs-you total (a naive `?? 0` omits the line),
 * asks-you on the SECOND work line (a naive "first work decides" misses it).
 */
import { describe, expect, it } from "vitest";
import {
  alsoInKinds,
  homeNeedsYouModel,
  kindColumnTone,
  kindLabelOf,
  movingNowRowOpts,
  movingRowSpaceWord,
  movingSpaceChips,
  homeSpacesModel,
  kindBarA11y,
  kindBarSegments,
  movingNowRowModel,
  unattachedRowModel,
  UNATTACHED_TITLE,
  UNATTACHED_INVITE,
  spaceIntentCardModel,
  spaceIntentTitle,
  type SpaceIntentInput,
  type SpaceProducedKindInput,
} from "./space-intent.js";
import { lensKpiFact } from "./header.js";
import { resolveObjectNounPlural } from "../vocabulary/index.js";

function kind(
  over: Partial<SpaceProducedKindInput> = {}
): SpaceProducedKindInput {
  return {
    profileSlug: "devplane_feature",
    label: "Feature",
    plural: "Features",
    live: 3,
    total: 6,
    doneWindowed: 1,
    windowDays: 7,
    columns: [
      { key: "idea", label: "Idea", category: "open", count: 2 },
      { key: "spec", label: "Spec", category: "active", count: 0 },
      { key: "building", label: "Building", category: "active", count: 1 },
      { key: "shipped", label: "Shipped", category: "done", count: 1 },
    ],
    needsYou: 0,
    beingWorked: 1,
    headline: null,
    ...over,
  };
}

function space(over: Partial<SpaceIntentInput> = {}): SpaceIntentInput {
  return {
    workspaceId: "w1",
    name: "Dev",
    label: "Product",
    source: "template",
    kind: "producing",
    produces: [kind()],
    ...over,
  };
}

describe("kindBarSegments (the ONE bar rule)", () => {
  it("keeps option order, drops empty columns, tones by category", () => {
    const bar = kindBarSegments(kind().columns);
    expect(bar).toEqual([
      { key: "idea", label: "Idea", tone: "textSecondary", weight: 2 },
      { key: "building", label: "Building", tone: "primary", weight: 1 },
      { key: "shipped", label: "Shipped", tone: "success", weight: 1 },
    ]);
    expect(kindBarA11y(bar)).toBe("Idea 2, Building 1, Shipped 1");
  });

  it("an authored option tone outranks its category; unclassified is warning", () => {
    const bar = kindBarSegments([
      {
        key: "review",
        label: "Review",
        category: "active",
        count: 1,
        tone: "info",
      },
      { key: "__unclassified", label: "No status", category: null, count: 2 },
    ]);
    expect(bar.map((s) => s.tone)).toEqual(["info", "warning"]);
  });

  it("an all-empty pipeline draws no bar", () => {
    expect(
      kindBarSegments(kind().columns.map((c) => ({ ...c, count: 0 })))
    ).toEqual([]);
  });
});

describe("spaceIntentTitle", () => {
  it("purpose first, collapsed when the purpose IS the name", () => {
    expect(spaceIntentTitle({ label: "Product", name: "Dev" })).toBe(
      "Product · Dev"
    );
    expect(spaceIntentTitle({ label: "content", name: "Content" })).toBe(
      "Content"
    );
    expect(spaceIntentTitle({ label: "  ", name: "Brand" })).toBe("Brand");
  });
});

describe("spaceIntentCardModel", () => {
  it("one row per produced kind, in produces order, with its bar and fact", () => {
    const m = spaceIntentCardModel(
      space({
        produces: [
          kind(),
          kind({
            profileSlug: "devplane_story",
            plural: "User stories",
            live: 0,
            doneWindowed: 0,
          }),
        ],
      })
    );
    expect(m.title).toBe("Product · Dev");
    expect(m.kinds.map((k) => k.title)).toEqual(["Features", "User stories"]);
    expect(m.kinds[0]!.fact).toBe("3 in pipeline · 1 done this week");
    // Nothing live and nothing done: no fact (never "0 in pipeline").
    expect(m.kinds[1]!.fact).toBeNull();
    expect(m.kinds[0]!.workspaceId).toBe("w1");
  });

  it("a measured goal is the fact; an unmeasured one falls back to the counts", () => {
    const goal = lensKpiFact({
      label: "Clients",
      target: 5,
      current: 2,
      unit: "clients",
    });
    const unmeasured = lensKpiFact({ label: "Clients", target: 5 });
    expect(
      spaceIntentCardModel(space(), { devplane_feature: goal }).kinds[0]!.fact
    ).toBe("2 / 5 clients");
    expect(
      spaceIntentCardModel(space(), { devplane_feature: unmeasured }).kinds[0]!
        .fact
    ).toBe("3 in pipeline · 1 done this week");
  });

  it("owed only when needs-you is a positive number (unknown ≠ zero ≠ owed)", () => {
    const owed = (n: number | null) =>
      spaceIntentCardModel(space({ produces: [kind({ needsYou: n })] }))
        .kinds[0]!.owed;
    expect(owed(2)).toBe(2);
    expect(owed(0)).toBeNull();
    expect(owed(null)).toBeNull();
    expect(
      spaceIntentCardModel(space({ produces: [kind({ needsYou: 2 })] }))
        .kinds[0]!.a11y
    ).toBe(
      "Features, 2 need you, Idea 2, Building 1, Shipped 1, 3 in pipeline · 1 done this week"
    );
  });

  it("the headline is the LOUDEST kind's, not the first kind's", () => {
    const m = spaceIntentCardModel(
      space({
        produces: [
          kind({
            headline: {
              entityId: "e1",
              title: "Old one",
              status: "shipped",
              reason: "recent",
            },
          }),
          kind({
            profileSlug: "devplane_story",
            columns: [
              {
                key: "in_feature",
                label: "In feature",
                category: "active",
                count: 1,
              },
            ],
            headline: {
              entityId: "e2",
              title: "Pinned surfaces",
              status: "in_feature",
              reason: "needs_you",
            },
          }),
        ],
      })
    );
    expect(m.headline).toEqual({
      entityId: "e2",
      profileSlug: "devplane_story",
      reason: "needs_you",
      // The column's authored label, never the vocabulary's guess.
      text: "Pinned surfaces · In feature · Needs you",
      state: { owedFromYou: 1 },
    });
  });

  it("a recent headline names the thing and its status only, with no mark", () => {
    const m = spaceIntentCardModel(
      space({
        produces: [
          kind({
            headline: {
              entityId: "e1",
              title: null,
              status: "shipped",
              reason: "recent",
            },
          }),
        ],
      })
    );
    expect(m.headline?.text).toBe("Devplane feature · Shipped");
    expect(m.headline?.state).toBeNull();
  });
});

describe("homeSpacesModel", () => {
  it("producing spaces are cards; libraries (and producing-nothing) are chips", () => {
    const m = homeSpacesModel([
      space(),
      space({
        workspaceId: "w2",
        name: "Brand",
        label: "Brand",
        kind: "library",
        produces: [],
      }),
      space({
        workspaceId: "w3",
        name: "Notes",
        label: "Research",
        produces: [],
      }),
    ]);
    expect(m.cards.map((c) => c.workspaceId)).toEqual(["w1"]);
    expect(m.library).toEqual([
      { workspaceId: "w2", title: "Brand" },
      { workspaceId: "w3", title: "Research · Notes" },
    ]);
  });
});

describe("homeNeedsYouModel", () => {
  const spaces = [
    { workspaceId: "w1", label: "Sales", name: "CRM" },
    { workspaceId: "w2", label: "Content", name: "Content" },
  ];
  it("groups by space, largest first; a zero or unknown space is left out", () => {
    const m = homeNeedsYouModel(
      {
        total: 3,
        bySpace: [
          { workspaceId: "w1", count: 1 },
          { workspaceId: "w2", count: 2 },
          { workspaceId: "w3", count: null },
        ],
      },
      spaces
    );
    expect(m?.text).toBe("3 need you · Content 2 · Sales 1");
    expect(m?.parts.map((p) => p.workspaceId)).toEqual(["w2", "w1"]);
  });
  it("zero omits the line; an unknown total keeps it, marked unknown", () => {
    expect(homeNeedsYouModel({ total: 0, bySpace: [] }, spaces)).toBeNull();
    const unknown = homeNeedsYouModel({ total: null, bySpace: [] }, spaces);
    expect(unknown).not.toBeNull();
    expect(unknown?.total).toBeNull();
    expect(unknown?.text).toMatch(/^– need you/);
  });
});

describe("movingNowRowModel", () => {
  const base = {
    entityId: "e1",
    title: "Pinned surfaces",
    profileSlug: "devplane_feature",
    workspaceId: "w1",
    status: "building",
    category: "active",
  };

  it("asks-you on ANY work line makes the thing Blocking with the needs-you mark", () => {
    const m = movingNowRowModel(
      {
        ...base,
        work: [
          {
            kind: "worker",
            sessionId: "s1",
            label: "Draft worker",
            live: true,
            asksYou: false,
            since: "2026-10-13T10:00:00Z",
          },
          {
            kind: "session",
            sessionId: "s2",
            label: "Build: pin a pipeline",
            actor: "Claude Code",
            live: false,
            asksYou: true,
            since: "2026-10-13T09:00:00Z",
          },
        ],
      },
      { spaceName: "Product · Dev", kindLabel: "Feature" }
    );
    expect(m.row.cls).toBe("blocking");
    expect(m.row.state).toEqual({ owedFromYou: 1 });
    expect(m.asksYou).toBe(true);
    expect(m.row.title).toBe("Pinned surfaces");
    expect(m.row.reason).toBe("Feature · Building");
    expect(m.row.door).toEqual({ kind: "entity", id: "e1" });
    expect(m.row.source).toEqual({
      kind: "workspace",
      id: "w1",
      label: "Product · Dev",
    });
    // The age is the longest-running work's start.
    expect(m.row.occurredAt).toBe("2026-10-13T09:00:00Z");
    expect(m.work.map((w) => w.text)).toEqual([
      "Draft worker",
      "Build: pin a pipeline · Claude Code · Asks you",
    ]);
    expect(m.work.map((w) => w.state)).toEqual([
      { running: true },
      { owedFromYou: 1 },
    ]);
    expect(m.beingWorked).toEqual({ by: null, sessionId: "s1" });
  });

  it("live work only: Happening, the agent named on the being-worked mark", () => {
    const m = movingNowRowModel({
      ...base,
      work: [
        {
          kind: "session",
          sessionId: "s1",
          label: "Build",
          actor: "Claude Code",
          live: true,
          asksYou: false,
          since: "x",
        },
      ],
    });
    expect(m.row.cls).toBe("happening");
    expect(m.beingWorked).toEqual({ by: "Claude Code", sessionId: "s1" });
    // No space name ⇒ no source door; no kind label ⇒ the vocabulary's noun.
    expect(m.row.source).toBeNull();
    expect(m.row.reason).toBe("Devplane feature · Building");
  });

  it("open but quiet work (a scheduled prep): the quiet row, no being-worked mark", () => {
    const m = movingNowRowModel(
      {
        ...base,
        title: null,
        status: null,
        work: [
          {
            kind: "scheduled",
            sessionId: "s1",
            label: "Call prep",
            live: false,
            asksYou: false,
            since: "x",
          },
        ],
      },
      { kindLabel: "Lead" }
    );
    expect(m.row.cls).toBe("happened");
    expect(m.row.state).toEqual({ idle: true });
    expect(m.beingWorked).toBeNull();
    expect(m.row.title).toBe("Lead");
    expect(m.row.reason).toBe("Lead");
  });
});

describe("a failed per-kind read is unknown, never calm", () => {
  it("owedUnknown / workUnknown only for a null read (zero is calm)", () => {
    const m = spaceIntentCardModel(
      space({
        produces: [
          kind({ needsYou: null, beingWorked: null }),
          kind({ profileSlug: "devplane_story", needsYou: 0, beingWorked: 0 }),
        ],
      })
    );
    expect(m.kinds.map((k) => [k.owed, k.owedUnknown, k.workUnknown])).toEqual([
      [null, true, true],
      [null, false, false],
    ]);
  });
});

describe("kindColumnTone (THE option tone rule)", () => {
  it("an authored tone that is no real token falls back to the category's", () => {
    // The old copies trusted any authored tone; `lifecycleOptionTone` does not.
    expect(
      kindColumnTone({ category: "active", tone: "purple" as never })
    ).toBe("primary");
    expect(kindColumnTone({ category: "active", tone: "ai" })).toBe("ai");
    expect(kindColumnTone({ category: null })).toBe("warning");
    expect(
      kindBarSegments([
        {
          key: "x",
          label: "X",
          category: "done",
          count: 1,
          tone: "nope" as never,
        },
      ])[0]!.tone
    ).toBe("success");
  });
});

describe("the row/space joins (one rule, browser + relay)", () => {
  const campaign = (label: string) =>
    kind({ profileSlug: "campaign", label, plural: `${label}s` });
  const crm = space({
    workspaceId: "crm",
    name: "CRM",
    label: "Sales",
    produces: [campaign("Sales campaign")],
  });
  const content = space({
    workspaceId: "content",
    name: "Content",
    label: "Content",
    produces: [campaign("Content campaign")],
  });
  const mkt = space({
    workspaceId: "mkt",
    name: "Marketing",
    label: "Growth",
    produces: [campaign("Growth campaign")],
  });
  const lib = space({
    workspaceId: "lib",
    name: "Brand",
    label: "Brand",
    kind: "library",
    produces: [],
  });
  const home = [crm, content, mkt, lib];

  it("a row's space word is the card's title, not the bare purpose", () => {
    // relay used the purpose alone ("Sales"); the card says "Sales · CRM".
    expect(movingRowSpaceWord({ workspaceId: "crm" }, home)).toBe(
      "Sales · CRM"
    );
    expect(movingRowSpaceWord({ workspaceId: "crm" }, home, "crm")).toBeNull();
    expect(movingRowSpaceWord({ workspaceId: "gone" }, home)).toBeNull();
  });

  it("a kind shared by spaces keeps ITS OWN space's word (no last-wins)", () => {
    // The browser's slug→label map kept the LAST space's word ("Growth campaign").
    expect(
      movingNowRowOpts({ workspaceId: "crm", profileSlug: "campaign" }, home)
    ).toEqual({ spaceName: "Sales · CRM", kindLabel: "Sales campaign" });
    expect(
      movingNowRowOpts({ workspaceId: "mkt", profileSlug: "campaign" }, home)
        .kindLabel
    ).toBe("Growth campaign");
    // A thing in a space that does not produce it: the first producer's word.
    expect(
      movingNowRowOpts({ workspaceId: "lib", profileSlug: "campaign" }, home)
        .kindLabel
    ).toBe("Sales campaign");
    expect(kindLabelOf(mkt, "campaign")).toBe("Growth campaign");
    expect(kindLabelOf(null, "devplane_feature")).toBe(
      kindLabelOf([], "devplane_feature")
    );
  });

  it("chips: home order, producing + present, a known zero omitted", () => {
    const items = [
      { workspaceId: "mkt" },
      { workspaceId: "mkt" },
      { workspaceId: "lib" },
      { workspaceId: "crm" },
    ];
    const { total, chips } = movingSpaceChips(items, home);
    expect(total).toBe(4);
    // Home order (NOT count order: the browser sorted Growth first), Content
    // (producing, nothing moving) left out, Brand (library, one moving) in.
    expect(chips).toEqual([
      { workspaceId: "crm", title: "Sales · CRM", count: 1 },
      { workspaceId: "mkt", title: "Growth · Marketing", count: 2 },
      { workspaceId: "lib", title: "Brand", count: 1 },
    ]);
  });

  it("chips: a failed or capped read is UNKNOWN, never 0", () => {
    const failed = movingSpaceChips(null, home);
    expect(failed.total).toBeNull();
    // Every producing space stays a door; none claims a count.
    expect(failed.chips.map((c) => [c.workspaceId, c.count])).toEqual([
      ["crm", null],
      ["content", null],
      ["mkt", null],
    ]);
    const capped = movingSpaceChips(
      [{ workspaceId: "crm" }, { workspaceId: "crm" }],
      home,
      { limit: 2 }
    );
    expect(capped.total).toBeNull();
    expect(capped.chips.every((c) => c.count === null)).toBe(true);
    expect(movingSpaceChips([], null).chips).toEqual([]);
  });

  it("also here: declared kinds of THIS space with things, most first", () => {
    const profiles = [
      {
        slug: "note",
        name: "Note",
        workspaceId: null,
        profileKind: "kind" as const,
      },
      {
        slug: "partner",
        name: "Partner",
        workspaceId: "crm",
        profileKind: "role" as const,
      },
      {
        slug: "contact_log",
        name: "Contact log",
        workspaceId: "crm",
        profileKind: "kind" as const,
      },
      {
        slug: "playbook_note",
        name: "Playbook note",
        plural: "Playbook notes",
        workspaceId: "crm",
        profileKind: "kind" as const,
      },
      {
        slug: "empty_kind",
        name: "Empty kind",
        workspaceId: "crm",
        profileKind: "kind" as const,
      },
      {
        slug: "campaign",
        name: "Campaign",
        workspaceId: "crm",
        profileKind: "kind" as const,
      },
      {
        slug: "other",
        name: "Other",
        workspaceId: "content",
        profileKind: "kind" as const,
      },
    ];
    const counts = {
      note: 40,
      partner: 9,
      contact_log: 2,
      playbook_note: 5,
      empty_kind: 0,
      campaign: 3,
      other: 7,
    };
    // relay counted any profile (note, partner); the browser kept zero
    // (empty_kind) and sorted by name. ONE rule: declared kind, count > 0, most first.
    expect(alsoInKinds(crm, profiles, counts)).toEqual([
      {
        profileSlug: "playbook_note",
        title: "Playbook notes",
        count: 5,
        workspaceId: "crm",
      },
      {
        profileSlug: "contact_log",
        title: resolveObjectNounPlural("Contact log"),
        count: 2,
        workspaceId: "crm",
      },
    ]);
    expect(alsoInKinds(crm, profiles, null)).toBeNull();
  });
});

describe("unattachedRowModel (homes A7)", () => {
  const line = {
    sessionId: "s9",
    label: "Explore the pricing page",
    actor: "Claude Code",
    live: false,
    asksYou: true,
    since: "2026-10-13T08:00:00Z",
  };

  it("draws 'No thing yet · attach one', its door the SESSION, its one line the session", () => {
    const m = unattachedRowModel(line);
    expect(m.row.title).toBe(UNATTACHED_TITLE);
    expect(m.row.reason).toBe(UNATTACHED_INVITE);
    expect(m.row.door).toEqual({ kind: "session", id: "s9" });
    expect(m.row.key).toBe("unattached:s9");
    expect(m.row.source).toBeNull();
    expect(m.work.map((w) => w.text)).toEqual([
      "Explore the pricing page · Claude Code · Asks you",
    ]);
  });

  it("its mark follows the line: asks you => Blocking, live => Happening, else Happened", () => {
    expect(unattachedRowModel(line).row.cls).toBe("blocking");
    expect(
      unattachedRowModel({ ...line, asksYou: false, live: true }).row.cls
    ).toBe("happening");
    expect(unattachedRowModel({ ...line, asksYou: false }).row.cls).toBe(
      "happened"
    );
  });
});
