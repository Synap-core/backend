/**
 * A pod app's consent, rendered (react-dom/server; pod-admin's vitest runs in
 * node). By default: one row per object, each with a named level control,
 * drawn from the selection. Customize: each section carries ONE tri-state
 * checkbox that says what it selects, drawn from the same selection the space
 * checkboxes read.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ComponentProps } from "react";
import { Card } from "@heroui/react";

vi.mock("../../../lib/trpc", () => ({ trpc: {} }));

import { AppConsent } from "./ConsentForm";
import {
  actsAsHeadline,
  allowBlockedReason,
  initialSelection,
  SPACE_REACH_NOTE,
  toggle,
  type OfferedPermission,
  type Selection,
} from "./consent-model";

type App = ComponentProps<typeof AppConsent>["app"];

const BRAND = {
  workspaceId: "brand",
  workspaceName: "Brand",
  templateSlug: null,
};
const SHARED = {
  workspaceId: "shared",
  workspaceName: "Shared",
  templateSlug: null,
};

const APP: App = {
  domain: "studio.synap.live",
  verified: true,
  actsAs: {
    kind: "person",
    lead: "Content Studio will act as you in",
    note: "It acts as you.",
  },
  homepage: null,
  permissions: [
    { permission: "entity.post.read", workspaces: [BRAND, SHARED] },
    { permission: "entity.post.create", workspaces: [BRAND, SHARED] },
    { permission: "proposal.approve", workspaces: [BRAND, SHARED] },
  ],
  approved: [],
  templates: [],
  podWideKinds: [],
  ignoredScopes: [],
};

const html = (selection: Selection, customize = true, app: App = APP) =>
  render(
    <Card>
      <AppConsent
        app={app}
        registeredAt={new Date("2026-10-01T00:00:00Z")}
        redirectHost="studio.synap.live"
        selection={selection}
        onToggle={() => {}}
        onToggleSection={() => {}}
        onSetLevel={() => {}}
        onToggleObjectSpace={() => {}}
        customize={customize}
        onCustomize={() => {}}
        onSpaceCreated={() => {}}
        busy={false}
        step={{ kind: "idle" }}
        blockedReason={allowBlockedReason(app.permissions, selection)}
        onDecide={() => {}}
      />
    </Card>
  );

/** The `<label>` HeroUI wraps around the input with this accessible name. */
function sectionBox(out: string, name: string): string {
  const at = out.indexOf(`aria-label="${name}"`);
  expect(at, `no checkbox named "${name}"`).toBeGreaterThan(-1);
  const open = out.lastIndexOf("<label", at);
  return out.slice(open, out.indexOf(">", open) + 1);
}

const GRANTS = "All it asks to do, in every space";
const DECISIONS = "All its decisions, in every space";

describe("AppConsent sections (Customize)", () => {
  it("first consent: the reads and writes read all, the decisions none", () => {
    const out = html(initialSelection(APP.permissions, []));
    const grants = sectionBox(out, GRANTS);
    expect(grants).toContain('data-selected="true"');
    expect(grants).not.toContain("data-indeterminate");
    const decisions = sectionBox(out, DECISIONS);
    expect(decisions).not.toContain("data-selected");
    expect(decisions).not.toContain("data-indeterminate");
  });

  it("one space unticked: its section reads some (indeterminate)", () => {
    const s = toggle(
      initialSelection(APP.permissions, []),
      APP.permissions,
      "entity.post.read",
      "shared"
    );
    expect(sectionBox(html(s), GRANTS)).toContain('data-indeterminate="true"');
  });

  it("each section is a region named by its heading, holding its own checkbox", () => {
    const out = html(new Set());
    const text = (h: string) => h.replace(/<[^>]+>/g, "").trim();
    const sections = [...out.matchAll(/<section aria-labelledby="([^"]+)"/g)];
    expect(sections.map((m) => m[1] ?? "")).toHaveLength(2);
    const seen = sections.map((m) => {
      const id = m[1] ?? "";
      const heading = out.slice(out.indexOf(`id="${id}"`));
      const body = out.slice(m.index, out.indexOf("</section>", m.index));
      return {
        title: text(
          heading.slice(heading.indexOf(">") + 1, heading.indexOf("</p>"))
        ),
        box: body.includes(`aria-label="${GRANTS}"`)
          ? GRANTS
          : body.includes(`aria-label="${DECISIONS}"`)
            ? DECISIONS
            : null,
      };
    });
    expect(seen).toEqual([
      { title: "It asks to", box: GRANTS },
      { title: "It asks to decide for you", box: DECISIONS },
    ]);
  });

  it("every checkbox draws its unticked box in the visible token, not HeroUI's card-coloured one", () => {
    const out = html(new Set());
    const boxes = out.match(/type="checkbox"/g)?.length ?? 0;
    // 3 permissions × 2 spaces, plus the two sections' "All".
    expect(boxes).toBe(8);
    expect(out.match(/before:border-default-500/g)?.length).toBe(boxes);
    // twMerge replaced HeroUI's own border colour, not appended beside it.
    expect(out).not.toMatch(/before:border-default(?![-\w])/);
  });

  it("nothing ticked: Allow is disabled and says why", () => {
    const out = html(new Set());
    expect(out).toContain("Turn on at least one thing it asks for.");
  });
});

