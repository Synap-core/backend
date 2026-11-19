/**
 * The SHORT consent (plan 647ebfd4 option C; design A "short ask"): an app
 * asks for one more thing. Rendered (react-dom/server; pod-admin's vitest
 * runs in node). Rows rule out: the full consent shown instead of the asked
 * pairs, a second primary action, a link to the app's page when there is no
 * connection, a pair's words written here instead of the summary door, and
 * "In" shown as if it could change here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { Card } from "@heroui/react";
import {
  AskConsent,
  askCount,
  type AskApp,
  type ConsentAsk,
} from "./AskConsent";
import { offerOf, firstDraft } from "./consent-access";
import type { Step } from "./ConsentForm";

const CONTENT = {
  workspaceId: "ws-content",
  workspaceName: "Content OS",
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

const APP: AskApp = {
  permissions: [
    { permission: "entity.post.read", workspaces: [CONTENT], reason: null },
    {
      permission: "entity.note.read",
      workspaces: [CONTENT],
      reason: "To quote your notes in a post.",
    },
  ],
  podWide: [],
  templates: [],
  approved: [{ permission: "entity.post.read", workspaceId: "ws-content" }],
};

const html = (
  ask: ConsentAsk,
  opts: { app?: AskApp; step?: Step; writePlace?: boolean } = {}
) => {
  const app = opts.app ?? APP;
  const draft = {
    ...firstDraft(offerOf(app)),
    write: { spaces: [], projects: [] },
  };
  return render(
    <Card>
      <AskConsent
        app={app}
        appName="Content Studio"
        ask={ask}
        busy={false}
        step={opts.step ?? { kind: "idle" }}
        onDecide={() => {}}
        writePlace={opts.writePlace ? { draft, onChange: () => {} } : null}
      />
    </Card>
  );
};

describe("the short consent", () => {
  it("shows only the asked pair, in the summary's words, marked New, with its reason, one Allow", () => {
    const out = html(ASK);
    expect(out).toContain("Read Notes · Content OS");
    expect(out).toContain(">New<");
    expect(out).toContain("To quote your notes in a post.");
    expect(out).toContain("entity.note.read");
    expect(out.match(/>Allow</g)).toHaveLength(1);
    expect(out).toContain("Not now");
    expect(out).toContain("What it already has stays as it is.");
    expect(askCount(ASK)).toBe(1);
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

  it("says when part of the ask cannot be given", () => {
    expect(html(ASK)).not.toContain("left out");
    expect(
      html({ ...ASK, unavailable: ["entity.post.create@team"] })
    ).toContain("that part is left out");
  });

  it("no write place yet (Q4): where it may change things is a new choice, and Allow waits for it", () => {
    const app: AskApp = {
      ...APP,
      permissions: [
        ...APP.permissions,
        {
          permission: "entity.task.update",
          workspaces: [CONTENT],
          reason: null,
        },
      ],
    };
    const out = html(
      {
        ...ASK,
        pairs: [
          {
            permission: "entity.task.update",
            workspaceId: "ws-content",
            workspaceName: "Content OS",
          },
        ],
      },
      { app, writePlace: true }
    );
    expect(out).toContain("Pick where it can make this change");
    expect(out).toContain("It changes nothing yet, so this is a new choice.");
    expect(out).toContain("Pick at least one place for it.");
    const at = out.indexOf(">Allow<");
    const button = out.slice(out.lastIndexOf("<button", at), at);
    expect(button).toContain("disabled");
  });

  it("Allow failed: the alert, and Allow becomes Try again", () => {
    const out = html(ASK, { step: { kind: "error", message: "502" } });
    expect(out).toContain('role="alert"');
    expect(out).toContain(">Try again<");
  });
});
