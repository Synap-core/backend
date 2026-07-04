import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { computeMessageHash } from "./message-hash.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("computeMessageHash", () => {
  it("is sha256(id + content + previousHash)", () => {
    expect(computeMessageHash("id1", "hello", "prev")).toBe(
      sha("id1helloprev")
    );
  });

  it("defaults previousHash to '' (standalone / first post)", () => {
    // The proactive-post writers pass no previousHash — must equal the 2-arg form.
    expect(computeMessageHash("id1", "hello")).toBe(sha("id1hello"));
    expect(computeMessageHash("id1", "hello")).toBe(
      computeMessageHash("id1", "hello", "")
    );
  });

  it("chains: an assistant reply hashes over the trigger message's own hash", () => {
    // previousHash for a reply = the trigger message's hash = computeMessageHash(triggerId, triggerContent)
    const triggerHash = computeMessageHash("umsg", "ping");
    const replyHash = computeMessageHash("amsg", "pong", triggerHash);
    expect(replyHash).toBe(sha(`amsgpong${sha("umsgping")}`));
  });

  it("is deterministic + order-sensitive", () => {
    expect(computeMessageHash("a", "b", "c")).toBe(
      computeMessageHash("a", "b", "c")
    );
    expect(computeMessageHash("a", "b", "c")).not.toBe(
      computeMessageHash("b", "a", "c")
    );
  });
});