// ─── Object-first rows: Content Studio's real ask ────────────────────────────

const CO = {
  workspaceId: "co",
  workspaceName: "Content OS",
  templateSlug: "content-os",
};
const ECO = {
  workspaceId: "eco",
  workspaceName: "Ecosystem",
  templateSlug: "ecosystem",
};
const BRAND_S = {
  workspaceId: "brand",
  workspaceName: "Brand",
  templateSlug: null,
};
const BUILDER = {
  workspaceId: "builder",
  workspaceName: "Builder",
  templateSlug: "builder-workspace",
};

/**
 * https://content-studio.synap.live/.well-known/synap-client.json, read
 * 2026-10-23: 18 permissions, `synap_templates: ["content-os", "ecosystem"]`.
 */
const STUDIO_ASK = [
  "entity.post.read",
  "entity.pillar.read",
  "entity.journey-stage.read",
  "entity.series.read",
  "entity.platform.read",
  "entity.file.read",
  "entity.content-composition.read",
  "entity.content-asset.read",
  "entity.inspiration.read",
  "entity.signal_item.read",
  "document.read",
  "relation.read",
  "session.read",
  "proposal.read",
  "entity.post.create",
  "entity.post.update",
  "entity.signal_item.update",
  "entity.file.create",
];
const STUDIO: App = {
  ...APP,
  domain: "content-studio.synap.live",
  permissions: STUDIO_ASK.map((permission): OfferedPermission => ({
    permission,
    workspaces: [BRAND_S, BUILDER, CO, ECO],
  })) as App["permissions"],
  templates: ["content-os", "ecosystem"],
};

/** The level control named `name`, up to the row's detail. */
function levelGroup(out: string, name: string): string {
  const at = out.indexOf(`aria-label="${name}"`);
  expect(at, `no level control named "${name}"`).toBeGreaterThan(-1);
  const end = out.indexOf("-detail", at);
  return out.slice(at, end === -1 ? undefined : end);
}
/** The words of the segment that is selected in a level control. */
const selectedLevel = (group: string) =>
  [
    ...group.matchAll(
      /<label[^>]*data-selected="true"[^>]*>([\s\S]*?)<\/label>/g
    ),
  ].map((m) => (m[1] ?? "").replace(/<[^>]+>/g, "").trim());

