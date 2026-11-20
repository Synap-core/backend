/**
 * The app page's access (design A over W3d): the consent's three lines as
 * Settings rows, from `apps.accessOffer`, saved through `apps.updateAccess`
 * (projects included, widening within the ask). Rendered with the query and
 * the presence door mocked (react-dom/server; vitest runs in node).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";

const state: { data: unknown; isError: boolean } = {
  data: null,
  isError: false,
};
vi.mock("../../../lib/trpc", () => ({
  trpc: {
    apps: {
      accessOffer: {
        useQuery: () => ({
          data: state.data,
          isError: state.isError,
          isLoading: false,
          isFetching: false,
          refetch: () => Promise.resolve(),
        }),
      },
    },
  },
}));
vi.mock("../../_lib/presence/use-sensitive-actions", () => ({
  useUpdateAppAccess: () => ({ mutateAsync: async () => ({}) }),
}));

import { AppAccessSection } from "./app-access-section";
import type { PodAppInfo } from "./pod-app-view";
import type { AccessOfferView } from "../../oauth/consent/consent-access";

const CONTENT = { id: "w-content", name: "Content OS", templateSlug: null };
const ECO = { id: "w-eco", name: "Ecosystem", templateSlug: null };
const LAUNCH = { id: "p-launch", name: "Launch", workspaceId: null };

const pod: PodAppInfo = {
  client_id: "https://studio.synap.live/oauth/client.json",
  domain: "studio.synap.live",
  verified: true,
  approved: [],
  connected_at: null,
  last_used_at: null,
  write_mode: { applyAutomatically: false, writeMode: "review", line: "" },
};

/** Pinned to the generated `apps.accessOffer` output (W3d). */
const offer = (over: Partial<AccessOfferView> = {}): AccessOfferView => ({
  asked: {
    permissions: [
      {
        permission: "entity.post.read",
        tier: "read",
        reason: null,
        kindGroup: null,
        allSpaces: false,
        offerable: true,
      },
      {
        permission: "entity.post.create",
        tier: "write",
        reason: null,
        kindGroup: null,
        allSpaces: false,
        offerable: true,
      },
      {
        permission: "document.read",
        tier: "read",
        reason: null,
        kindGroup: null,
        allSpaces: false,
        offerable: true,
      },
    ],
    templates: [],
  },
  places: {
    read: { allSpaces: false, spaces: [CONTENT, ECO], projects: [LAUNCH] },
    write: {
      spaces: [CONTENT, ECO],
      projects: [LAUNCH],
      suggestedSpaceIds: [],
    },
  },
  current: {
    version: 2,
    permissions: ["entity.post.read", "entity.post.create", "document.read"],
    read: { spaces: [CONTENT], projects: [] },
    write: { spaces: [CONTENT], projects: [] },
  },
  reconsent: null,
  ...over,
});

const html = (data: AccessOfferView | null, isError = false) => {
  state.data = data;
  state.isError = isError;
  return render(
    <AppAccessSection
      pod={pod}
      publicId="app_1"
      appName="Content Studio"
      onChanged={() => {}}
    />
  );
};

describe("the app page's access lines", () => {
  it("the same lines as the consent, each a Change door; the headline; names are doors to the place", () => {
    const out = html(offer());
    expect(out).toContain('data-line="can"');
    expect(out).toContain('data-line="in"');
    expect(out).toContain('data-line="write"');
    expect(out.match(/>Change</g)).toHaveLength(3);
    expect(out).toContain('href="/open/workspace/w-content"');
    expect(out).toMatch(/View<\/span> documents/);
    expect(out).toContain("A change applies now");
  });

  it("an access that names a project keeps its doors: updateAccess holds projects", () => {
    const out = html(
      offer({
        current: {
          version: 2,
          permissions: ["entity.post.read"],
          read: { spaces: [CONTENT], projects: [LAUNCH] },
          write: { spaces: [], projects: [] },
        },
      })
    );
    expect(out.match(/>Change</g)?.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("project Launch");
    expect(out).toContain('href="/open/project/p-launch"');
  });

  it("old pairs that do not fit one access: the proposed form, with Confirm", () => {
    const current = offer().current!;
    const out = html(
      offer({
        current: null,
        reconsent: { reason: "widens", was: [], proposed: current },
      })
    );
    expect(out).toContain("One thing to confirm");
    expect(out).toContain(">Confirm<");
    expect(out).toContain('data-line="in"');
  });

  it("the offer could not be read: a failure with its retry, never empty lines", () => {
    const out = html(null, true);
    expect(out).toContain('role="alert"');
    expect(out).toContain(">Try again<");
    expect(out).not.toContain('data-line="can"');
  });
});
