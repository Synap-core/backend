/**
 * D2 tripwire: parallel dispatch_agent must not always run as meta.
 * triggerAutoRespond accepts agentType; threads postMessage passes
 * metadata.agentType into the A2AI job payload.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const autoRespond = readFileSync(
  new URL("./trigger-auto-respond.ts", import.meta.url),
  "utf8"
);
const threads = readFileSync(
  new URL("../routers/hub-protocol/rest/threads.ts", import.meta.url),
  "utf8"
);

describe("D2 agentType plumbing for async dispatch", () => {
  it("triggerAutoRespond accepts agentType and does not hardcode only meta", () => {
    expect(autoRespond).toContain("agentType?: string | null");
    expect(autoRespond).toMatch(/agentType:\s*\n?\s*typeof params\.agentType/);
    // default remains meta when omitted
    expect(autoRespond).toContain(': "meta"');
    // must not be the sole assignment agentType: "meta" without params
    expect(autoRespond).not.toMatch(
      /agentType:\s*"meta",\s*\n\s*sourceAgentUserId/
    );
  });

  it("postMessage autoRespond forwards metadata.agentType", () => {
    expect(threads).toContain("dispatchAgentType");
    expect(threads).toContain("meta?.agentType");
    expect(threads).toContain("agentType: dispatchAgentType");
  });
});
