/**
 * The SHORT consent (plan 647ebfd4 option C; design A "short ask"), both
 * sources (W3d contract v1.1): today's `app.ask` pairs, and the contract's
 * `app.access.ask` (a connection that names a project). Rendered
 * (react-dom/server; pod-admin's vitest runs in node).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { Card } from "@heroui/react";
import {
  AskConsent,
  askCurrentOf,
  askViewOf,
  type ConsentAsk,
} from "./AskConsent";
import {
  firstDraft,
  namesOfNamed,
  offerOf,
  placeNames,
  type ConsentAppWire,
  type ConsentContract,
  type ConsentDraft,
} from "./consent-access";
import type { Step } from "./ConsentForm";

const CONTENT = {
  workspaceId: "ws-content",
  workspaceName: "Content OS",
  templateSlug: null,
};
const BUILDER = {
  workspaceId: "ws-builder",
  workspaceName: "Builder",
  templateSlug: null,
};

const ASK: ConsentAsk = {
  title: "Content Studio asks to read notes in Content OS",
  pairs: [
    {
      permission: "entity.note.read",
      workspaceId: "ws-content",
      workspaceName: "Content OS",
    },
  ],
  unavailable: [],
  connectionPublicId: "app_123",
};

const APP: ConsentAppWire & {
  approved: Array<{ permission: string; workspaceId: string | null }>;
} = {
  permissions: [
    {
      permission: "entity.post.read",
      workspaces: [CONTENT, BUILDER],
      reason: null,
    },
    {
      permission: "entity.note.read",
      workspaces: [CONTENT],
      reason: "To quote your notes in a post.",
    },
    {
      permission: "entity.task.update",
      workspaces: [CONTENT, BUILDER],
      reason: null,
    },
  ],
  podWide: [],
  templates: [],
  approved: [{ permission: "entity.post.read", workspaceId: "ws-content" }],
};

const html = (
  ask: ConsentAsk | null,
  opts: {
    contract?: ConsentContract | null;
    step?: Step;
    writePlace?: ConsentDraft | null;
  } = {}
) => {
  const offer = offerOf(APP);
  const view = askViewOf({ ask, contract: opts.contract ?? null, offer })!;
  return render(
    <Card>
      <AskConsent
        appName="Content Studio"
        view={view}
        offer={offer}
        current={askCurrentOf(APP, opts.contract ?? null)}
        names={{
          ...namesOfNamed(opts.contract?.current),
          ...placeNames(offer),
        }}
        busy={false}
        step={opts.step ?? { kind: "idle" }}
        onDecide={() => {}}
        writePlace={
          opts.writePlace
            ? { draft: opts.writePlace, onChange: () => {} }
            : null
        }
      />
    </Card>
  );
};

/** The Allow button's opening tag. */
const allow = (out: string) => {
  const at = out.search(/>(Allow|Try again)</);
  return out.slice(out.lastIndexOf("<button", at), at);
};

describe("the short consent", () => {
  it("leads with what it asks in It can's words (P1), marked New, with its reason; one Allow", () => {
    const out = html(ASK);
    expect(out).toContain("Read notes in Content OS");
    expect(out).toContain(">New<");
    expect(out).toContain("To quote your notes in a post.");
    expect(out).toContain("Details for developers");
    expect(out.match(/>Allow</g)).toHaveLength(1);
    expect(out).toContain("Not now");
    expect(out).toContain("What it already has stays as it is.");
  });

  it("In shows its current answer, Unchanged, with no door", () => {
    const out = html(ASK);
    expect(out).toContain('data-line="in"');
    expect(out).toContain(">Unchanged<");
    expect(out).not.toContain('aria-haspopup="dialog"');
  });

  it("links the app's page only once it is connected", () => {
    expect(html(ASK)).toContain('href="/apps/app_123"');
    expect(html({ ...ASK, connectionPublicId: null })).not.toContain(
      'href="/apps/'
    );
  });

  it("today's ask: a part no space can hold is left out, Allow still works", () => {
    const out = html({ ...ASK, unavailable: ["entity.post.create@team"] });
    expect(out).toContain("that part is left out");
    expect(allow(out)).not.toContain("disabled");
  });

  it("C2: the contract's ask is drawn when present; In comes from its current access, projects included; unavailable blocks Allow", () => {
    const contract: ConsentContract = {
      asked: { permissions: [], templates: [] },
      places: {
        read: { allSpaces: false, spaces: [], projects: [] },
        write: { spaces: [], projects: [], suggestedSpaceIds: [] },
      },
      current: {
        version: 2,
        permissions: ["entity.post.read"],
        read: {
          spaces: [
            { id: "ws-content", name: "Content OS", templateSlug: null },
          ],
          projects: [{ id: "p-l", name: "Launch", workspaceId: null }],
        },
        write: { spaces: [], projects: [] },
      },
      reconsent: null,
      ask: {
        title: "",
        adds: [
          {
            permission: "entity.task.read",
            tier: "read",
            reason: "To list tasks.",
            kindGroup: null,
            allSpaces: false,
            offerable: true,
          },
        ],
        needsWritePlace: false,
        unavailable: ["entity.deal.read"],
        connectionPublicId: "app_9",
      },
    };
    const out = html(ASK, { contract });
    expect(out).toContain("Read tasks");
    expect(out).not.toContain("Read notes");
    expect(out).toContain(
      "Content OS, or Launch".replace("Launch", "project Launch")
    );
    expect(out).toContain("connect it again to choose its places");
    expect(allow(out)).toContain("disabled");
  });

  it("U4/Q4: no write place yet: the ask's own space is pre-ticked and tagged Asked, only places within In, and no “never changes where it works”", () => {
    const offer = offerOf(APP);
    const draft = {
      ...firstDraft(offer),
      write: { spaces: ["ws-content"], projects: [] },
    };
    const out = html(ASK, { writePlace: draft });
    expect(out).toContain("Pick where it can make this change");
    expect(out).toContain("Only places it can already look in are listed.");
    expect(out).toContain(">Asked<");
    expect(out).not.toContain("Builder");
    expect(out).not.toContain("never changes where it works");
    expect(allow(out)).not.toContain("disabled");
    const none = html(ASK, {
      writePlace: { ...draft, write: { spaces: [], projects: [] } },
    });
    expect(none).toContain("Pick at least one place for it.");
    expect(allow(none)).toContain("disabled");
  });

  it("Allow failed: the alert, and Allow becomes Try again", () => {
    const out = html(ASK, { step: { kind: "error", message: "502" } });
    expect(out).toContain('role="alert"');
    expect(out).toContain(">Try again<");
  });
});

describe("the short ask's heading (N1, row 9)", () => {
  it("an unverified app is named by its domain, never by a title built from its own name", async () => {
    const { askHeading } = await import("./AskConsent");
    expect(
      askHeading({
        verified: false,
        serverTitle: "Synap Chat asks to also read notes in Content OS",
        appName: "studio.evil.example",
        count: 1,
      })
    ).toBe("studio.evil.example asks for one more thing");
    expect(
      askHeading({
        verified: true,
        serverTitle: "Content Studio asks to also read notes in Content OS",
        appName: "Content Studio",
        count: 1,
      })
    ).toBe("Content Studio asks to also read notes in Content OS");
  });
});
