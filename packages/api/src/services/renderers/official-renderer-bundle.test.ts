/**
 * The official renderer bundle's fetch and admission
 * (`installOfficialRendererBundle`): the Control Plane is the gate, so every
 * way it can refuse becomes a FORBIDDEN with a machine reason, and nothing
 * is installed on any refusal.
 *   - no CONTROL_PLANE_URL (a self-hosted pod) → renderer_bundle_no_control_plane,
 *     nothing fetched;
 *   - no pod-signed credential (none, or only the legacy key) →
 *     renderer_bundle_pod_not_enrolled, nothing fetched;
 *   - CP 403 OFFICIAL_BUNDLE_MANAGED_ONLY → renderer_bundle_managed_only;
 *   - CP 403 POD_JWT_REQUIRED → renderer_bundle_pod_not_enrolled;
 *   - a definition that names another slug or version, or Synap's catalog
 *     frozen → PRECONDITION_FAILED;
 *   - the happy path: the pod-signed GET of /internal/renderer-bundles/:slug/:version,
 *     then the install from source `synap`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  base: "https://cp.test" as string | null,
  auth: null as null | Record<string, unknown>,
  blocked: null as string | null,
  install: vi.fn(async (_def: unknown, _opts: unknown) => ({
    slug: "synap-renderers",
    version: "h-1",
    setSha256: "x",
    cells: [],
  })),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  podCpAuthHeaders: async () => h.auth,
}));
vi.mock("@synap-core/core/control-plane-url", () => ({
  controlPlaneBaseUrl: () => h.base,
}));
vi.mock("../capabilities/official-catalog-trust.js", () => ({
  officialCatalogStandingNow: async () => ({ blocked: h.blocked }),
}));
vi.mock("./install-renderer-bundle.js", () => ({
  installRendererBundle: h.install,
}));

import {
  installOfficialRendererBundle,
  RENDERER_BUNDLE_MANAGED_ONLY,
  RENDERER_BUNDLE_NO_CONTROL_PLANE,
  RENDERER_BUNDLE_POD_NOT_ENROLLED,
} from "./official-renderer-bundle.js";

const POD_JWT = {
  via: "pod-jwt",
  headers: { Authorization: "Bearer pod.jwt" },
  bearer: "pod.jwt",
};
const DEFINITION = {
  _meta: { slug: "synap-renderers", version: "h-1", kind: "renderer-bundle" },
};
const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
}
const install = (version: string | null = "h-1") =>
  installOfficialRendererBundle({
    slug: "synap-renderers",
    version,
    userId: "user-1",
  });
const refusal = async (p: Promise<unknown>) => {
  const err = (await p.catch((e: unknown) => e)) as {
    code?: string;
    cause?: { reasonCode?: string };
  };
  return { code: err.code, reason: err.cause?.reasonCode };
};

beforeEach(() => {
  h.base = "https://cp.test";
  h.auth = POD_JWT;
  h.blocked = null;
  h.install.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installOfficialRendererBundle", () => {
  it("a pod with no control plane is refused before any fetch", async () => {
    h.base = null;
    expect(await refusal(install())).toEqual({
      code: "FORBIDDEN",
      reason: RENDERER_BUNDLE_NO_CONTROL_PLANE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
  });

  it("a pod with no pod-signed credential is refused before any fetch", async () => {
    for (const auth of [
      null,
      { via: "internal-key", headers: { "X-Internal-Key": "k" } },
    ]) {
      h.auth = auth;
      expect(await refusal(install())).toEqual({
        code: "FORBIDDEN",
        reason: RENDERER_BUNDLE_POD_NOT_ENROLLED,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the control plane's managed-only refusal is the self-hosted refusal", async () => {
    answer(403, { error: "no", code: "OFFICIAL_BUNDLE_MANAGED_ONLY" });
    expect(await refusal(install())).toEqual({
      code: "FORBIDDEN",
      reason: RENDERER_BUNDLE_MANAGED_ONLY,
    });
    expect(h.install).not.toHaveBeenCalled();
  });

  it("the control plane asking for a pod-signed token reads as not enrolled", async () => {
    answer(403, { error: "no", code: "POD_JWT_REQUIRED" });
    expect(await refusal(install())).toEqual({
      code: "FORBIDDEN",
      reason: RENDERER_BUNDLE_POD_NOT_ENROLLED,
    });
  });

  it("an unknown bundle is NOT_FOUND", async () => {
    answer(404, { error: "Renderer bundle not found" });
    expect((await refusal(install())).code).toBe("NOT_FOUND");
  });

  it("a definition that names another bundle or version is refused", async () => {
    answer(200, {
      package: { definition: { _meta: { slug: "other", version: "h-1" } } },
    });
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    answer(200, {
      package: {
        definition: { _meta: { slug: "synap-renderers", version: "h-2" } },
      },
    });
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("Synap's catalog frozen: nothing installs", async () => {
    h.blocked = "Synap's catalog is paused.";
    answer(200, { package: { definition: DEFINITION } });
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("fetches with the pod-signed token and installs from source synap", async () => {
    answer(200, { package: { definition: DEFINITION } });
    await install();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://cp.test/internal/renderer-bundles/synap-renderers/h-1"
    );
    expect((init as RequestInit).headers).toEqual(POD_JWT.headers);
    expect(h.install).toHaveBeenCalledWith(DEFINITION, {
      userId: "user-1",
      source: "synap",
    });

    answer(200, { package: { definition: DEFINITION } });
    await install(null);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://cp.test/internal/renderer-bundles/synap-renderers"
    );
  });
});
