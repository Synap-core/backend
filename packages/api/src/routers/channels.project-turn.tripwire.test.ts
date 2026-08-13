import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// sendMessage lives in ./channels/send-message.ts, which calls the project-lens
// access predicate `projectTurnAccessWhere` defined in ./channels/helpers.ts
// (both extracted from channels.ts — see channels.ts's module-layout comment).
// Concatenate both so this source-scan still sees the whole authorization gate.
const source =
  readFileSync(new URL("./channels/send-message.ts", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("./channels/helpers.ts", import.meta.url), "utf8");

describe("channels.sendMessage project lens governance", () => {
  it("authorizes the canonical project lens before invoking the IS", () => {
    const authorization = source.indexOf("const authorizedProject");
    const intelligenceRequest = source.indexOf(
      "resolvedService.client.sendMessageStream(streamRequest)"
    );

    expect(authorization).toBeGreaterThan(-1);
    expect(intelligenceRequest).toBeGreaterThan(authorization);
    expect(source).toContain(
      "ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)"
    );
    expect(source).toContain("projectMembers.projectId");
    expect(source).toMatch(
      /const intelligenceRequest = \{[\s\S]*projectId,[\s\S]*workspaceId,/
    );
    expect(source).toContain(
      "resolvedService.client.sendMessage(intelligenceRequest)"
    );
  });
});
