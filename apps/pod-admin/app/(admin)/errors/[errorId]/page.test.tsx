/**
 * One server error's page, drawn by the REAL page over a tRPC stub that
 * answers `system.getServerFault`. An approval's fault (door "proposal",
 * written by `recordProposalFault`) answered no HTTP request: no "HTTP" chip,
 * no made-up request path, and its proposal is a door to pod admin's own
 * review page. A request's fault keeps both.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const ERROR_ID = "0b1f6a3e-5c2d-4e8f-9a7b-3c4d5e6f7a8b";
const PROPOSAL_ID = "7ad8bdde-3c1b-4f5e-9a2d-0b6c1e4f8a10";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ fault: null as unknown }));

vi.mock("../../../../lib/trpc", () => ({
  trpc: {
    system: {
      getServerFault: {
        useQuery: () => ({
          data: h.fault,
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
    },
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ errorId: ERROR_ID }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../../_lib/object/use-reauth", () => ({
  useReauthOnUnauthorized: () => undefined,
}));
// The console's chrome is not this seam: draw the object page alone.
vi.mock("../../../_lib/object/views/object-frame", async () => {
  const { ObjectPage } = await import("../../../_lib/object/object-page");
  return {
    consoleFrame: () => ({
      loading: (label: string) => <p>{label}</p>,
      failure: () => <p>failed</p>,
      object: (props: Parameters<typeof ObjectPage>[0]) => (
        <ObjectPage {...props} />
      ),
    }),
  };
});

import ServerErrorPage from "./page";

const base = {
  errorId: ERROR_ID,
  occurredAt: "2026-11-18T09:00:00.000Z",
  errorName: "Error",
  message: "db exploded",
  stack: null,
  causes: [],
  userId: null,
  agentUserId: null,
};

beforeEach(() => {
  h.fault = null;
});

describe("an approval's server error (door: proposal)", () => {
  beforeEach(() => {
    h.fault = {
      ...base,
      door: "proposal",
      method: null,
      path: `/proposal/${PROPOSAL_ID}`,
      status: 500,
    };
  });

  it("shows no HTTP status: no request ever happened", () => {
    const html = renderToStaticMarkup(<ServerErrorPage />);
    expect(html).toContain("db exploded");
    expect(html).not.toContain("HTTP");
  });

  it("links its proposal to pod admin's review page, never shows the path as a request", () => {
    const html = renderToStaticMarkup(<ServerErrorPage />);
    expect(html).toContain(`href="/proposal/${PROPOSAL_ID}"`);
    expect(html).toContain("Open the proposal");
    expect(html).not.toContain(">Request<");
    // Not as the header's summary either (the raw record may still hold it).
    expect(html).not.toContain(`>/proposal/${PROPOSAL_ID}<`);
  });

  it("with no caller recorded, says nothing about sign-in: the proposal names its owner", () => {
    const html = renderToStaticMarkup(<ServerErrorPage />);
    expect(html).not.toContain("Before sign-in");
    expect(html).not.toContain(">Caller<");
  });
});

describe("a request's server error", () => {
  it("keeps its HTTP status and its request, mono, with no proposal link", () => {
    h.fault = {
      ...base,
      door: "rest",
      method: "POST",
      path: "/api/hub/packages/apply",
      status: 502,
      userId: USER_ID,
    };
    const html = renderToStaticMarkup(<ServerErrorPage />);
    expect(html).toContain("HTTP 502");
    expect(html).toContain("POST /api/hub/packages/apply");
    expect(html).not.toContain("Open the proposal");
    expect(html).toContain(USER_ID);
  });
});
