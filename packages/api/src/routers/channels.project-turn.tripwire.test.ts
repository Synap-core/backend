import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./channels.ts", import.meta.url), "utf8");

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
