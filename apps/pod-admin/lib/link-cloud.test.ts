import { describe, expect, it, vi } from "vitest";
import {
  claimAccessFinishUrl,
  claimAccessStartUrl,
  linkThisPod,
  readLinkCloudFragment,
} from "./link-cloud";

const INTENT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("readLinkCloudFragment", () => {
  it("reads each thing the CP sends", () => {
    expect(readLinkCloudFragment("")).toEqual({ kind: "start" });
    expect(readLinkCloudFragment("#linked")).toEqual({ kind: "linked" });
    expect(readLinkCloudFragment("#cancelled")).toEqual({
      kind: "cancelled",
    });
    expect(readLinkCloudFragment(`#intent=${INTENT}&assertion=a.b.c`)).toEqual({
      kind: "ceremony",
      intentId: INTENT,
      assertion: "a.b.c",
    });
  });

  it("anything else is broken, never a ceremony", () => {
    for (const hash of [
      "#intent=not-a-uuid&assertion=a.b.c",
      `#intent=${INTENT}`,
      "#assertion=a.b.c",
      "#whatever",
    ]) {
      expect(readLinkCloudFragment(hash)).toEqual({ kind: "broken" });
    }
  });
});

describe("the CP addresses come from this pod's issuer only", () => {
  it("start names this pod's host, and nothing of the fragment", () => {
    expect(
      claimAccessStartUrl(
        "https://api.synap.live/",
        "https://home.pod.synap.live"
      )
    ).toBe(
      "https://api.synap.live/pods/claim-access/start?pod=home.pod.synap.live"
    );
  });

  it("finish carries the receipt in the fragment, never the query", () => {
    const url = new URL(
      claimAccessFinishUrl("https://api.synap.live", INTENT, "r-1")!
    );
    expect(url.origin).toBe("https://api.synap.live");
    expect(url.pathname).toBe("/pods/claim-access/finish");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("receipt")).toBe("r-1");
  });

  it("refuses an issuer that is not an https origin", () => {
    expect(claimAccessStartUrl("http://api.synap.live", "https://p.x")).toBe(
      null
    );
    expect(claimAccessFinishUrl("javascript:alert(1)", INTENT, "r")).toBe(null);
  });
});

describe("linkThisPod", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("posts the assertion to this pod's door with the session and returns the receipt", async () => {
    const f = reply(200, { success: true, receiptId: "r-9" });
    await expect(
      linkThisPod("https://home.pod.synap.live/", "a.b.c", f)
    ).resolves.toEqual({ ok: true, receiptId: "r-9" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://home.pod.synap.live/api/federation/identity-links"
    );
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ assertion: "a.b.c" });
  });

  it("names each refusal", async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: "Unauthorized" }, "signed_out"],
      [
        403,
        {
          error: "Synap Cloud sign-in is turned off for this pod.",
          code: "CLOUD_SIGN_IN_DISABLED",
        },
        "turned_off",
      ],
      [
        401,
        { error: "Invalid issuer identity-link assertion" },
        "assertion_refused",
      ],
      [
        409,
        { error: "Could not link this Pod identity" },
        "already_linked_elsewhere",
      ],
      [503, { error: "Identity link unavailable" }, "failed"],
    ];
    for (const [status, body, reason] of cases) {
      const r = await linkThisPod("https://p.x", "a", reply(status, body));
      expect(r.ok ? null : r.reason, String(status)).toBe(reason);
    }
  });
});
