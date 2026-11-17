/**
 * The SHORT consent (plan 647ebfd4 option C): an app asks for one more
 * thing. Rendered (react-dom/server; pod-admin's vitest runs in node). Rows
 * rule out: the full matrix shown instead of the asked pairs, a second
 * primary action, a link to the app's page when there is no connection, and
 * a pair's words written here instead of the summary door.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { Card } from "@heroui/react";
import { AskConsent, type ConsentAsk } from "./AskConsent";

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

const html = (ask: ConsentAsk) =>
  render(
    <Card>
      <AskConsent
        appName="Content Studio"
        ask={ask}
        busy={false}
        step={{ kind: "idle" }}
        onDecide={() => {}}
      />
    </Card>
  );

describe("the short consent", () => {
  it("shows only the asked pair, in the summary's words, with one Allow", () => {
    const out = html(ASK);
    expect(out).toContain("Read Notes · Content OS");
    expect(out.match(/>Allow</g)).toHaveLength(1);
    expect(out).toContain("Not now");
    expect(out).toContain("What it already has stays as it is.");
  });

  it("links the app's page only once it is connected", () => {
    expect(html(ASK)).toContain('href="/apps/app_123"');
    expect(html({ ...ASK, connectionPublicId: null })).not.toContain(
      "See everything it has"
    );
  });

  it("says when part of the ask cannot be given", () => {
    expect(html(ASK)).not.toContain("left out");
    expect(
      html({ ...ASK, unavailable: ["entity.post.create@team"] })
    ).toContain("that part is left out");
  });
});
