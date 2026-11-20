/**
 * The official renderer bundle's fetch and admission
 * (`installOfficialRendererBundle`): the Control Plane is the delivery gate,
 * Synap's signed index the authenticity check. Nothing is installed on any
 * refusal.
 *   - no CONTROL_PLANE_URL (a pod no control plane knows) → renderer_bundle_no_control_plane,
 *     nothing fetched;
 *   - a CONTROL_PLANE_URL over plain http (but localhost / 127.0.0.1) →
 *     renderer_bundle_insecure_control_plane, no credential minted;
 *   - no pod-signed credential (none, or only the legacy key) →
 *     renderer_bundle_pod_not_enrolled, nothing fetched;
 *   - CP 403 OFFICIAL_BUNDLE_PLAN_REQUIRED → renderer_bundle_plan_required, and
 *     CP 403 OFFICIAL_BUNDLE_POD_NOT_LIVE → renderer_bundle_pod_not_live;
 *   - CP 403 POD_JWT_REQUIRED → renderer_bundle_pod_not_enrolled;
 *   - AUTHENTICITY, through the real `assertOfficialDefinition` and
 *     `checkOfficialListing`: a definition the signed index lists under
 *     (`renderer-bundle`, slug) with the row's version and digest installs;
 *     a tampered one, an unlisted one, a version the index does not list are
 *     refused under enforcement (MARKET_OFFICIAL_UNVERIFIED); report mode
 *     logs and installs, as for every official kind; no trust anchor
 *     installs; a definition naming another slug or a row at another version
 *     than asked is refused in every mode;
 *   - VERSION: the CP row's `package.version` is what is checked and stored,
 *     never `_meta.version`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";

const h = vi.hoisted(() => ({
  base: "https://cp.test" as string | null,
  auth: null as null | Record<string, unknown>,
  authCalls: 0,
  signature: null as Record<string, unknown> | null,
  digests: new Map<string, { version: string; contentHash: string }>(),
  install: vi.fn(async (_def: unknown, opts: { version: string }) => ({
    slug: "synap-renderers",
    version: opts.version,
    setSha256: "x",
    cells: [],
  })),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  podCpAuthHeaders: async () => {
    h.authCalls += 1;
    return h.auth;
  },
  readMarketplaceSources: async () => ({
    sources: [],
    official: null,
    status: {},
    tombstones: {},
    officialSignature: h.signature,
  }),
  readOfficialCatalogDigest: async (kind: string, slug: string) => {
    const d = h.digests.get(`${kind}|${slug}`);
    return d
      ? { kind, slug, ...d, requiredTier: null, syncedAt: new Date() }
      : null;
  },
}));
vi.mock("@synap-core/core/control-plane-url", () => ({
  controlPlaneBaseUrl: () => h.base,
}));
vi.mock("./install-renderer-bundle.js", () => ({
  installRendererBundle: h.install,
}));

import { officialContentHash } from "@synap/jobs/workers/marketplace-source-verify.js";
import {
  installOfficialRendererBundle,
  RENDERER_BUNDLE_INSECURE_CONTROL_PLANE,
  RENDERER_BUNDLE_NO_CONTROL_PLANE,
  RENDERER_BUNDLE_PLAN_REQUIRED,
  RENDERER_BUNDLE_POD_NOT_ENROLLED,
  RENDERER_BUNDLE_POD_NOT_LIVE,
} from "./official-renderer-bundle.js";

const POD_JWT = {
  via: "pod-jwt",
  headers: { Authorization: "Bearer pod.jwt" },
  bearer: "pod.jwt",
};
/** `_meta.version` is NOT the row's: the CP ignores it, so does the pod. */
const DEFINITION = {
  _meta: {
    slug: "synap-renderers",
    version: "1.0.0-build",
    kind: "renderer-bundle",
  },
  bundleApi: 1,
  reactVersion: "19.2.3",
  kitExports: ["Card"],
};
const HASH = officialContentHash("renderer-bundle", DEFINITION);
const VERSION = `h-${HASH.slice(0, 12)}`;
const TAMPERED = { ...DEFINITION, kitExports: ["Card", "Exfiltrate"] };

