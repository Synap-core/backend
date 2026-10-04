import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readRecoveryFragment,
  recoveryApi,
  recoveryCodesFile,
  visibleDoors,
} from "./account-recovery";

describe("visibleDoors — only what works on this pod, one order", () => {
  it("omits doors that don't work", () => {
    expect(visibleDoors({ recoveryCode: false, email: false, cloud: false })).toEqual([]);
    expect(visibleDoors({ recoveryCode: true, email: false, cloud: false })).toEqual(["code"]);
    expect(visibleDoors({ recoveryCode: false, email: true, cloud: true })).toEqual(["email", "cloud"]);
    expect(visibleDoors({ recoveryCode: true, email: true, cloud: true })).toEqual(["code", "email", "cloud"]);
  });
});

describe("readRecoveryFragment", () => {
  it("reads the one-time Kratos code from the fragment", () => {
    expect(readRecoveryFragment("#code=482913")).toBe("482913");
    expect(readRecoveryFragment("#x=1&code=482913")).toBe("482913");
  });
  it("refuses anything that is not a numeric one-time code", () => {
    expect(readRecoveryFragment("")).toBeNull();
    expect(readRecoveryFragment("#code=")).toBeNull();
    expect(readRecoveryFragment("#code=<script>")).toBeNull();
    expect(readRecoveryFragment("#nocode=1")).toBeNull();
  });
});

describe("recoveryCodesFile", () => {
  it("carries every code and where they work", () => {
    const text = recoveryCodesFile({
      codes: ["AAAA-BBBB-CCCC-DDDD", "EEEE-FFFF-GGGG-HHHH"],
      podUrl: "https://pod.example.com",
      email: "owner@example.com",
      createdAt: "2026-10-04T10:00:00.000Z",
    });
    expect(text).toContain("AAAA-BBBB-CCCC-DDDD");
    expect(text).toContain("EEEE-FFFF-GGGG-HHHH");
    expect(text).toContain("https://pod.example.com");
    expect(text).toContain("owner@example.com");
  });
});

describe("recoveryApi — a failed read is a failure, never an empty answer", () => {
  beforeEach(() => {
    process.env.POD_PUBLIC_URL = "https://pod.example.com";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.POD_PUBLIC_URL;
  });

  it("passes the pod's error code through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_code", message: "nope" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const r = await recoveryApi.redeem("a@b.c", "X");
    expect(r).toEqual({ ok: false, status: 401, error: "invalid_code", message: "nope" });
  });

  it("a 503 with no JSON is recovery_unavailable; a thrown fetch is network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 503 })));
    const a = await recoveryApi.doors();
    expect(a.ok).toBe(false);
    expect(!a.ok && a.error).toBe("recovery_unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const b = await recoveryApi.doors();
    expect(!b.ok && b.error).toBe("network");
  });

  it("talks to the pod's public API with the session cookie", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", f);
    await recoveryApi.status();
    expect(f).toHaveBeenCalledWith(
      "https://pod.example.com/api/account-recovery/status",
      expect.objectContaining({ credentials: "include" })
    );
  });
});
