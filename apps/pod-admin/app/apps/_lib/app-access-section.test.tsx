/**
 * The app page's access (design A): the consent's three lines as Settings
 * rows, each a door showing its value; a connection whose pairs do not fit
 * one access keeps the per-space list (the section draws nothing).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { AppAccessSection } from "./app-access-section";
import type { PodAppInfo } from "./pod-app-view";

const pod = (approved: PodAppInfo["approved"]): PodAppInfo => ({
  client_id: "https://studio.synap.live/oauth/client.json",
  domain: "studio.synap.live",
  verified: true,
  approved,
  connected_at: null,
  last_used_at: null,
  write_mode: { applyAutomatically: false, writeMode: "review", line: "" },
});

const FITS = pod([
  {
    permission: "document.read",
    workspaceId: "w-content",
    workspaceName: "Content OS",
  },
  {
    permission: "entity.post.read",
    workspaceId: "w-content",
    workspaceName: "Content OS",
  },
  {
    permission: "entity.post.create",
    workspaceId: "w-content",
    workspaceName: "Content OS",
  },
]);

const html = (p: PodAppInfo) =>
  render(
    <AppAccessSection
      pod={p}
      appName={p.domain}
      onNarrow={async () => ({ ok: true })}
    />
  );

describe("the app page's access lines", () => {
  it("the same lines as the consent, each a Change door; the headline; names are doors to the place", () => {
    const out = html(FITS);
    expect(out).toContain('data-line="can"');
    expect(out).toContain('data-line="in"');
    expect(out).toContain('data-line="write"');
    expect(out.match(/>Change</g)).toHaveLength(3);
    expect(out).toContain('href="/open/workspace/w-content"');
    expect(out).toMatch(/Content OS\.<\/p>/);
    expect(out).toContain("A change applies at its next request.");
    expect(out).toMatch(/View<\/span> documents/);
  });

  it("pairs that do not fit one access: nothing here (the page keeps its per-space list)", () => {
    const out = html(
      pod([
        {
          permission: "entity.post.read",
          workspaceId: "w-content",
          workspaceName: "Content OS",
        },
        {
          permission: "document.read",
          workspaceId: "w-eco",
          workspaceName: "Ecosystem",
        },
      ])
    );
    expect(out).toBe("");
  });
});
