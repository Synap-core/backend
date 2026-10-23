import { describe, it, expect } from "vitest";
import { resolveFirstPartyClientName } from "./index.js";

describe("resolveFirstPartyClientName — the Synap apps by OAuth client_id", () => {
  it("names each first-party client", () => {
    expect(resolveFirstPartyClientName("synap-desktop")).toBe("Synap Desktop");
    expect(resolveFirstPartyClientName("synap-relay")).toBe("Synap Relay");
  });

  it("humanizes an unknown id instead of leaking it, and is empty for none", () => {
    expect(resolveFirstPartyClientName("synap-cli")).toBe("Synap cli");
    expect(resolveFirstPartyClientName("")).toBe("");
    expect(resolveFirstPartyClientName(null)).toBe("");
  });
});