const KEY = (() => {
  const jwk = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as { x: string };
  return Buffer.from(jwk.x, "base64url").toString("base64");
})();
const okStatus = () => ({
  state: "ok",
  lastCheckAt: new Date().toISOString(),
  lastOkAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 7 * 864e5).toISOString(),
  keysVersion: null,
  keyFingerprint: "f".repeat(64),
  packageCount: 1,
  unverifiedRows: 0,
  message: null,
});
const ENV = [
  "SYNAP_CATALOG_PUBLIC_KEYS",
  "SYNAP_CATALOG_ENFORCE_SIGNATURE",
  "SYNAP_CATALOG_ALLOW_EXPIRED",
] as const;
const saved: Record<string, string | undefined> = {};
/** Operator keys set: the index is checked; `enforce` refuses. */
const signed = (enforce: boolean) => {
  process.env.SYNAP_CATALOG_PUBLIC_KEYS = KEY;
  if (enforce) process.env.SYNAP_CATALOG_ENFORCE_SIGNATURE = "1";
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
/** The CP's row: `package.version` is the row's, `h-` + 12 hex of the digest. */
const served = (definition: unknown = DEFINITION, version = VERSION) =>
  answer(200, {
    package: {
      slug: "synap-renderers",
      version,
      displayName: "Synap renderers",
      description: "",
      category: "renderer-bundle",
      definition,
    },
  });
const install = (version: string | null = VERSION) =>
  installOfficialRendererBundle({
    slug: "synap-renderers",
    version,
    userId: "user-1",
  });
const refusal = async (p: Promise<unknown>) => {
  const err = (await p.catch((e: unknown) => e)) as {
    code?: string;
    cause?: { reasonCode?: string; code?: string };
  };
  return {
    code: err.code,
    reason: err.cause?.reasonCode ?? err.cause?.code,
  };
};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  h.base = "https://cp.test";
  h.auth = POD_JWT;
  h.authCalls = 0;
  h.signature = okStatus();
  h.digests = new Map([
    [
      "renderer-bundle|synap-renderers",
      { version: VERSION, contentHash: HASH },
    ],
  ]);
  h.install.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("installOfficialRendererBundle: delivery", () => {
  it("a pod with no control plane is refused before any fetch", async () => {
    h.base = null;
    expect(await refusal(install())).toEqual({
      code: "FORBIDDEN",
      reason: RENDERER_BUNDLE_NO_CONTROL_PLANE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
  });

  it("a control plane over plain http is refused before any credential is minted", async () => {
    for (const base of [
      "http://cp.example.com",
      "http://10.0.0.5:3000",
      "ftp://cp.example.com",
      "not a url",
    ]) {
      h.base = base;
      expect(await refusal(install()), base).toEqual({
        code: "FORBIDDEN",
        reason: RENDERER_BUNDLE_INSECURE_CONTROL_PLANE,
      });
    }
    expect(h.authCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
  });

  it("http on localhost or 127.0.0.1 is development, and goes on", async () => {
    for (const base of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      h.base = base;
      served();
      await install();
      expect(fetchMock.mock.calls.at(-1)![0]).toBe(
        `${base}/internal/renderer-bundles/synap-renderers/${VERSION}`
      );
    }
    expect(h.install).toHaveBeenCalledTimes(2);
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

  it("the control plane's plan and not-running refusals keep their own reasons", async () => {
    for (const [code, reason] of [
      ["OFFICIAL_BUNDLE_PLAN_REQUIRED", RENDERER_BUNDLE_PLAN_REQUIRED],
      ["OFFICIAL_BUNDLE_POD_NOT_LIVE", RENDERER_BUNDLE_POD_NOT_LIVE],
    ] as const) {
      answer(403, { error: "no", code });
      expect(await refusal(install()), code).toEqual({
        code: "FORBIDDEN",
        reason,
      });
    }
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

  it("a row with no version is not installed", async () => {
    answer(200, { package: { definition: DEFINITION } });
    expect((await refusal(install())).code).toBe("INTERNAL_SERVER_ERROR");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("fetches with the pod-signed token and installs from source synap at the row's version", async () => {
    served();
    await install();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://cp.test/internal/renderer-bundles/synap-renderers/${VERSION}`
    );
    expect((init as RequestInit).headers).toEqual(POD_JWT.headers);
    expect(h.install).toHaveBeenCalledWith(DEFINITION, {
      userId: "user-1",
      source: "synap",
      version: VERSION,
    });

    served();
    await install(null);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://cp.test/internal/renderer-bundles/synap-renderers"
    );
  });
});

describe("installOfficialRendererBundle: authenticity (the signed index)", () => {
  it("enforce: listed with the row's version and digest installs", async () => {
    signed(true);
    served();
    const out = await install();
    expect(out.version).toBe(VERSION);
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it("enforce: a definition changed after signing is refused", async () => {
    signed(true);
    served(TAMPERED);
    expect(await refusal(install())).toEqual({
      code: "PRECONDITION_FAILED",
      reason: "MARKET_OFFICIAL_UNVERIFIED",
    });
    expect(h.install).not.toHaveBeenCalled();
  });

  it("enforce: a bundle the signed index does not list is refused", async () => {
    signed(true);
    h.digests.clear();
    served();
    expect(await refusal(install())).toEqual({
      code: "PRECONDITION_FAILED",
      reason: "MARKET_OFFICIAL_UNVERIFIED",
    });
    // Listed under another kind is not listed.
    h.digests.set("template|synap-renderers", {
      version: VERSION,
      contentHash: HASH,
    });
    served();
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("enforce: a row version the signed index does not list is refused", async () => {
    signed(true);
    served(DEFINITION, "h-000000000000");
    expect((await refusal(install("h-000000000000"))).code).toBe(
      "PRECONDITION_FAILED"
    );
    expect(h.install).not.toHaveBeenCalled();
  });

  it("report mode: a tampered or unlisted bundle is logged and installed, as every official kind", async () => {
    signed(false);
    served(TAMPERED);
    await install();
    h.digests.clear();
    served();
    await install();
    expect(h.install).toHaveBeenCalledTimes(2);
  });

  it("no trust anchor: installed unchecked, as every official kind", async () => {
    h.digests.clear();
    served(TAMPERED);
    await install();
    expect(h.install).toHaveBeenCalledTimes(1);
  });

  it("every mode: another slug, or a row at another version than asked, is refused", async () => {
    answer(200, {
      package: {
        version: VERSION,
        definition: { ...DEFINITION, _meta: { slug: "other" } },
      },
    });
    expect(await refusal(install())).toEqual({
      code: "PRECONDITION_FAILED",
      reason: "MARKET_OFFICIAL_UNVERIFIED",
    });
    served(DEFINITION, "h-111111111111");
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    expect(h.install).not.toHaveBeenCalled();
  });

  it("enforce: Synap's catalog frozen, nothing installs", async () => {
    signed(true);
    h.signature = { ...okStatus(), state: "bad_signature", message: "no" };
    served();
    expect((await refusal(install())).code).toBe("PRECONDITION_FAILED");
    expect(h.install).not.toHaveBeenCalled();
  });
});