describe("AppConsent rows (default view)", () => {
  const first = initialSelection(STUDIO.permissions, [], STUDIO.templates);
  const out = html(first, false, STUDIO);

  it("Content Studio's ask reads as 4 rows: its 3 edits, then ONE row for the 11 objects it only views", () => {
    const objects = [...out.matchAll(/data-object="([^"]+)"/g)].map(
      (m) => m[1]
    );
    // Document order: the folded objects render inside "It can also see".
    expect(objects.slice(0, 4)).toEqual([
      "entity.post",
      "entity.file",
      "entity.signal_item",
      "also-see",
    ]);
    expect(objects).toHaveLength(4 + 11);
    expect(out.match(/role="radiogroup"/g)?.length).toBe(15);
    expect(out).toContain("Pillars, Journey stages, Series, Platforms +7 more");
    // The matrix is not on screen: no section "All" checkbox.
    expect(out).not.toContain("All it asks to do, in every space");
  });

  it("by default only Content OS and Ecosystem are given, at each row's level", () => {
    expect(
      actsAsHeadline(
        "Content Studio will act as you in",
        first,
        STUDIO.permissions
      )
    ).toBe("Content Studio will act as you in: Content OS, Ecosystem.");
    expect(selectedLevel(levelGroup(out, "Posts: access"))).toEqual(["Edit"]);
    expect(selectedLevel(levelGroup(out, "Pillars: access"))).toEqual(["View"]);
    expect(selectedLevel(levelGroup(out, "It can also see: access"))).toEqual([
      "View",
    ]);
    // The 3 edit rows and each of the 11 folded objects say where.
    expect(out.match(/in Content OS and Ecosystem/g)?.length).toBe(14);
  });

  it("a read-only row offers View and Off, never Edit", () => {
    for (const name of ["Pillars: access", "It can also see: access"]) {
      const g = levelGroup(out, name);
      expect(g).toContain(">View<");
      expect(g).toContain(">Off<");
      expect(g).not.toContain(">Edit<");
    }
  });

  it("the other spaces wait behind one disclosure per row, unticked", () => {
    expect(out.match(/Also allow in another space…/g)?.length).toBe(14);
    const brand = sectionBox(out, "Posts in Brand");
    expect(brand).not.toContain("data-selected");
    expect(sectionBox(out, "Posts in Content OS")).toContain(
      'data-selected="true"'
    );
  });

  it("each row's name is a disclosure button; every tick keeps the visible border", () => {
    // 15 row names (4 rows + 11 folded objects) + 14 "Also allow…".
    expect(out.match(/aria-expanded="false"/g)?.length).toBe(29);
    const boxes = out.match(/type="checkbox"/g)?.length ?? 0;
    expect(boxes).toBe(14 * 4);
    expect(out.match(/before:border-default-500/g)?.length).toBe(boxes);
    expect(out.match(/ring-default-500/g)?.length).toBe(15);
  });

  it("the reach sentence shows once in both views for a record read, never without one (#128)", () => {
    const once = (o: string) => o.split(SPACE_REACH_NOTE).length - 1;
    expect(once(out)).toBe(1);
    expect(once(html(first, true, STUDIO))).toBe(1);
    const writesOnly: App = {
      ...STUDIO,
      permissions: [
        { permission: "entity.post.create", workspaces: [CO] },
      ] as App["permissions"],
    };
    const sel = initialSelection(writesOnly.permissions, [], []);
    expect(once(html(sel, false, writesOnly))).toBe(0);
  });

  it("Off everywhere: Allow is blocked, with its reason", () => {
    expect(html(new Set(), false, STUDIO)).toContain(
      "Turn on at least one thing it asks for."
    );
  });

  it("a pod-wide kind's row says how it reaches the app; decisions are their own row, Off", () => {
    const app: App = {
      ...STUDIO,
      permissions: [
        { permission: "entity.person.read", workspaces: [CO] },
        { permission: "entity.post.update", workspaces: [CO] },
        { permission: "entity.post.archive", workspaces: [CO] },
        { permission: "proposal.approve", workspaces: [CO] },
      ] as App["permissions"],
      podWideKinds: ["person"],
    };
    const o = html(
      initialSelection(app.permissions, [], app.templates),
      false,
      app
    );
    expect(o).toContain("People kept across your whole pod");
    expect(selectedLevel(levelGroup(o, "Let it decide for you"))).toEqual([
      "Off",
    ]);
    expect(o).toContain("It asks to decide for you");
    // A gate verb is a decision, named in words, never part of Edit.
    expect(o).toContain("Archive or approve, as you");
    expect(o).toContain("Archive posts");
    expect(selectedLevel(levelGroup(o, "Posts: access"))).toEqual(["Edit"]);
  });
});
