/**
 * Whether a new pod's server registered (plan a640c5bb B1): three answers,
 * never two. Only the Control Plane's own "never minted" or "not registered"
 * is a no; everything else that is not a clear yes is `unread`, which the TTL
 * sweeper never destroys on (a bare 404 may be a Control Plane without this
 * route yet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  base: "https://api.synap.test" as string | null,
  auth: { via: "pod-jwt", headers: { Authorization: "Bearer pod" } } as unknown,
}));

vi.mock("@synap-core/core/control-plane-url", () => ({
  controlPlaneBaseUrl: () => h.base,
}));
vi.mock("@synap/database", () => ({
  podCpAuthHeaders: vi.fn(async () => h.auth),
}));

import { podCpAuthHeaders } from "@synap/database";
import { readPodRegistrationStatus } from "./pod-registration-status.js";

const HASH = "ab".repeat(32);
const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
}

beforeEach(() => {
  h.base = "https://api.synap.test";
  h.auth = { via: "pod-jwt", headers: { Authorization: "Bearer pod" } };
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("readPodRegistrationStatus", () => {
  it("asks the Control Plane with the digest, as this pod, for purpose compute", async () => {
    answer(200, { registered: true, podId: "pod-9" });
    expect(await readPodRegistrationStatus(HASH)).toEqual({
      state: "registered",
      podId: "pod-9",
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://api.synap.test/internal/pod-registrations/${HASH}`
    );
    expect(fetchMock.mock.calls[0]![1].headers).toEqual({
      Authorization: "Bearer pod",
    });
    expect(podCpAuthHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "compute" })
    );
  });

  it("not registered, and a code the Control Plane never minted, are a no", async () => {
    answer(200, { registered: false });
    expect(await readPodRegistrationStatus(HASH)).toEqual({
      state: "not_registered",
    });
    answer(404, { code: "REGISTRATION_UNKNOWN", error: "unknown" });
    expect(await readPodRegistrationStatus(HASH)).toEqual({
      state: "not_registered",
    });
  });

  it.each([
    [
      "a bare 404 (a Control Plane without the route)",
      404,
      { error: "Not Found" },
    ],
    ["a refusal", 403, { code: "POD_LEGACY_AUTH_REFUSED" }],
    ["a failure", 500, { error: "boom" }],
    ["an answer with no verdict", 200, { ok: true }],
  ])("%s is unread, never a no", async (_label, status, body) => {
    answer(status, body);
    expect((await readPodRegistrationStatus(HASH)).state).toBe("unread");
  });

  it("no Control Plane, no credential, no answer, a malformed digest: unread", async () => {
    h.base = null;
    expect((await readPodRegistrationStatus(HASH)).state).toBe("unread");
    h.base = "https://api.synap.test";
    h.auth = null;
    expect((await readPodRegistrationStatus(HASH)).state).toBe("unread");
    h.auth = { via: "pod-jwt", headers: {} };
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await readPodRegistrationStatus(HASH)).state).toBe("unread");
    expect((await readPodRegistrationStatus("spr_raw")).state).toBe("unread");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
