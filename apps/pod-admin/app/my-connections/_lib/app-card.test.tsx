/**
 * A pod app's row on Connected (W3d): "Needs your review" when its old pairs
 * do not fit one access (Q3), and its reach read from the v2 access,
 * projects included. Rendered (react-dom/server; vitest runs in node).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { ComponentProps } from "react";
import { AppCard } from "./app-card";

type App = ComponentProps<typeof AppCard>["app"];

const base = {
  public_id: "app_1",
  name: "Content Studio",
  revoked_at: null,
  created_at: null,
  last_used_at: null,
  grants: [],
  keys: [],
  mode: "pod_app",
};
const access = {
  version: 2,
  permissions: ["entity.post.read"],
  read: {
    spaces: [{ id: "w-1", name: "Content OS", templateSlug: null }],
    projects: [{ id: "p-1", name: "Launch", workspaceId: null }],
  },
  write: { spaces: [], projects: [] },
};
const pod = (over: object) => ({
  client_id: "https://studio.synap.live/c.json",
  domain: "studio.synap.live",
  verified: true,
  approved: [],
  access: null,
  reconsent: null,
  connected_at: null,
  last_used_at: null,
  write_mode: { applyAutomatically: false, writeMode: "review", line: "" },
  ...over,
});

describe("a pod app on Connected", () => {
  it("its old pairs need a review: the mark says so", () => {
    const out = render(
      <AppCard
        app={
          {
            ...base,
            pod_app: pod({
              reconsent: { reason: "widens", was: [], proposed: access },
            }),
          } as unknown as App
        }
      />
    );
    expect(out).toContain("Needs your review");
  });

  it("its reach reads the v2 access, projects included", () => {
    const out = render(
      <AppCard app={{ ...base, pod_app: pod({ access }) } as unknown as App} />
    );
    expect(out).toContain("Content OS");
    expect(out).toContain("Launch");
    expect(out).not.toContain("Needs your review");
  });
});
