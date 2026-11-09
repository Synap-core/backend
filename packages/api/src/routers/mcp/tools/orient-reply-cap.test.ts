/**
 * `synap_orient`'s `yourTools` block never breaks the reply cap's envelope,
 * and the narrow read (`only`) gets nothing added.
 *
 * Why: orient's reply is capped in the adapter (`reply-cap.ts`) and THEN
 * `withYourTools` added its block, so a cut briefing reached the caller as
 * `{yourTools, truncated, head}`: 16,470 characters (over the 16,000 cap) and
 * no longer the envelope a client recognises (the founder's Mac worker,
 * 2026-11-09). Driven through the real `tools.execute` dispatch; only the
 * adapter's answer and the key's tool list are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ reply: "" }));

vi.mock("../adapter.js", () => ({
  executeMCPToolViaHubProtocol: async () => ({
    content: [{ type: "text", text: h.reply }],
  }),
}));
vi.mock("../../../services/capability-briefs/resolve-skill-door.js", () => ({
  resolveSkillDoor: async () => "pod-mcp",
}));
vi.mock("../tool-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tool-access.js")>()),
  loadKeyToolAccess: async () => ({ profile: "full" }),
}));

import { tools } from "./index.js";
import { capReply } from "../reply-cap.js";

const orient = async (args: Record<string, unknown>) => {
  const res = await tools.execute(
    "synap_orient",
    args,
    "u1",
    ["mcp.read"],
    undefined,
    "agent-1",
    null,
    null,
    { keyId: "key-1" }
  );
  return (res.content?.[0] as { text: string }).text;
};

beforeEach(() => {
  h.reply = "";
});

describe("orient's yourTools and the reply cap", () => {
  it("a briefing the cap cut stays the envelope, within the cap", async () => {
    const capped = capReply("synap_orient", {
      content: [
        {
          type: "text",
          text: JSON.stringify({ startHere: { big: "x".repeat(40_000) } }),
        },
      ],
    });
    h.reply = (capped.content[0] as { text: string }).text;
    const text = await orient({});
    expect(text).toBe(h.reply);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(Object.keys(JSON.parse(text))).toEqual(["truncated", "head"]);
  });

  it("a briefing within the cap still gets yourTools after startHere", async () => {
    h.reply = JSON.stringify({ startHere: { a: 1 }, me: { userId: "u1" } });
    const keys = Object.keys(JSON.parse(await orient({})));
    expect(keys.slice(0, 2)).toEqual(["startHere", "yourTools"]);
  });

  it("the narrow read is answered as the handler wrote it", async () => {
    h.reply = JSON.stringify({ handedToYou: { count: 0, items: [] } });
    expect(await orient({ only: "handedToYou" })).toBe(h.reply);
  });
});
