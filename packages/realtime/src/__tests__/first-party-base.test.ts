import { describe, expect, it } from "vitest";
import { realtimeFirstPartyBase } from "../first-party-base.js";

describe("realtimeFirstPartyBase", () => {
  it("keeps a self-hosted pod's own parent", () => {
    expect(realtimeFirstPartyBase(" .Example.COM ")).toBe("example.com");
    expect(realtimeFirstPartyBase("team.mycorp.co.uk")).toBe(
      "team.mycorp.co.uk"
    );
  });

  it("refuses a Synap Cloud pod's host: the sites its tenant runs are not the pod", () => {
    expect(realtimeFirstPartyBase("alice.pod.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("Alice.Pod.Synap.Live.")).toBeNull();
    expect(realtimeFirstPartyBase("alice.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("alice.pod.staging.synap.live")).toBeNull();
  });

  it("refuses a tenant zone: other tenants' pods are not first-party", () => {
    expect(realtimeFirstPartyBase("synap.live")).toBeNull();
    expect(realtimeFirstPartyBase(".synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("staging.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("pod.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase(".POD.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("pod.staging.synap.live")).toBeNull();
    expect(realtimeFirstPartyBase("synap.live.")).toBeNull();
    expect(realtimeFirstPartyBase("SYNAP.LIVE")).toBeNull();
    expect(realtimeFirstPartyBase("pod.synap.live.")).toBeNull();
    expect(realtimeFirstPartyBase("10.0.0.5")).toBeNull();
    expect(realtimeFirstPartyBase("a..synap.live")).toBeNull();
  });

  it("refuses a bare TLD and nothing", () => {
    expect(realtimeFirstPartyBase("io")).toBeNull();
    expect(realtimeFirstPartyBase("")).toBeNull();
    expect(realtimeFirstPartyBase(undefined)).toBeNull();
  });
});
