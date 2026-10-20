import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentApprovalPageUrl,
  isPodAdminOrigin,
  toPodAdminOrigin,
} from "./pod-admin-origin.js";

const KEYS = ["POD_ADMIN_URL", "POD_ADMIN_DOMAIN", "PUBLIC_URL", "NODE_ENV"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("toPodAdminOrigin", () => {
  it("a <name>.pod.synap.live pod's console is admin.<name>.pod.synap.live", () => {
    expect(toPodAdminOrigin("https://alice.pod.synap.live")).toBe(
      "https://admin.alice.pod.synap.live"
    );
  });

  it("a tenant zone names no console: the origin comes back unchanged", () => {
    expect(toPodAdminOrigin("https://pod.synap.live")).toBe(
      "https://pod.synap.live"
    );
  });

  it("a nested pod's console is pod-admin.<name>", () => {
    expect(toPodAdminOrigin("https://pod.alice.synap.live")).toBe(
      "https://pod-admin.alice.synap.live"
    );
  });

  it("a legacy flat pod's console is <name>-admin, never pod-admin.<zone>", () => {
    expect(toPodAdminOrigin("https://alice.synap.live")).toBe(
      "https://alice-admin.synap.live"
    );
    expect(toPodAdminOrigin("https://alice.synap.live")).not.toBe(
      "https://pod-admin.synap.live"
    );
  });

  it("the configured console wins over any convention", () => {
    process.env.POD_ADMIN_URL = "https://console.mycorp.io";
    process.env.POD_ADMIN_DOMAIN = "console.mycorp.io";
    expect(toPodAdminOrigin("https://synap.mycorp.io")).toBe(
      "https://console.mycorp.io"
    );
    expect(toPodAdminOrigin("https://alice.synap.live")).toBe(
      "https://console.mycorp.io"
    );
  });

  it("an invalid POD_ADMIN_URL is ignored, not followed", () => {
    process.env.POD_ADMIN_URL = "https://console.mycorp.io/path";
    expect(toPodAdminOrigin("https://pod.alice.synap.live")).toBe(
      "https://pod-admin.alice.synap.live"
    );
  });

  it("localhost goes to the local console dev server", () => {
    expect(toPodAdminOrigin("http://localhost:4000")).toBe(
      "http://localhost:4040"
    );
  });
});

describe("approval links and the console origin check", () => {
  it("a <name>.pod.synap.live pod's approval link names admin.<name>.pod.synap.live", () => {
    process.env.PUBLIC_URL = "https://alice.pod.synap.live";
    expect(
      agentApprovalPageUrl("http://backend:4000/x", "k1", "claude-code")
    ).toBe(
      "https://admin.alice.pod.synap.live/approve-agent/k1?agentType=claude-code"
    );
  });

  it("a <name>.pod.synap.live pod: only its own console passes, not another tenant's nor its old name", () => {
    process.env.PUBLIC_URL = "https://alice.pod.synap.live";
    const req = "http://backend:4000/x";
    expect(isPodAdminOrigin("https://admin.alice.pod.synap.live", req)).toBe(
      true
    );
    expect(isPodAdminOrigin("https://admin.bob.pod.synap.live", req)).toBe(
      false
    );
    expect(isPodAdminOrigin("https://pod-admin.alice.synap.live", req)).toBe(
      false
    );
    expect(isPodAdminOrigin("https://shop.alice.pod.synap.live", req)).toBe(
      false
    );
  });

  it("a flat pod's approval link names its own console", () => {
    process.env.PUBLIC_URL = "https://alice.synap.live";
    expect(
      agentApprovalPageUrl("http://backend:4000/x", "k1", "claude-code")
    ).toBe(
      "https://alice-admin.synap.live/approve-agent/k1?agentType=claude-code"
    );
  });

  it("only this pod's console passes the origin check", () => {
    process.env.PUBLIC_URL = "https://alice.synap.live";
    const req = "http://backend:4000/x";
    expect(isPodAdminOrigin("https://alice-admin.synap.live", req)).toBe(true);
    expect(isPodAdminOrigin("https://pod-admin.synap.live", req)).toBe(false);
    expect(isPodAdminOrigin("https://bob-admin.synap.live", req)).toBe(false);
  });
});
