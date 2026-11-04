import { describe, expect, it } from "vitest";
import {
  canonicalPodUrl,
  InvalidPodAddressError,
  LOOPBACK_HOSTS,
  podUrlKey,
} from "./index";

/**
 * One pod, one key (fork 1.9, founder F6: a pod is its WHATWG origin). The six
 * key behaviours the copies had (strip one `/`, strip every `/`, lowercase the
 * host, lowercase everything, add `https://`, strict validation) each kept some
 * of these spellings apart; every one of them is the same pod.
 */
const POD = "https://pod.example.com";

describe("podUrlKey: every spelling of one pod is one key", () => {
  it.each([
    ["plain", "https://pod.example.com"],
    ["trailing slash", "https://pod.example.com/"],
    ["many trailing slashes", "https://pod.example.com///"],
    ["mixed-case host", "https://Pod.Example.COM"],
    ["mixed-case scheme", "HTTPS://pod.example.com"],
    ["explicit default port", "https://pod.example.com:443"],
    ["path present", "https://pod.example.com/api/hub/"],
    ["query and fragment", "https://pod.example.com/?x=1#y"],
    ["surrounding spaces", "  https://pod.example.com/  "],
    ["all at once", " HTTPS://POD.example.com:443//trpc/ "],
  ])("%s → the pod's origin", (_label, input) => {
    expect(podUrlKey(input)).toBe(POD);
  });

  it("keeps a non-default port and plain http: they are another origin", () => {
    expect(podUrlKey("http://localhost:4000/")).toBe("http://localhost:4000");
    expect(podUrlKey("http://LocalHost:4000")).toBe("http://localhost:4000");
    expect(podUrlKey("http://pod.example.com:80/")).toBe(
      "http://pod.example.com"
    );
    expect(podUrlKey("https://pod.example.com:8443")).toBe(
      "https://pod.example.com:8443"
    );
    expect(podUrlKey("http://pod.example.com")).not.toBe(POD);
  });

  it("a legacy-zone host is not its current-zone twin (F6: no aliasing)", () => {
    expect(podUrlKey("https://pod.alice.synap.live")).not.toBe(
      podUrlKey("https://alice.pod.synap.live")
    );
  });

  it.each([
    ["a bare host, no scheme", "pod.example.com"],
    ["a host:port, no scheme", "localhost:4000"],
    ["empty", ""],
    ["blank", "   "],
    ["not a URL", "not a url"],
    ["another scheme", "ftp://pod.example.com"],
    ["a custom scheme", "synap://pod.example.com"],
    ["no host", "https://"],
  ])("%s → null, never a guess", (_label, input) => {
    expect(podUrlKey(input)).toBeNull();
  });
});

describe("canonicalPodUrl: a typed pod address, checked strictly", () => {
  it.each([
    ["adds https:// to a bare host", "pod.example.com", POD],
    ["drops a trailing slash", "https://pod.example.com/", POD],
    ["drops every trailing slash", "https://pod.example.com///", POD],
    ["lowercases the host", "Pod.Example.COM", POD],
    ["drops the default port", "https://pod.example.com:443/", POD],
    ["trims", "  pod.example.com  ", POD],
    [
      "keeps a path, without its trailing slashes",
      "https://Pod.example.com/tenant//",
      "https://pod.example.com/tenant",
    ],
    [
      "keeps a non-default port",
      "pod.example.com:8443",
      "https://pod.example.com:8443",
    ],
  ])("%s", (_label, input, out) => {
    expect(canonicalPodUrl(input)).toBe(out);
  });

  it.each([
    ["empty", "   "],
    ["overlong", `https://${"a".repeat(510)}.com`],
    ["not a URL", "https://exa mple.com"],
    ["not https", "http://pod.example.com"],
    ["another scheme", "ftp://pod.example.com"],
    ["loopback", "localhost:4000"],
    ["loopback over https", "https://127.0.0.1"],
    ["ipv6", "https://[2001:db8::1]"],
    ["private ip", "https://10.0.0.5"],
    ["carrier-grade nat", "https://100.64.0.1"],
    ["link-local", "https://169.254.1.1"],
    ["all-digit host", "https://12345"],
    ["single label", "intranet"],
    [".internal", "pod.corp.internal"],
    [".local", "pod.local"],
    [".home.arpa", "pod.home.arpa"],
    ["credentials", "https://u:p@pod.example.com"],
    ["query", "https://pod.example.com/?x=1"],
    ["fragment", "https://pod.example.com/#x"],
  ])("refuses %s", (_label, input) => {
    let thrown: unknown;
    try {
      canonicalPodUrl(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidPodAddressError);
    expect(thrown).toMatchObject({ code: "invalid_pod_address" });
  });

  it("loopback over http only when allowed (development)", () => {
    const opts = { allowInsecureLoopback: true };
    expect(canonicalPodUrl("http://localhost:4000/", opts)).toBe(
      "http://localhost:4000"
    );
    expect(canonicalPodUrl("http://[::1]:4000", opts)).toBe(
      "http://[::1]:4000"
    );
    expect(() => canonicalPodUrl("http://localhost:4000")).toThrow(
      InvalidPodAddressError
    );
    // The allowance covers loopback only, never a private or plain-http host.
    expect(() => canonicalPodUrl("http://pod.example.com", opts)).toThrow(
      InvalidPodAddressError
    );
    expect(() => canonicalPodUrl("http://10.0.0.5", opts)).toThrow(
      InvalidPodAddressError
    );
  });

  it("its answer and podUrlKey agree on a pod with no path", () => {
    for (const input of ["Pod.Example.com/", "https://pod.example.com:443"]) {
      expect(podUrlKey(canonicalPodUrl(input))).toBe(canonicalPodUrl(input));
    }
  });

  it("names the loopback hosts as URL.hostname spells them", () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(
      ["127.0.0.1", "[::1]", "localhost"].sort()
    );
    expect(LOOPBACK_HOSTS.has(new URL("http://[::1]:4000").hostname)).toBe(
      true
    );
  });
});
