/**
 * A pod app's consent, rendered (react-dom/server; pod-admin's vitest runs in
 * node): each section carries ONE tri-state checkbox that says what it
 * selects, drawn from the same selection the space checkboxes read.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ComponentProps } from "react";
import { Card } from "@heroui/react";

vi.mock("../../../lib/trpc", () => ({ trpc: {} }));

import { AppConsent } from "./ConsentForm";
import {
  allowBlockedReason,
  initialSelection,
  toggle,
  type Selection,
} from "./consent-model";

type App = ComponentProps<typeof AppConsent>["app"];

const BRAND = { workspaceId: "brand", workspaceName: "Brand" };
const SHARED = { workspaceId: "shared", workspaceName: "Shared" };

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
  ignoredScopes: [],
};

const html = (selection: Selection) =>
  render(
    <Card>
      <AppConsent
        app={APP}
        registeredAt={new Date("2026-10-01T00:00:00Z")}
        redirectHost="studio.synap.live"
        selection={selection}
        onToggle={() => {}}
        onToggleSection={() => {}}
        onSpaceCreated={() => {}}
        busy={false}
        step={{ kind: "idle" }}
        blockedReason={allowBlockedReason(APP.permissions, selection)}
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

describe("AppConsent sections", () => {
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

  it("nothing ticked: Allow is disabled and says why", () => {
    const out = html(new Set());
    expect(out).toContain("Pick at least one space.");
  });
});
